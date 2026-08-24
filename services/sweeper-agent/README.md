# Sweeper agent

The Outcome Engine adapter is disabled by default. Local integration enables it
explicitly and uses the Pub/Sub emulator; no GCP Pub/Sub subscription or
fulfiller registration is required.

Required local endpoints:

- Pub/Sub emulator: `127.0.0.1:8085`
- Outcome Engine: `127.0.0.1:8090`
- Authenticated Chrome CDP fallback: `127.0.0.1:9222`
- Sweeper agent: `127.0.0.1:8020`
- X Sweeper web: `127.0.0.1:3000`

## Official X API reviewed flow

When `X_API_ADAPTER_URL` is set, Outcome Engine's `generate-candidates` and
`review-handles` tasks use the internal Spring Native `x-api-adapter` instead
of Chrome. The adapter returns stable X user IDs and structured evidence; the
agent persists both in the delivery context before the model review starts.

Run the adapter locally on port 8030 with the four OAuth 1.0a user-context
values supplied as environment variables, or point the local agent at the
authenticated staging adapter. Then start the agent with:

```bash
X_API_ADAPTER_URL=http://127.0.0.1:8030 \
PUBSUB_EMULATOR_HOST=127.0.0.1:8085 \
GOOGLE_CLOUD_PROJECT=adlt-local \
SWEEPER_PLATFORM_ENABLED=true \
SWEEPER_SUBSCRIPTION=OUTCOME.DELIVERY.FULLFILLER.NOTIFICATIONS.NEW-TASK-TO-BE-DONE.sweeper-agent \
OUTCOME_ENGINE_URL=http://127.0.0.1:8090 \
SCREENSHOT_DIR=/tmp/x-sweeper-agent-screenshots \
uvicorn service:app --host 127.0.0.1 --port 8020
```

For the local-web/staging-boundary setup, use
`X_API_ADAPTER_URL=https://x-api-adapter.s26.staging.adlt.dev` instead.

With the adapter configured, both Dry run and Auto-unfollow generate and persist
the reviewed recommendations without changing X. Auto-unfollow then accepts one
exact ordered set selected by the user as an immutable `sweep-selection`
delivery; its `save-selection` task performs no relationship action. The later
confirmation names only that selection ID. A deterministic, separate Outcome
Engine delivery applies every approved stable X user ID sequentially through
the official X API and persists every terminal result in the same order. Chrome
is not a fallback for an approved set.

Initialize the emulator after it starts:

```bash
PUBSUB_EMULATOR_HOST=127.0.0.1:8085 \
GOOGLE_CLOUD_PROJECT=adlt-local \
python3 scripts/init_pubsub_emulator.py
```

Run the agent with:

```bash
PUBSUB_EMULATOR_HOST=127.0.0.1:8085 \
GOOGLE_CLOUD_PROJECT=adlt-local \
SWEEPER_PLATFORM_ENABLED=true \
SWEEPER_SUBSCRIPTION=OUTCOME.DELIVERY.FULLFILLER.NOTIFICATIONS.NEW-TASK-TO-BE-DONE.sweeper-agent \
OUTCOME_ENGINE_URL=http://127.0.0.1:8090 \
BROWSER_WS=http://127.0.0.1:9222/json/version \
SCREENSHOT_DIR=/tmp/x-sweeper-agent-screenshots \
uvicorn service:app --host 127.0.0.1 --port 8020
```

Each run is bounded by its configured count from 3 through 500. With the
official API path enabled, candidate handles and structured profile/post
evidence come from X through `x-api-adapter`; the configured model returns the
persisted KEEP/UNFOLLOW decision, stable X user ID, and reason. Neither run mode
calls a relationship action before the separate approved-set confirmation.

With the local web and Outcome Engine running, execute the acceptance journey:

```bash
cd ../x-sweeper-web
npm run test:e2e:swp-4:local -- --browser chrome
```

For the complete SWP-6 two-stage journey and its flow screenshots:

```bash
npm run test:e2e:swp-6:local -- --browser chrome
```

For the real SWP-35 local-stack review and one-set confirmation preview, with no
relationship write:

```bash
cd ../x-sweeper-web
npm run test:e2e:swp-35:review-local -- --browser chrome
```

The full SWP-35 path is destructive and requires at least two exact
operator-approved stable IDs from the generated recommendations. Resume the
proved review with its source UUID and matching reviewed count so this command
does not spend on or select from a different review:

```bash
CYPRESS_EXISTING_SWEEP_ID=e2cd4ad8-224e-471a-b868-53027101b6b1 \
CYPRESS_SWEEP_COUNT=100 \
CYPRESS_AUTHORIZED_APPROVED_X_USER_IDS='id:<approved-stable-id-1>|id:<approved-stable-id-2>' \
npm run test:e2e:swp-35:local -- --browser chrome
```

Replace both placeholders only with accounts the connected X account owner has
approved from that exact visible review. Never reuse IDs from another run or a
confirmation preview.

The web submits `reviewed-auto-unfollow` when it starts this journey. The agent
normalizes that request to the persisted `auto-unfollow` product mode while
keeping the initial delivery review-only; only the later exact-set confirmation
creates an action delivery.
