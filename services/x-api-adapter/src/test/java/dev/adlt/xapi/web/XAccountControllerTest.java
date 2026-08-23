package dev.adlt.xapi.web;

import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.adlt.xapi.account.XAccountService;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class XAccountControllerTest {
    private final XAccountService accounts = mock(XAccountService.class);
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new XAccountController(accounts))
            .setControllerAdvice(new XApiErrorHandler())
            .build();

    @Test
    void followingRejectsAnUnboundedRequestBeforeCallingX() throws Exception {
        mvc.perform(get("/api/v1/account/following").queryParam("limit", "1001"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("INVALID_REQUEST"))
                .andExpect(jsonPath("$.detail").value("limit must be between 1 and 1000"));
    }

    @Test
    void postsRejectsAHandleWhereAStableUserIdIsRequired() throws Exception {
        mvc.perform(get("/api/v1/users/@mutable/posts"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("INVALID_REQUEST"))
                .andExpect(jsonPath("$.detail").value("id must be an X user ID"));
    }
}
