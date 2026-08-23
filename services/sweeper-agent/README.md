# Sweeper agent

The Outcome Engine adapter is disabled by default. Local integration enables it
explicitly and uses the Pub/Sub emulator; no GCP Pub/Sub subscription or
fulfiller registration is required.

Required local endpoints:

- Pub/Sub emulator: `127.0.0.1:8085`
- Outcome Engine: `127.0.0.1:8090`
- Authenticated Chrome CDP: `127.0.0.1:9222`
- Sweeper agent: `127.0.0.1:8020`
- X Sweeper web: `127.0.0.1:3000`

## Official X API read path

When `X_API_ADAPTER_URL` is set, Outcome Engine's `generate-candidates` and
`review-handles` tasks use the internal Spring Native `x-api-adapter` instead
of Chrome. The adapter returns stable X user IDs and structured evidence; the
agent persists both in the delivery context before the model review starts.

Run the adapter locally on port 8030 with the four OAuth 1.0a user-context
values supplied as environment variables, then start the agent with:

```bash
X_API_ADAPTER_URL=http://127.0.0.1:8030 \
PUBSUB_EMULATOR_HOST=127.0.0.1:8085 \
GOOGLE_CLOUD_PROJECT=adlt-local \
SWEEPER_PLATFORM_ENABLED=true \
SWEEPER_SUBSCRIPTION=OUTCOME.DELIVERY.FULLFILLER.NOTIFICATIONS.NEW-TASK-TO-BE-DONE.sweeper-agent \
OUTCOME_ENGINE_URL=http://127.0.0.1:8090 \
uvicorn service:app --host 127.0.0.1 --port 8020
```

M1 moves reads only. Until the target-ID delete slice lands, explicit and
automatic unfollow tasks continue using `BrowserSweepExecutor`.

Initialize the emulator after it starts:

```bash
PUBSUB_EMULATOR_HOST=127.0.0.1:8085 \
GOOGLE_CLOUD_PROJECT=adlt-local \
python scripts/init_pubsub_emulator.py
```

Run the agent with:

```bash
PUBSUB_EMULATOR_HOST=127.0.0.1:8085 \
GOOGLE_CLOUD_PROJECT=adlt-local \
SWEEPER_PLATFORM_ENABLED=true \
SWEEPER_SUBSCRIPTION=OUTCOME.DELIVERY.FULLFILLER.NOTIFICATIONS.NEW-TASK-TO-BE-DONE.sweeper-agent \
OUTCOME_ENGINE_URL=http://127.0.0.1:8090 \
BROWSER_WS=http://127.0.0.1:9222/json/version \
uvicorn service:app --host 127.0.0.1 --port 8020
```

The demo flow is deliberately bounded to three candidates. With the official
API read path enabled, candidate handles and structured profile/post evidence
come from X through `x-api-adapter`; the configured model returns the persisted
KEEP/UNFOLLOW decision and reason. Dry runs never call an unfollow action.

With the local web and Outcome Engine running, execute the acceptance journey:

```bash
cd ../x-sweeper-web
npm run test:e2e:swp-4:local -- --browser chrome
```

For the complete SWP-6 two-stage journey and its flow screenshots:

```bash
npm run test:e2e:swp-6:local -- --browser chrome
```
