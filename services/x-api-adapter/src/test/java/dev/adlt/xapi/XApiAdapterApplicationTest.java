package dev.adlt.xapi;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(properties = {
        "x.api.base-url=http://127.0.0.1:9",
        "management.server.port=0",
        "server.port=0"
})
class XApiAdapterApplicationTest {
    @Test
    void contextLoadsWithoutCallingTheExternalApi() {}
}
