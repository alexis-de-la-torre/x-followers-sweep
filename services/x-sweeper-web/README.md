# services/x-sweeper-web — X Sweeper Runs

Next.js (App Router) page showing the outcome-engine-backed sweep runs of the
x-followers-sweep deployable unit: one timeline row per run with its steps
(generate-candidates, review-handles), timing, and current state; click a row's
status to open the full per-step timeline. The exact reviewed subset is first
persisted as a harmless `sweep-selection` delivery. Only its visible
confirmation creates a separate `sweep-unfollow` delivery. That delivery owns
one sequential Outcome Engine task and one persisted result per approved
account.

- Step catalog mirrors the sweeper-agent's outcome-engine publications.
- Per-run statuses/timestamps come from the outcome-engine API.
- Agent live status from the sweeper-agent's `/health` endpoint.

## Develop

```bash
npm install
NEXT_PUBLIC_OUTCOME_ENGINE_ADDR=http://127.0.0.1:8090 \
NEXT_PUBLIC_SWEEPER_AGENT_ADDR=http://127.0.0.1:8020 \
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

SWP-41 proves the smallest Chrome-free release vertical. It queries the real
`adlt-staging` namespace through the current `kubectl` context, verifies that
Chrome workloads/services and `BROWSER_WS` are absent while the rollback PVC
remains bound, starts one real three-account Dry run, clears browser storage,
and restores the same persisted results. It performs no relationship action.

```bash
gcloud container clusters get-credentials adlt-s26-cluster \
  --zone us-central1-a --project adlt-s26
STAGING_RELEASE=xfs-abcdef0 npm run test:e2e:swp-41
```

Use `CYPRESS_EXISTING_SWEEP_ID=<source UUID>` to repeat only the restoration
proof without spending on another X/model review.

The SWP-33 journey is also opt-in because it spends real X API resources and
model work. Supply the exact deployed release so the emitted acceptance record
is attributable to a staging version.

```bash
STAGING_RELEASE=xfs-abcdef0 npm run test:e2e:swp-33
```

To recheck the terminal UI and storage-cleared recovery without spending on a
second X read, pass the previously recorded source identity:

```bash
npx cypress run \
  --spec cypress/e2e/swp-33-50-account-review-staging.cy.js \
  --config baseUrl=https://x-sweeper-web.s26.staging.adlt.dev \
  --env RUN_SWP_33=true,STAGING_RELEASE=xfs-abcdef0,EXISTING_SWEEP_ID=00000000-0000-4000-8000-000000000000
```

SWP-34 proves the advertised 500-account ceiling through the same real staging
boundary. It is separately opt-in because it performs a paid X read and 25
bounded model-review calls. Allow up to 45 minutes for a fresh run.

```bash
STAGING_RELEASE=xfs-abcdef0 npm run test:e2e:swp-34
```

The terminal UI and storage recovery can be replayed without a second paid run:

```bash
npx cypress run \
  --spec cypress/e2e/swp-34-500-account-review-staging.cy.js \
  --config baseUrl=https://x-sweeper-web.s26.staging.adlt.dev \
  --env RUN_SWP_34=true,STAGING_RELEASE=xfs-abcdef0,EXISTING_SWEEP_ID=00000000-0000-4000-8000-000000000000
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

## Cypress against the local SWP-35 stack

SWP-35 connects the local web and sweeper-agent to a local Outcome Engine and
Pub/Sub emulator, with the staging Cloud SQL database and authenticated X API
adapter. Its safe mode performs a real Auto-unfollow review, exact-account
selection, deselection, and visible-set confirmation preview, but never submits
the X action. The test clears browser storage and proves the saved included and
excluded accounts restore from Outcome Engine. A fresh run spends real X API
and model resources:

```bash
npm run test:e2e:swp-35:review-local -- --browser chrome
```

Two additional relationship-safe checks cover presentation boundaries without
fixtures. The history check reads existing legacy Outcome Engine deliveries and
never starts work. The fresh check starts one three-account review, then stops
before saving a selection:

```bash
npm run test:e2e:swp-35:history-local -- --browser chrome
npm run test:e2e:swp-35:fresh-local -- --browser chrome
npm run test:unit
```

After an explicitly authorized action has completed, the read-only restoration
spec verifies the action-bound selection, sequential X evidence, live
relationships, cleared-browser restoration, and exactly one durable action. It
never submits a sweep, selection, or action write:

```bash
CYPRESS_EXISTING_SWEEP_ID=<review-source-uuid> \
CYPRESS_EXISTING_ACTION_ID=<action-source-uuid> \
npm run test:e2e:swp-35:restore-local -- --browser chrome
```

Pass `CYPRESS_EXISTING_SWEEP_ID=<source UUID>` and the matching
`CYPRESS_SWEEP_COUNT` to replay a persisted real review without another paid
X/model run. The full journey additionally executes the approved set
sequentially and restores every persisted result. It is skipped unless exact
operator-approved stable IDs are supplied; prefix large IDs with `id:` and
separate them with `|`. For the proved 100-account review, run:

```bash
CYPRESS_EXISTING_SWEEP_ID=e2cd4ad8-224e-471a-b868-53027101b6b1 \
CYPRESS_SWEEP_COUNT=100 \
CYPRESS_AUTHORIZED_APPROVED_X_USER_IDS='id:<approved-stable-id-1>|id:<approved-stable-id-2>' \
npm run test:e2e:swp-35:local -- --browser chrome
```

Replace both placeholders only with accounts the connected X account owner has
approved from that exact visible review. Never reuse IDs from another run or a
confirmation preview.

The Auto-unfollow switch sends the explicit `reviewed-auto-unfollow` request
mode. Outcome Engine history continues to display the product mode as
`auto-unfollow`; the request name makes clear that starting a review is not
permission to change an X relationship.

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
