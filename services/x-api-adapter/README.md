# X API adapter

Internal Spring Boot Native adapter for X Sweeper's official X API calls. It
owns OAuth 1.0a request signing and upstream response/error mapping; it does
not own sweep orchestration, Pub/Sub, model decisions, or run persistence.

## Local run

Use Java 25 and provide the four user-context credentials without committing
them:

```bash
X_API_CONSUMER_KEY=... \
X_API_CONSUMER_SECRET=... \
X_API_ACCESS_TOKEN=... \
X_API_ACCESS_TOKEN_SECRET=... \
mvn spring-boot:run
```

HTTP listens on 8030 and actuator on 8031 by default.

## Internal API

- `GET /api/v1/account`
- `GET /api/v1/account/following?limit=3`
- `GET /api/v1/users/{id}/posts?limit=3`

Following responses include the authenticated source account, stable target
IDs, profile metrics, latest-post evidence when X supplies the expansion,
pagination, returned-resource counts, upstream request counts, and rate-limit
metadata. No token material is returned or logged.
