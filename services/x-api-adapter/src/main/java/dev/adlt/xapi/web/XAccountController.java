package dev.adlt.xapi.web;

import dev.adlt.xapi.account.XAccountService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class XAccountController {
    private final XAccountService accounts;

    public XAccountController(XAccountService accounts) {
        this.accounts = accounts;
    }

    @GetMapping("/account")
    public XAccountService.Account account() {
        return accounts.account();
    }

    @GetMapping("/account/following")
    public XAccountService.Following following(
            @RequestParam(defaultValue = "3") int limit,
            @RequestParam(required = false) String cursor) {
        if (limit < 1 || limit > 1000) throw new IllegalArgumentException("limit must be between 1 and 1000");
        return accounts.following(limit, cursor);
    }

    @GetMapping("/users/{id}/posts")
    public XAccountService.Posts posts(
            @PathVariable String id,
            @RequestParam(defaultValue = "3") int limit,
            @RequestParam(required = false) String cursor) {
        if (!id.matches("[0-9]{1,19}")) throw new IllegalArgumentException("id must be an X user ID");
        if (limit < 1 || limit > 100) throw new IllegalArgumentException("limit must be between 1 and 100");
        return accounts.posts(id, limit, cursor);
    }

    @GetMapping("/account/following/{id}")
    public XAccountService.Relationship relationship(@PathVariable String id) {
        requireUserId(id);
        return accounts.relationship(id);
    }

    @DeleteMapping("/account/following/{id}")
    public XAccountService.Unfollow unfollow(@PathVariable String id) {
        requireUserId(id);
        return accounts.unfollow(id);
    }

    private static void requireUserId(String id) {
        if (!id.matches("[0-9]{1,19}")) throw new IllegalArgumentException("id must be an X user ID");
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(IllegalArgumentException.class)
    ResponseEntity<ErrorResponse> badRequest(IllegalArgumentException exception) {
        return ResponseEntity.badRequest().body(new ErrorResponse("INVALID_REQUEST", exception.getMessage(), null, null));
    }

    public record ErrorResponse(String error, String detail, Integer upstreamStatus, String rateLimitResetAt) {}
}
