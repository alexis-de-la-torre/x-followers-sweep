package dev.adlt.xapi.client;

import dev.adlt.xapi.auth.OAuth1Signer;
import dev.adlt.xapi.config.XApiProperties;
import java.net.http.HttpClient;
import java.time.Duration;
import java.time.Instant;
import org.springframework.aot.hint.annotation.RegisterReflectionForBinding;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

import static dev.adlt.xapi.client.XApiDocuments.FollowingEnvelope;
import static dev.adlt.xapi.client.XApiDocuments.PostsEnvelope;
import static dev.adlt.xapi.client.XApiDocuments.RelationshipEnvelope;
import static dev.adlt.xapi.client.XApiDocuments.UserEnvelope;

/** Timeout-bounded, OAuth-signed seam to api.x.com. */
@Component
@RegisterReflectionForBinding({
        UserEnvelope.class,
        FollowingEnvelope.class,
        PostsEnvelope.class,
        RelationshipEnvelope.class
})
public class XApiClient {
    private static final String USER_FIELDS = String.join(",",
            "id", "name", "username", "description", "created_at", "profile_image_url",
            "protected", "verified", "public_metrics", "connection_status");
    private static final String POST_FIELDS = "id,text,created_at,lang,public_metrics";

    private final XApiProperties properties;
    private final RestClient client;

    public XApiClient(XApiProperties properties) {
        this.properties = properties;
        Duration connectTimeout = properties.connectTimeout() == null ? Duration.ofSeconds(3) : properties.connectTimeout();
        Duration readTimeout = properties.readTimeout() == null ? Duration.ofSeconds(15) : properties.readTimeout();
        HttpClient httpClient = HttpClient.newBuilder().connectTimeout(connectTimeout).build();
        JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(httpClient);
        requestFactory.setReadTimeout(readTimeout);
        OAuth1Signer signer = new OAuth1Signer(
                value(properties.consumerKey()), value(properties.consumerSecret()),
                value(properties.accessToken()), value(properties.accessTokenSecret()));
        this.client = RestClient.builder()
                .baseUrl(properties.baseUrl().toString())
                .requestFactory(requestFactory)
                .requestInterceptor((request, body, execution) -> {
                    request.getHeaders().set(HttpHeaders.AUTHORIZATION,
                            signer.authorizationHeader(request.getMethod().name(), request.getURI()));
                    request.getHeaders().set(HttpHeaders.USER_AGENT, "x-sweeper-x-api-adapter/1.0");
                    return execution.execute(request, body);
                })
                .build();
    }

    public Result<UserEnvelope> me() {
        requireConfigured();
        return exchange(() -> client.get()
                .uri(builder -> builder.path("/2/users/me").queryParam("user.fields", USER_FIELDS).build())
                .retrieve().toEntity(UserEnvelope.class));
    }

    public Result<FollowingEnvelope> following(String sourceUserId, int limit, String paginationToken) {
        requireConfigured();
        return exchange(() -> client.get()
                .uri(builder -> {
                    var uri = builder.path("/2/users/{id}/following")
                            .queryParam("max_results", limit)
                            .queryParam("user.fields", USER_FIELDS)
                            .queryParam("expansions", "most_recent_post_id")
                            .queryParam("post.fields", POST_FIELDS);
                    if (paginationToken != null && !paginationToken.isBlank()) {
                        uri.queryParam("pagination_token", paginationToken);
                    }
                    return uri.build(sourceUserId);
                })
                .retrieve().toEntity(FollowingEnvelope.class));
    }

    public Result<PostsEnvelope> posts(String userId, int limit, String paginationToken) {
        requireConfigured();
        return exchange(() -> client.get()
                .uri(builder -> {
                    var uri = builder.path("/2/users/{id}/tweets")
                            .queryParam("max_results", limit)
                            .queryParam("exclude", "retweets,replies")
                            .queryParam("post.fields", POST_FIELDS);
                    if (paginationToken != null && !paginationToken.isBlank()) {
                        uri.queryParam("pagination_token", paginationToken);
                    }
                    return uri.build(userId);
                })
                .retrieve().toEntity(PostsEnvelope.class));
    }

    public Result<UserEnvelope> user(String userId) {
        requireConfigured();
        return exchange(() -> client.get()
                .uri(builder -> builder.path("/2/users/{id}")
                        .queryParam("user.fields", "id,username,connection_status")
                        .build(userId))
                .retrieve().toEntity(UserEnvelope.class));
    }

    public Result<RelationshipEnvelope> unfollow(String sourceUserId, String targetUserId) {
        requireConfigured();
        return exchange(() -> client.delete()
                .uri("/2/users/{sourceUserId}/following/{targetUserId}", sourceUserId, targetUserId)
                .retrieve().toEntity(RelationshipEnvelope.class));
    }

    private void requireConfigured() {
        if (!properties.configured()) {
            throw new XApiException(503, "X_CONFIGURATION_MISSING",
                    "X API user-context credentials are not configured", null);
        }
    }

    private <T> Result<T> exchange(Request<T> request) {
        try {
            ResponseEntity<T> response = request.execute();
            return new Result<>(response.getBody(), RateLimit.from(response.getHeaders()));
        } catch (RestClientResponseException exception) {
            int status = exception.getStatusCode().value();
            String category = switch (status) {
                case 401, 403 -> "X_AUTHORIZATION_REQUIRED";
                case 402 -> "X_CREDITS_REQUIRED";
                case 429 -> "X_RATE_LIMITED";
                default -> "X_UPSTREAM_FAILED";
            };
            throw new XApiException(status, category, category, parseReset(exception.getResponseHeaders()));
        }
    }

    private static Instant parseReset(HttpHeaders headers) {
        if (headers == null) return null;
        try {
            String value = headers.getFirst("x-rate-limit-reset");
            return value == null ? null : Instant.ofEpochSecond(Long.parseLong(value));
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static String value(String value) {
        return value == null ? "" : value;
    }

    @FunctionalInterface
    private interface Request<T> {
        ResponseEntity<T> execute();
    }

    public record Result<T>(T body, RateLimit rateLimit) {}

    public record RateLimit(Long limit, Long remaining, Instant resetAt) {
        static RateLimit from(HttpHeaders headers) {
            return new RateLimit(number(headers, "x-rate-limit-limit"),
                    number(headers, "x-rate-limit-remaining"), parseReset(headers));
        }

        private static Long number(HttpHeaders headers, String name) {
            try {
                String value = headers.getFirst(name);
                return value == null ? null : Long.parseLong(value);
            } catch (RuntimeException ignored) {
                return null;
            }
        }
    }
}
