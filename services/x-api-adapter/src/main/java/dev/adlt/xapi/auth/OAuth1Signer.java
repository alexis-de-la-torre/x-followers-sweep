package dev.adlt.xapi.auth;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** RFC 5849 HMAC-SHA1 request signing for X OAuth 1.0a user context. */
public final class OAuth1Signer {
    private final String consumerKey;
    private final String consumerSecret;
    private final String accessToken;
    private final String accessTokenSecret;
    private final Clock clock;
    private final Supplier<String> nonceSupplier;

    public OAuth1Signer(String consumerKey, String consumerSecret, String accessToken, String accessTokenSecret) {
        this(consumerKey, consumerSecret, accessToken, accessTokenSecret, Clock.systemUTC(),
                () -> java.util.UUID.randomUUID().toString().replace("-", ""));
    }

    OAuth1Signer(String consumerKey, String consumerSecret, String accessToken, String accessTokenSecret,
                 Clock clock, Supplier<String> nonceSupplier) {
        this.consumerKey = consumerKey;
        this.consumerSecret = consumerSecret;
        this.accessToken = accessToken;
        this.accessTokenSecret = accessTokenSecret;
        this.clock = clock;
        this.nonceSupplier = nonceSupplier;
    }

    public String authorizationHeader(String method, URI uri) {
        Map<String, String> oauth = new LinkedHashMap<>();
        oauth.put("oauth_consumer_key", consumerKey);
        oauth.put("oauth_nonce", nonceSupplier.get());
        oauth.put("oauth_signature_method", "HMAC-SHA1");
        oauth.put("oauth_timestamp", Long.toString(clock.instant().getEpochSecond()));
        oauth.put("oauth_token", accessToken);
        oauth.put("oauth_version", "1.0");

        List<Parameter> parameters = new ArrayList<>();
        parseQuery(uri.getRawQuery(), parameters);
        oauth.forEach((key, value) -> parameters.add(new Parameter(percentEncode(key), percentEncode(value))));
        parameters.sort(Comparator.comparing(Parameter::key).thenComparing(Parameter::value));

        StringBuilder normalized = new StringBuilder();
        for (Parameter parameter : parameters) {
            if (!normalized.isEmpty()) normalized.append('&');
            normalized.append(parameter.key()).append('=').append(parameter.value());
        }
        String normalizedUri = uri.getScheme() + "://" + uri.getAuthority() + uri.getPath();
        String signatureBase = method.toUpperCase() + '&' + percentEncode(normalizedUri) + '&'
                + percentEncode(normalized.toString());
        String signingKey = percentEncode(consumerSecret) + '&' + percentEncode(accessTokenSecret);
        oauth.put("oauth_signature", hmacSha1(signatureBase, signingKey));

        List<Map.Entry<String, String>> headerParameters = new ArrayList<>(oauth.entrySet());
        headerParameters.sort(Map.Entry.comparingByKey());
        StringBuilder header = new StringBuilder("OAuth ");
        for (Map.Entry<String, String> entry : headerParameters) {
            if (header.length() > 6) header.append(", ");
            header.append(percentEncode(entry.getKey())).append("=\"")
                    .append(percentEncode(entry.getValue())).append('"');
        }
        return header.toString();
    }

    private static void parseQuery(String rawQuery, List<Parameter> parameters) {
        if (rawQuery == null || rawQuery.isBlank()) return;
        for (String pair : rawQuery.split("&")) {
            int equals = pair.indexOf('=');
            String key = equals >= 0 ? pair.substring(0, equals) : pair;
            String value = equals >= 0 ? pair.substring(equals + 1) : "";
            parameters.add(new Parameter(reencode(key), reencode(value)));
        }
    }

    private static String reencode(String raw) {
        return percentEncode(java.net.URLDecoder.decode(raw, StandardCharsets.UTF_8));
    }

    private static String hmacSha1(String value, String key) {
        try {
            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
            return Base64.getEncoder().encodeToString(mac.doFinal(value.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException exception) {
            throw new IllegalStateException("HmacSHA1 is unavailable", exception);
        }
    }

    static String percentEncode(String value) {
        StringBuilder encoded = new StringBuilder();
        for (byte b : value.getBytes(StandardCharsets.UTF_8)) {
            int c = b & 0xff;
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '.' || c == '_' || c == '~') {
                encoded.append((char) c);
            } else {
                encoded.append('%');
                encoded.append(Character.toUpperCase(Character.forDigit((c >>> 4) & 0xf, 16)));
                encoded.append(Character.toUpperCase(Character.forDigit(c & 0xf, 16)));
            }
        }
        return encoded.toString();
    }

    private record Parameter(String key, String value) {}
}
