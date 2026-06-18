# cdn-deploy

Deploy a pre-built static site to the Decentraland CDN **in a single step**:

1. Put the assets at `s3://<bucket>/<package-name>/<version>/…` (auth via **GitHub OIDC** — no static AWS keys).
2. Patch the Cloudflare KV rollout record the CF Worker reads to pick a version.

It replaces the old three-stage relay (`oddish-action` npm publish → `static-sites-pipeline` GitLab S3 upload → `set-rollout-action` → `webhooks-receiver` → KV). **No npm publish, no npm re-download, no GitLab, no webhooks-receiver hop.**

The **caller builds its own artifact** and hands the action a `dist-path` — build and deploy run in the same job, so there's no artifact round-trip.

## State-aware: it infers what to do from S3

There are no explicit "modes". The action figures out the S3 work from whether the target version is already uploaded, then repoints the KV:

| Situation | S3 | KV |
|---|---|---|
| Target version **not** in S3, `dist-path` given | **upload** the folder | repoint the environment(s) |
| Target version **not** in S3, it's a release (`version` ≠ commit version) | **copy** the commit's build → the target version | repoint |
| Target version **already** in S3 | **skip** | repoint |
| `force: true` | redo the upload/copy | repoint |
| `deployment-environments: '[]'` | upload/copy as above | **nothing** — stage only |

"Already deployed?" is decided by a `HEAD` on `<package-name>/<version>/index.html`. Re-running the same commit is therefore idempotent (skips S3, just re-sets KV).

### Versioning

The version is **commit-deterministic**: `<package.json version>-commit-<shortSha>` (no run id). So a later run on the same commit reconstructs the same S3 path — which is how a release **copies the build the last `master` commit already uploaded to dev**, with no rebuild.

The package name and base version are read from the **repo-root `package.json`** (not the upload folder — a built `./dist` may not contain one), so every flow (deploy, release-copy, manual) computes the same version for a given commit. The caller must check the repo out in the deploy job.

## Quick start

