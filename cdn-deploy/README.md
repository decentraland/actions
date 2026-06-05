# cdn-deploy

Deploy a pre-built static site to the Decentraland CDN **in a single step**:

1. Upload the built folder straight to S3 (auth via **GitHub OIDC** — no static AWS keys).
2. Patch the Cloudflare KV rollout record the CF Worker reads to pick a version.

It replaces the old three-stage relay (`oddish-action` npm publish → `static-sites-pipeline` GitLab S3 upload → `set-rollout-action` → `webhooks-receiver` → KV). **No npm publish, no npm re-download, no GitLab, no webhooks-receiver hop.**

```yaml
- uses: decentraland/actions/cdn-deploy@main
  with:
    folder: ./dist
    deployment-path: auth
    deployment-environment: zone
    aws-role-to-assume: ${{ vars.CDN_DEPLOY_ROLE_ARN }}
    cloudflare-account-id: ${{ vars.CF_ACCOUNT_ID }}
    cloudflare-api-token: ${{ secrets.CF_KV_API_TOKEN }}
    cloudflare-namespace-zone: ${{ vars.CF_NS_ZONE }}
```

## What it preserves (runtime contract)

The CF Worker serves assets from `https://cdn.decentraland.org/<prefix>/<version>/...` and selects the version from a KV value shaped `{ records: { <rolloutName>: RolloutRecord[] } }`. This action keeps that contract intact:

- S3 key prefix stays `<package-name>/<version>/...` and the KV record's `prefix` **is** the package name.
- The KV value is merged with [`patchRollouts`](https://www.npmjs.com/package/@well-known-components/rollouts-lib) (the exact same function `webhooks-receiver` used) — order and percentage bucketing are unchanged.
- KV key = `deployment-path` (or `domain`); `deployment-environment` selects the namespace.

## OIDC

| Concern | Auth |
|---|---|
| **AWS S3** | GitHub **OIDC** assume-role via `aws-actions/configure-aws-credentials@v4` — no static keys |
| **GitHub** deployment/commit status | built-in ephemeral `GITHUB_TOKEN` |
| **Cloudflare KV** | scoped **API token** — Cloudflare has no GitHub-OIDC federation, so this is the single remaining secret |

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `folder` | ✅ | — | Pre-built site directory to upload (e.g. `./dist`). |
| `package-name` | | `name` from `<folder>/package.json` | CDN prefix / S3 key root / KV record `prefix`. |
| `deployment-path` | one-of | — | Path-based KV key (e.g. `auth`). XOR `domain`. |
| `domain` | one-of | — | Domain-based KV key (e.g. `play.decentraland.org`). XOR `deployment-path`. |
| `deployment-environment` | ✅ | — | `zone` (dev) \| `today` (stg) \| `org` (prod). Selects the namespace. |
| `deployment-name` | | `_site` | Rollout name (key into `records`). |
| `percentage` | | `100` | Rollout percentage (0–100). |
| `version` | | computed | **Rollback / re-point:** when set, the S3 upload is **skipped** and only the KV record is patched. |
| `aws-region` | | `us-east-1` | STS / S3 region. |
| `aws-role-to-assume` | ✅ | — | IAM role ARN assumed via OIDC. |
| `s3-bucket` | | `cdn-decentraland-org-contentbucket-371d0b7` | Target CDN bucket. |
| `cloudflare-account-id` | ✅ | — | CF account id. |
| `cloudflare-api-token` | ✅ | — | Scoped Workers-KV-Edit token (the one secret). |
| `cloudflare-namespace-id` | | — | Explicit namespace id; overrides the per-env mapping below. |
| `cloudflare-namespace-zone` / `-today` / `-org` | | — | Namespace id per environment (the old `CF_ROLLOUTS__DEV/STG/PRD_NAMESPACE`). |
| `slack-webhook` | | — | Incoming webhook for the `rollouts` channel. Skipped if unset. |
| `create-github-deployment` | | `true` | Create a GitHub deployment + commit status (`cdn-rollout/upload`). |
| `cdn-base-url` | | `https://cdn.decentraland.org` | Used to compute the `cdn-url` output. |

## Outputs

| Output | Value |
|---|---|
| `version` | The deployed version (`<base>-<runId>.commit-<shortSha>`, or the `version` input). |
| `s3-path` | `<package-name>/<version>`. |
| `cdn-url` | `<cdn-base-url>/<package-name>/<version>`. |

## Full workflow (replaces `build-release` + `set-rollout`)

```yaml
name: build-and-deploy
on:
  push: { branches: [main] }        # -> zone (dev)
  release: { types: [published] }   # -> org (prod)

concurrency:                        # serialize same-target deploys (KV has no CAS)
  group: deploy-${{ github.ref }}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write       # OIDC for AWS assume-role (load-bearing)
      deployments: write    # GitHub deployment + deployment_status
      contents: read        # checkout
      statuses: write       # commit status (cdn-rollout/upload)
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci && npm run build
      - uses: decentraland/actions/cdn-deploy@main
        with:
          folder: ./dist
          deployment-path: auth
          deployment-environment: ${{ github.event_name == 'release' && 'org' || 'zone' }}
          percentage: 100
          aws-role-to-assume: ${{ vars.CDN_DEPLOY_ROLE_ARN }}
          cloudflare-account-id: ${{ vars.CF_ACCOUNT_ID }}
          cloudflare-api-token: ${{ secrets.CF_KV_API_TOKEN }}
          cloudflare-namespace-zone: ${{ vars.CF_NS_ZONE }}
          cloudflare-namespace-org:  ${{ vars.CF_NS_ORG }}
          slack-webhook: ${{ secrets.ROLLOUTS_SLACK_WEBHOOK }}
```

**Multiple environments** in one event (e.g. release → `today` + `org`): use a matrix — each leg writes a different namespace, so there's no KV contention.

```yaml
strategy:
  matrix:
    environment: [today, org]
# ... deployment-environment: ${{ matrix.environment }}
```

## Notes & caveats

- **Concurrency.** The KV update is read-modify-write and Cloudflare KV has no compare-and-swap. Keep the `concurrency:` group above so two deploys to the same path+environment don't clobber each other. Matrix legs are safe (distinct namespaces).
- **Ordering.** Upload always runs before the KV patch, so KV never points at bytes that aren't in S3 yet. A failed run is safe to re-run.
- **`aws-sdk` v2.** `@dcl/cdn-uploader` takes a v2 `S3` client; it's constructed with **no** explicit credentials so the OIDC session-token env vars set by `configure-aws-credentials` are used. (v2 is in maintenance — a v3-backed shim is a future cleanup.)
- **Rollback.** Re-run with an explicit `version:` (an already-uploaded one) to re-point the rollout without re-uploading.

## Development

```bash
npm install
npm test          # jest unit tests
npm run build     # bundle src -> dist/index.js with @vercel/ncc (commit the result)
```

`dist/index.js` is committed because GitHub runs the action from it. **Always re-run `npm run build` and commit `dist/` when you change `src/`.**
