package dev.adlt.xapi.web;

import dev.adlt.xapi.client.XApiException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class XApiErrorHandler {
    @ExceptionHandler(XApiException.class)
    ResponseEntity<XAccountController.ErrorResponse> xApiError(XApiException exception) {
        HttpStatus status = switch (exception.upstreamStatus()) {
            case 401 -> HttpStatus.UNAUTHORIZED;
            case 402 -> HttpStatus.PAYMENT_REQUIRED;
            case 403 -> HttpStatus.FORBIDDEN;
            case 429 -> HttpStatus.TOO_MANY_REQUESTS;
            case 503 -> HttpStatus.SERVICE_UNAVAILABLE;
            default -> HttpStatus.BAD_GATEWAY;
        };
        String reset = exception.rateLimitReset() == null ? null : exception.rateLimitReset().toString();
        return ResponseEntity.status(status).body(new XAccountController.ErrorResponse(
                exception.category(), exception.getMessage(), exception.upstreamStatus(), reset));
    }

    @ExceptionHandler(IllegalStateException.class)
    ResponseEntity<XAccountController.ErrorResponse> invalidResponse(IllegalStateException exception) {
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(new XAccountController.ErrorResponse(
                "X_INVALID_RESPONSE", exception.getMessage(), null, null));
    }
}
