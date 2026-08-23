# services/x-sweeper-web — X Sweeper Runs

Next.js (App Router) page showing the outcome-engine-backed sweep runs of the
x-followers-sweep deployable unit: one timeline row per run with its steps
(generate-candidates, review-handles), timing, and current state; click a row's
status to open the full per-step timeline.

- Step catalog mirrors the sweeper-agent's outcome-engine publications.
- Per-run statuses/timestamps come from the outcome-engine API.
- Agent live status from the sweeper-agent's `/health` endpoint.

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
```

## Cypress against staging

The SWP-4 acceptance spec uses the deployed web, sweeper-agent, and Outcome
Engine. Its intercepts are passive request spies; no staging response is
stubbed. The run creates a real dry-run delivery.

```bash
npm install
npm run test:e2e:swp-4
```

## Cypress against the local SWP-38 stack

The SWP-38 spec is destructive and skipped unless explicitly enabled. It uses
the local web, agent, Outcome Engine, Pub/Sub emulator, and X API adapter while
calling the real X API. Prefix the stable target ID with `id:` so Cypress keeps
all 19 digits as a string.

```bash
npx cypress run \
  --spec cypress/e2e/swp-38-confirmed-x-api-unfollow-local.cy.js \
  --config baseUrl=http://127.0.0.1:3000 \
  --env RUN_SWP_38=true,AUTHORIZED_UNFOLLOW_HANDLE=@reviewed,AUTHORIZED_UNFOLLOW_X_USER_ID=id:1234567890123456789
```

If the X write completed but a later evidence assertion was interrupted, add
`EXISTING_UNFOLLOW_ID=<source UUID>` to resume the post-action checks against
that exact durable delivery without issuing a second relationship mutation.

## Build / run (standalone)

```bash
npm run build
node .next/standalone/server.js   # copy .next/static → .next/standalone/.next/static first
```

## Deploy (staging)

Merging to `main` deploys: the `x-followers-sweep-deploy` Cloud Build trigger builds this
Dockerfile as `…/adlt-s26-repo/x-sweeper-web:$SHORT_SHA` and creates a Cloud Deploy
release (pipeline `adlt-s26-x-followers-sweep-pipeline`) that installs `k8s/x-sweeper-web`
as helm release `x-sweeper-web` into `adlt-staging` (see the repo-root `skaffold.yaml`
and `cloudbuild.yaml`). Routing: `x-sweeper-web.s26.staging.adlt.dev` → Service `x-sweeper-web:8080`
in `adlt-staging`, TLS terminates at the Google LB wildcard.
