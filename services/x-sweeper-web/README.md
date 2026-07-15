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