package dev.adlt.xapi.web;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.adlt.xapi.account.XAccountService;
import java.util.List;
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

    @Test
    void relationshipLookupAndDeleteUseTheSameStableTargetId() throws Exception {
        XAccountService.Account source = new XAccountService.Account(
                "1478416609", "dlt_alx", "Alexis", null, false, null);
        XAccountService.RelationshipTarget target = new XAccountService.RelationshipTarget("42", "reviewed");
        when(accounts.relationship("42")).thenReturn(new XAccountService.Relationship(
                source, target, true, List.of("following"), 1, 2, null));
        when(accounts.unfollow("42")).thenReturn(new XAccountService.Unfollow(
                source, "42", false, 2, null));

        mvc.perform(get("/api/v1/account/following/42"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.target.id").value("42"))
                .andExpect(jsonPath("$.following").value(true));

        mvc.perform(delete("/api/v1/account/following/42"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.targetId").value("42"))
                .andExpect(jsonPath("$.following").value(false));
    }

    @Test
    void relationshipDeleteRejectsAHandleWhereAStableIdIsRequired() throws Exception {
        mvc.perform(delete("/api/v1/account/following/@mutable"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("INVALID_REQUEST"))
                .andExpect(jsonPath("$.detail").value("id must be an X user ID"));
    }
}