One-time **org** setup (admin, once — not per repo): secrets `CF_KV_API_TOKEN`, `ROLLOUTS_SLACK_WEBHOOK`, `CF_NS_ZONE`, `CF_NS_TODAY`, `CF_NS_ORG`; variables `CF_ACCOUNT_ID`, `CDN_DEPLOY_ROLE_ARN`. The bucket, region and CDN url are defaulted in the action; the KV namespace ids are org secrets (they live in a private repo, so they're not hardcoded here).

A site builds and deploys in one job:

```yaml
name: build-and-deploy
on:
  push: { branches: [master] }

concurrency: # one deploy at a time per repo — the KV update is read-modify-write
  group: cdn-deploy-${{ github.repository }}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: read, deployments: write, statuses: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm ci && npm run build # the UI builds its own artifact
      - uses: decentraland/actions/cdn-deploy@cdn-deploy-v1
        with:
          dist-path: ./dist
          deployment-environments: '["zone","today"]'
          aws-role-to-assume: ${{ vars.CDN_DEPLOY_ROLE_ARN }}
          cloudflare-account-id: ${{ vars.CF_ACCOUNT_ID }}
          cloudflare-api-token: ${{ secrets.CF_KV_API_TOKEN }}
          cloudflare-namespace-zone: ${{ secrets.CF_NS_ZONE }}
          cloudflare-namespace-today: ${{ secrets.CF_NS_TODAY }}
          slack-webhook: ${{ secrets.ROLLOUTS_SLACK_WEBHOOK }}
```

`package-name` and `deployment-path` are derived from the checked-out `package.json`; pass them to override.

## OIDC

| Concern | Auth |
|---|---|
| **AWS S3** | GitHub **OIDC** assume-role via `aws-actions/configure-aws-credentials` (SHA-pinned) — no static keys |
| **GitHub** deployment/commit status | built-in ephemeral `GITHUB_TOKEN` |
| **Cloudflare KV** | scoped **API token** — Cloudflare has no GitHub-OIDC federation, so this is the single remaining secret |

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `dist-path` | for upload | — | Pre-built dir to upload (e.g. `./dist`). The caller builds it. Omit for a release copy / repoint. |
| `package-name` | | `name` from repo-root `package.json` | CDN prefix / S3 key root / KV `prefix`. |
| `deployment-path` | | derived from `package-name` (strip `@scope/` + `-site`) | Path KV key (e.g. `auth`). XOR `domain`. |
| `domain` | | — | Domain KV key. XOR `deployment-path`. |
| `deployment-environments` | | `zone,today` | Envs to repoint (JSON array or comma list). `'[]'` = stage (S3 only). |
| `deployment-environment` | | — | Single-env shorthand. |
| `version` | | commit version | Target version (e.g. a release tag). Alone (no `dist-path`/source) → repoint. |
| `source-version` | | commit version (for a release) | Explicit version to copy from. |
| `commit` | | workflow commit | Commit sha to compute the version from (manual deploy by commit). Needs the repo checked out at it. |
| `force` | | `false` | Re-upload/copy even when the target is already in S3. |
| `percentage` | | `100` | Rollout percentage (integer 0–100). |
| `deployment-name` | | `_site` | Rollout name (key into `records`). |
| `require-index` | | `true` | Fail an upload if the dir has no `index.html` at its root. |
| `aws-region` | | `us-east-1` | STS / S3 region. |
| `aws-role-to-assume` | for S3 | — | IAM role ARN (OIDC). Reference `vars.CDN_DEPLOY_ROLE_ARN`. |
| `s3-bucket` | | `cdn-decentraland-org-contentbucket-371d0b7` | CDN bucket. |
| `cloudflare-account-id` | ✅ | — | CF account id. Reference `vars.CF_ACCOUNT_ID`. |
| `cloudflare-api-token` | ✅ | — | Scoped Workers-KV-Edit token. Reference `secrets.CF_KV_API_TOKEN`. |
| `cloudflare-namespace-zone` / `-today` / `-org` | ✅ | — | Per-env namespace ids. Reference the org secrets `CF_NS_ZONE` / `CF_NS_TODAY` / `CF_NS_ORG` (only the env(s) you target are needed). |
| `cloudflare-namespace-id` | | — | Single namespace id; overrides the per-env mapping. |
| `slack-webhook` | | — | `rollouts` webhook. Skipped if unset. |
| `create-github-deployment` | | `true` | GitHub deployment + `cdn-rollout/upload` commit status. |
| `cdn-base-url` | | `https://cdn.decentraland.org` | For the `cdn-url` output. |

### Outputs

| Output | Value |
|---|---|
| `version` | The deployed version (`<base>-commit-<shortSha>`, or the `version` input). |
| `s3-path` | `<package-name>/<version>`. |
| `cdn-url` | `<cdn-base-url>/<package-name>/<version>`. |
| `mode` | What the S3 step did: `upload` \| `copy` \| `skip`. |

## The three flows (matching the current pipeline)

Each is a job that checks out, then calls the action — see `decentraland/sites` for a complete inert example.

- **push → master**: build, then deploy `["zone","today"]`. One upload; both envs get a KV repoint.
- **release published**: stage the build under the release tag — `version: ${{ github.event.release.tag_name }}`, `deployment-environments: '[]'`, no build step. The action copies the commit's already-uploaded build to the tag prefix; **no KV change**. (Checkout is still needed for the base version.)
- **workflow_dispatch (manual deploy)**: pick an `environment` and the build to deploy by `version` **or** `commit` — e.g. promote what's on dev to stg. With `commit`, check the repo out at that commit (`actions/checkout` with `ref`) so the base version matches; the build is already on the CDN, so it just repoints that environment's KV.

## Runtime contract preserved

The CF Worker serves `https://cdn.decentraland.org/<prefix>/<version>/…` and selects the version from a KV value `{ records: { <rolloutName>: RolloutRecord[] } }`. S3 key stays `<package-name>/<version>/…`, `prefix === packageName`, and the KV value is merged with [`patchRollouts`](https://www.npmjs.com/package/@well-known-components/rollouts-lib) (the same function `webhooks-receiver` used).

## Notes & caveats

- **One deploy at a time per repo.** Set a workflow `concurrency` group (see Quick start) — the KV update is read-modify-write and Cloudflare KV has no compare-and-swap.
- **Ordering.** The S3 step always runs before the KV patch, so KV never points at bytes not yet in S3. A failed run is safe to re-run (idempotent).
- **Multi-env is not atomic.** Repointing several environments writes each KV namespace in turn; on a mid-way failure the action throws an aggregate naming which envs were already updated vs failed (no rollback — KV has none).
- **Copy reproduces the whole prefix.** `@dcl/cdn-uploader` writes each file as separate objects (`file`, `file.gzip`, `file.br`) with `public-read`; a copy replicates every object under the prefix with `MetadataDirective: COPY` + `ACL: public-read`.
- **`aws-sdk` v2.** `@dcl/cdn-uploader` takes a v2 `S3` client, constructed with **no** explicit creds so the OIDC session-token env vars are used. (v2 is in maintenance — a v3 shim is a future cleanup.)
- **Pin your refs.** Third-party actions are pinned to commit SHAs. Pin this action to `@cdn-deploy-v1` (the floating major tag the release workflow moves on each `cdn-deploy-v*.*.*` tag); examples use `@main` for readability.

## Development

```bash
npm install
npm test          # jest unit tests
npm run build     # bundle src -> dist/index.js with @vercel/ncc (commit the result)
```

`dist/index.js` is committed because GitHub runs the action from it. **Always re-run `npm run build` and commit `dist/` when you change `src/`.**
