package dev.adlt.xapi.config;

import java.net.URI;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("x.api")
public record XApiProperties(
        URI baseUrl,
        String consumerKey,
        String consumerSecret,
        String accessToken,
        String accessTokenSecret,
        Duration connectTimeout,
        Duration readTimeout
) {
    public boolean configured() {
        return present(consumerKey) && present(consumerSecret) && present(accessToken) && present(accessTokenSecret);
    }

    private static boolean present(String value) {
        return value != null && !value.isBlank();
    }
}
