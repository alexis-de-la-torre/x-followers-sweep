package dev.adlt.xapi.account;

import dev.adlt.xapi.client.XApiClient;
import dev.adlt.xapi.client.XApiDocuments;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class XAccountService {
    private final XApiClient client;

    public XAccountService(XApiClient client) {
        this.client = client;
    }

    public Account account() {
        XApiClient.Result<XApiDocuments.UserEnvelope> result = client.me();
        XApiDocuments.XUser user = result.body() == null ? null : result.body().data();
        if (user == null) throw new IllegalStateException("X API returned no authenticated user");
        return account(user);
    }

    public Following following(int limit, String cursor) {
        XApiClient.Result<XApiDocuments.UserEnvelope> identityResult = client.me();
        XApiDocuments.XUser source = identityResult.body() == null ? null : identityResult.body().data();
        if (source == null) throw new IllegalStateException("X API returned no authenticated user");

        XApiClient.Result<XApiDocuments.FollowingEnvelope> followingResult = client.following(source.id(), limit, cursor);
        XApiDocuments.FollowingEnvelope document = followingResult.body();
        List<XApiDocuments.XUser> users = document == null || document.data() == null
                ? Collections.emptyList() : document.data();
        Map<String, XApiDocuments.XPost> posts = postsById(document == null ? null : document.includes());
        List<FollowingAccount> accounts = users.stream()
                .map(user -> new FollowingAccount(
                        user.id(), user.username(), user.name(), user.description(), user.createdAt(),
                        user.profileImageUrl(), user.protectedAccount(), user.verified(), user.publicMetrics(),
                        posts.get(user.mostRecentPostId())))
                .toList();
        String nextCursor = document != null && document.meta() != null ? document.meta().nextToken() : null;
        return new Following(account(source), accounts, nextCursor, accounts.size(), 2,
                followingResult.rateLimit());
    }

    public Posts posts(String userId, int limit, String cursor) {
        XApiClient.Result<XApiDocuments.PostsEnvelope> result = client.posts(userId, limit, cursor);
        XApiDocuments.PostsEnvelope document = result.body();
        List<XApiDocuments.XPost> posts = document == null || document.data() == null
                ? Collections.emptyList() : document.data();
        String nextCursor = document != null && document.meta() != null ? document.meta().nextToken() : null;
        return new Posts(userId, posts, nextCursor, posts.size(), 1, result.rateLimit());
    }

    public Relationship relationship(String targetUserId) {
        XApiClient.Result<XApiDocuments.UserEnvelope> identityResult = client.me();
        XApiDocuments.XUser source = identityResult.body() == null ? null : identityResult.body().data();
        if (source == null) throw new IllegalStateException("X API returned no authenticated user");

        XApiClient.Result<XApiDocuments.UserEnvelope> targetResult = client.user(targetUserId);
        XApiDocuments.XUser target = targetResult.body() == null ? null : targetResult.body().data();
        if (target == null) throw new IllegalStateException("X API returned no relationship target");
        List<String> connectionStatus = target.connectionStatus() == null
                ? Collections.emptyList() : List.copyOf(target.connectionStatus());
        return new Relationship(
                account(source),
                new RelationshipTarget(target.id(), target.username()),
                connectionStatus.contains("following"),
                connectionStatus,
                1,
                2,
                targetResult.rateLimit());
    }

    public Unfollow unfollow(String targetUserId) {
        XApiClient.Result<XApiDocuments.UserEnvelope> identityResult = client.me();
        XApiDocuments.XUser source = identityResult.body() == null ? null : identityResult.body().data();
        if (source == null) throw new IllegalStateException("X API returned no authenticated user");

        XApiClient.Result<XApiDocuments.RelationshipEnvelope> result = client.unfollow(source.id(), targetUserId);
        XApiDocuments.RelationshipData data = result.body() == null ? null : result.body().data();
        if (data == null || data.following() == null) {
            throw new IllegalStateException("X API returned no unfollow relationship state");
        }
        return new Unfollow(account(source), targetUserId, data.following(), 2, result.rateLimit());
    }

    private static Map<String, XApiDocuments.XPost> postsById(XApiDocuments.Includes includes) {
        if (includes == null || includes.posts() == null) return Collections.emptyMap();
        Map<String, XApiDocuments.XPost> posts = new LinkedHashMap<>();
        for (XApiDocuments.XPost post : includes.posts()) {
            if (post != null && post.id() != null) posts.put(post.id(), post);
        }
        return posts;
    }

    private static Account account(XApiDocuments.XUser user) {
        return new Account(user.id(), user.username(), user.name(), user.createdAt(), user.verified(), user.publicMetrics());
    }

    public record Account(
            String id,
            String username,
            String name,
            String createdAt,
            Boolean verified,
            XApiDocuments.PublicMetrics publicMetrics
    ) {}

    public record FollowingAccount(
            String id,
            String username,
            String name,
            String description,
            String createdAt,
            String profileImageUrl,
            Boolean protectedAccount,
            Boolean verified,
            XApiDocuments.PublicMetrics publicMetrics,
            XApiDocuments.XPost latestPost
    ) {}

    public record Following(
            Account source,
            List<FollowingAccount> accounts,
            String nextCursor,
            int returnedResources,
            int upstreamRequests,
            XApiClient.RateLimit rateLimit
    ) {}

    public record RelationshipTarget(String id, String username) {}

    public record Relationship(
            Account source,
            RelationshipTarget target,
            boolean following,
            List<String> connectionStatus,
            int returnedResources,
            int upstreamRequests,
            XApiClient.RateLimit rateLimit
    ) {}

    public record Unfollow(
            Account source,
            String targetId,
            boolean following,
            int upstreamRequests,
            XApiClient.RateLimit rateLimit
    ) {}

    public record Posts(
            String userId,
            List<XApiDocuments.XPost> posts,
            String nextCursor,
            int returnedResources,
            int upstreamRequests,
            XApiClient.RateLimit rateLimit
    ) {}
}
