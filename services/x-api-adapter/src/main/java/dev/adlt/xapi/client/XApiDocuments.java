package dev.adlt.xapi.client;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import java.util.Map;

/** Upstream X API documents. These records deliberately model only fields Sweeper consumes. */
public final class XApiDocuments {
    private XApiDocuments() {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record UserEnvelope(XUser data, List<XError> errors) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record FollowingEnvelope(
            List<XUser> data,
            Includes includes,
            Meta meta,
            List<XError> errors
    ) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record PostsEnvelope(List<XPost> data, Meta meta, List<XError> errors) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record XUser(
            String id,
            String name,
            String username,
            String description,
            @JsonProperty("created_at") String createdAt,
            @JsonProperty("profile_image_url") String profileImageUrl,
            @JsonProperty("protected") Boolean protectedAccount,
            Boolean verified,
            @JsonProperty("public_metrics") PublicMetrics publicMetrics,
            @JsonAlias({"most_recent_post_id", "most_recent_tweet_id"}) String mostRecentPostId,
            @JsonProperty("connection_status") List<String> connectionStatus
    ) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record RelationshipEnvelope(RelationshipData data, List<XError> errors) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record RelationshipData(Boolean following) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record PublicMetrics(
            @JsonProperty("followers_count") Long followersCount,
            @JsonProperty("following_count") Long followingCount,
            @JsonAlias({"post_count", "tweet_count"}) Long postCount,
            @JsonProperty("listed_count") Long listedCount,
            @JsonProperty("like_count") Long likeCount,
            @JsonProperty("media_count") Long mediaCount
    ) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record XPost(
            String id,
            String text,
            @JsonProperty("created_at") String createdAt,
            String lang,
            @JsonProperty("public_metrics") Map<String, Long> publicMetrics
    ) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Includes(@JsonAlias({"posts", "tweets"}) List<XPost> posts) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Meta(
            @JsonAlias({"next_token", "next_cursor"}) String nextToken,
            @JsonProperty("result_count") Integer resultCount
    ) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record XError(String title, String detail, String type, Integer status, String message) {}
}
