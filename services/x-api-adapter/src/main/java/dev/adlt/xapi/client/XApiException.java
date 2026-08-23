package dev.adlt.xapi.client;

import java.time.Instant;

public final class XApiException extends RuntimeException {
    private final int upstreamStatus;
    private final String category;
    private final Instant rateLimitReset;

    public XApiException(int upstreamStatus, String category, String message, Instant rateLimitReset) {
        super(message);
        this.upstreamStatus = upstreamStatus;
        this.category = category;
        this.rateLimitReset = rateLimitReset;
    }

    public int upstreamStatus() {
        return upstreamStatus;
    }

    public String category() {
        return category;
    }

    public Instant rateLimitReset() {
        return rateLimitReset;
    }
}
