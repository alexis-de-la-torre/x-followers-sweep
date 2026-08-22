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

The demo flow is deliberately bounded to three candidates. Candidate handles
come from the live Following page, profile evidence comes from live X pages,
and the configured model returns the persisted KEEP/UNFOLLOW decision and
reason. Dry runs never call an unfollow action.

With the local web and Outcome Engine running, execute the acceptance journey:

```bash
cd ../x-sweeper-web
npm run test:e2e:swp-4:local -- --browser chrome
```

For the complete SWP-6 two-stage journey and its flow screenshots:

```bash
npm run test:e2e:swp-6:local -- --browser chrome
```
