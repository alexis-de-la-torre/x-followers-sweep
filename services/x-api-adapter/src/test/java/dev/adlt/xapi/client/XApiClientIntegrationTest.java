package dev.adlt.xapi.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.adlt.xapi.account.XAccountService;
import dev.adlt.xapi.config.XApiProperties;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class XApiClientIntegrationTest {
    private HttpServer server;
    private final AtomicReference<String> meAuthorization = new AtomicReference<>();
    private final AtomicReference<String> followingAuthorization = new AtomicReference<>();
    private final AtomicReference<String> followingQuery = new AtomicReference<>();

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.start();
    }

    @AfterEach
    void stopServer() {
        if (server != null) server.stop(0);
    }

    @Test
    void readsAuthenticatedIdentityAndStructuredFollowingEvidence() {
        server.createContext("/2/users/me", exchange -> {
            meAuthorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
            respond(exchange, 200, """
                    {"data":{"id":"1478416609","username":"dlt_alx","name":"AlexisDLT 🇲🇽",
                    "created_at":"2013-06-02T23:02:16.000Z","verified":false,
                    "public_metrics":{"followers_count":164,"following_count":7430,"tweet_count":7}}}
                    """);
        });
        server.createContext("/2/users/1478416609/following", exchange -> {
            followingAuthorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
            followingQuery.set(exchange.getRequestURI().getRawQuery());
            exchange.getResponseHeaders().add("x-rate-limit-limit", "300");
            exchange.getResponseHeaders().add("x-rate-limit-remaining", "299");
            exchange.getResponseHeaders().add("x-rate-limit-reset", "1787463600");
            respond(exchange, 200, """
                    {"data":[{"id":"42","username":"useful","name":"Useful Account",
                    "description":"Builds useful things","created_at":"2020-01-02T03:04:05.000Z",
                    "profile_image_url":"https://img.example/useful.jpg","protected":true,"verified":false,
                    "public_metrics":{"followers_count":12,"following_count":34,"post_count":56},
                    "most_recent_post_id":"9001"}],
                    "includes":{"posts":[{"id":"9001","text":"A useful update",
                    "created_at":"2026-08-22T12:00:00.000Z","lang":"en","public_metrics":{"like_count":2}}]},
                    "meta":{"result_count":1,"next_token":"NEXT-PAGE-123456"}}
                    """);
        });

        XAccountService service = new XAccountService(client());
        XAccountService.Following following = service.following(3, null);

        assertThat(meAuthorization.get()).startsWith("OAuth ").contains("oauth_signature=");
        assertThat(followingAuthorization.get()).startsWith("OAuth ").contains("oauth_token=");
        assertThat(followingQuery.get())
                .contains("max_results=3")
                .contains("expansions=most_recent_post_id")
                .contains("post.fields=");
        assertThat(following.source().id()).isEqualTo("1478416609");
        assertThat(following.source().publicMetrics().postCount()).isEqualTo(7);
        assertThat(following.returnedResources()).isEqualTo(1);
        assertThat(following.upstreamRequests()).isEqualTo(2);
        assertThat(following.nextCursor()).isEqualTo("NEXT-PAGE-123456");
        assertThat(following.rateLimit().remaining()).isEqualTo(299);
        assertThat(following.rateLimit().resetAt()).isEqualTo(Instant.ofEpochSecond(1787463600));
        XAccountService.FollowingAccount account = following.accounts().getFirst();
        assertThat(account.id()).isEqualTo("42");
        assertThat(account.username()).isEqualTo("useful");
        assertThat(account.protectedAccount()).isTrue();
        assertThat(account.publicMetrics().postCount()).isEqualTo(56);
        assertThat(account.latestPost().id()).isEqualTo("9001");
        assertThat(account.latestPost().text()).isEqualTo("A useful update");
    }

    @Test
    void readsThenDeletesOneRelationshipByStableTargetId() {
        AtomicReference<String> relationshipAuthorization = new AtomicReference<>();
        AtomicReference<String> relationshipQuery = new AtomicReference<>();
        AtomicReference<String> deleteAuthorization = new AtomicReference<>();

        server.createContext("/2/users/me", exchange -> respond(exchange, 200, """
                {"data":{"id":"1478416609","username":"dlt_alx","name":"AlexisDLT"}}
                """));
        server.createContext("/2/users/42", exchange -> {
            relationshipAuthorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
            relationshipQuery.set(exchange.getRequestURI().getRawQuery());
            respond(exchange, 200, """
                    {"data":{"id":"42","username":"reviewed","name":"Reviewed Account",
                    "connection_status":["following","followed_by"]}}
                    """);
        });
        server.createContext("/2/users/1478416609/following/42", exchange -> {
            assertThat(exchange.getRequestMethod()).isEqualTo("DELETE");
            deleteAuthorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
            exchange.getResponseHeaders().add("x-rate-limit-limit", "50");
            exchange.getResponseHeaders().add("x-rate-limit-remaining", "49");
            exchange.getResponseHeaders().add("x-rate-limit-reset", "1787464500");
            respond(exchange, 200, "{\"data\":{\"following\":false}}");
        });

        XAccountService service = new XAccountService(client());
        XAccountService.Relationship before = service.relationship("42");
        XAccountService.Unfollow applied = service.unfollow("42");

        assertThat(relationshipAuthorization.get()).startsWith("OAuth ").contains("oauth_signature=");
        assertThat(relationshipQuery.get()).contains("user.fields=").contains("connection_status");
        assertThat(before.source().id()).isEqualTo("1478416609");
        assertThat(before.target().id()).isEqualTo("42");
        assertThat(before.target().username()).isEqualTo("reviewed");
        assertThat(before.following()).isTrue();
        assertThat(before.connectionStatus()).containsExactly("following", "followed_by");
        assertThat(before.returnedResources()).isEqualTo(1);
        assertThat(before.upstreamRequests()).isEqualTo(2);

        assertThat(deleteAuthorization.get()).startsWith("OAuth ").contains("oauth_token=");
        assertThat(applied.source().id()).isEqualTo("1478416609");
        assertThat(applied.targetId()).isEqualTo("42");
        assertThat(applied.following()).isFalse();
        assertThat(applied.upstreamRequests()).isEqualTo(2);
        assertThat(applied.rateLimit().remaining()).isEqualTo(49);
    }

    @Test
    void mapsCreditExhaustionWithoutLeakingTheUpstreamBody() {
        server.createContext("/2/users/me", exchange -> respond(exchange, 402,
                "{\"detail\":\"upstream body deliberately not propagated\"}"));

        assertThatThrownBy(() -> client().me())
                .isInstanceOfSatisfying(XApiException.class, exception -> {
                    assertThat(exception.category()).isEqualTo("X_CREDITS_REQUIRED");
                    assertThat(exception.upstreamStatus()).isEqualTo(402);
                    assertThat(exception.getMessage()).isEqualTo("X_CREDITS_REQUIRED");
                });
    }

    private XApiClient client() {
        URI baseUrl = URI.create("http://127.0.0.1:" + server.getAddress().getPort());
        return new XApiClient(new XApiProperties(baseUrl, "consumer", "consumer-secret",
                "access-token", "access-secret", Duration.ofSeconds(1), Duration.ofSeconds(2)));
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }
}
