package dev.adlt.xapi.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;

class OAuth1SignerTest {
    @Test
    void signsTheRfc5849RequestExample() {
        OAuth1Signer signer = new OAuth1Signer(
                "dpf43f3p2l4k3l03",
                "kd94hf93k423kf44",
                "nnch734d00sl2jdk",
                "pfkkdhi9sl3r4s00",
                Clock.fixed(Instant.ofEpochSecond(1191242096), ZoneOffset.UTC),
                () -> "kllo9940pd9333jh");

        String header = signer.authorizationHeader("GET",
                URI.create("http://photos.example.net/photos?file=vacation.jpg&size=original"));

        assertThat(header)
                .contains("oauth_consumer_key=\"dpf43f3p2l4k3l03\"")
                .contains("oauth_nonce=\"kllo9940pd9333jh\"")
                .contains("oauth_timestamp=\"1191242096\"")
                .contains("oauth_token=\"nnch734d00sl2jdk\"")
                .contains("oauth_signature=\"tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D\"");
    }

    @Test
    void percentEncodingUsesRfc3986RatherThanFormEncoding() {
        assertThat(OAuth1Signer.percentEncode("a b+c/~")).isEqualTo("a%20b%2Bc%2F~");
    }
}
