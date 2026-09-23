# cdn-deploy

Deploy a pre-built static site to the Decentraland CDN **in a single step**:

1. Put the assets at `s3://<bucket>/<package-name>/<version>/…` (auth via **GitHub OIDC** — no static AWS keys).
2. Patch the Cloudflare KV rollout record the CF Worker reads to pick a version.

It replaces the old three-stage relay (`oddish-action` npm publish → `static-sites-pipeline` GitLab S3 upload → `set-rollout-action` → `webhooks-receiver` → KV). **No npm publish, no npm re-download, no GitLab, no webhooks-receiver hop.**

The **caller builds its own artifact** and hands the action a `dist-path` — build and deploy run in the same job, so there's no artifact round-trip.

## State-aware: it infers what to do from S3

There are no explicit "modes". The action figures out the S3 work from whether the target version is already uploaded, then repoints the KV:

| Situation                                                               | S3                                                          | KV                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------- |
| Target version **already** in S3 (no `force`)                           | **skip**                                                    | repoint the environment(s) |
| Not in S3, `source-version` given                                       | **copy** that version → the target                          | repoint                    |
| Not in S3, `dist-path` given                                            | **upload** the folder                                       | repoint                    |
| Not in S3, `copy-from-commit: true` and the target ≠ the commit version | **copy** the commit's build → the target (the release flow) | repoint                    |
| Not in S3, none of the above                                            | **error** — the run fails before anything is written        | untouched                  |
| `force: true`                                                           | redo the upload/copy (same precedence)                      | repoint                    |
| `deployment-environments: '[]'`                                         | upload/copy/skip as above                                   | **nothing** — stage only   |

The precedence is the order of the first five rows (`force` and `deployment-environments` are modifiers, not steps): an already-populated target wins (unless `force`), then an explicit `source-version` (the caller named the bytes), then a `dist-path` (a folder the caller built beats the implicit commit source), then the opt-in commit copy.

**Filling an absent target is opt-in.** "Repoint at version X" and "release-copy into version X" are the same input shape (`version` set, no folder), so a `version` that is merely absent — a typo, an expired prefix — is an error rather than being silently filled with whatever the current commit built and then served. Set `copy-from-commit: true` when you mean the release flow.

**"Already deployed?" is a prefix listing**, not a `HEAD` on `<package-name>/<version>/index.html`: an asset bundle deployed with `require-index: false` has no `index.html`, so a HEAD probe could never see it — it would re-upload on every run and make every by-version repoint look like an empty target. A `listObjectsV2` capped at one key also answers honestly where S3 returns 403 instead of 404. Re-running the same commit is therefore idempotent (skips S3, just re-sets KV).

That probe runs on **every** flow, including a repoint that uploads nothing — the point of it is that the KV must never be pointed at a prefix that isn't there. This is why the AWS role is always required.

### Versioning

The version is **commit-deterministic**: `<base-version>-commit-<shortSha>` (no run id). So a later run on the same commit reconstructs the same S3 path — which is how a release **copies the build the last `master` commit already uploaded to dev**, with no rebuild.

The package name and base version are read from the **repo-root `package.json`** (not the upload folder — a built `./dist` may not contain one), so every flow (deploy, release-copy, manual) computes the same version for a given commit. The caller must check the repo out in the deploy job, or pass `package-name` / `base-version` explicitly. A missing base version is a **hard error**; it is not silently treated as `0.0.0`.

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

| Concern                             | Auth                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **AWS S3**                          | GitHub **OIDC** assume-role via `aws-actions/configure-aws-credentials` (SHA-pinned) — no static keys   |
| **GitHub** deployment/commit status | built-in ephemeral `GITHUB_TOKEN`                                                                       |
| **Cloudflare KV**                   | scoped **API token** — Cloudflare has no GitHub-OIDC federation, so this is the single remaining secret |

The assumed role needs `s3:ListBucket` on the bucket (the "is this version already deployed?" probe, and the listing the copy path walks) plus `s3:GetObject`, `s3:PutObject`, `s3:PutObjectAcl` and `s3:AbortMultipartUpload` on the package prefix (`<package-name>/*`) — objects are written `public-read`, S3 requires `PutObjectAcl` for any request that carries an ACL, and uploads over 5 MB go multipart. `id-token: write` on the calling job is what lets the action exchange the OIDC token for that role.

## Inputs

| Input                                                                                   | Required          | Default                                                 | Description                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dist-path`                                                                             | for an upload     | —                                                       | Pre-built dir to upload (e.g. `./dist`). The caller builds it. Must be a directory inside the workspace, not the repo root, and must not contain a `.git` — the bucket is public. Omit for a release copy / repoint. |
| `source-version`                                                                        |                   | —                                                       | Explicit version in S3 to copy **from**. Outranks `dist-path`. Rejected when it equals the target version.                                                                                                           |
| `copy-from-commit`                                                                      |                   | `false`                                                 | Opt in to the release copy: fill an absent target `version` from the current commit's already-uploaded build. Off by default, so an absent `version` fails instead of being filled silently.                         |
| `commit`                                                                                |                   | workflow commit                                         | Commit sha to compute the version from (manual deploy by commit). Must be a **hex sha** (7-40 hex characters) — a branch or tag name is rejected. Check the repo out at it so the base version matches.              |
| `package-name`                                                                          |                   | `name` from repo-root `package.json`                    | CDN prefix / S3 key root / KV `prefix`. Validated as an npm package name (no path separators or traversal).                                                                                                          |
| `base-version`                                                                          |                   | `version` from repo-root `package.json`                 | Base the deployed version is built from. **A missing base version is an error**, not `0.0.0`; set this when the repo isn't checked out.                                                                              |
| `deployment-path`                                                                       |                   | derived from `package-name` (strip `@scope/` + `-site`) | Path KV key (e.g. `auth`). XOR `domain`.                                                                                                                                                                             |
| `domain`                                                                                |                   | —                                                       | Domain KV key (e.g. `play.decentraland.org`). XOR `deployment-path`.                                                                                                                                                 |
| `deployment-environments`                                                               |                   | `zone,today`                                            | Envs to repoint (JSON array or comma list). `'[]'` = stage (S3 only); empty/unset = the default. Duplicates are rejected.                                                                                            |
| `deployment-environment`                                                                |                   | —                                                       | Single-env shorthand (e.g. `org`). Setting it **and** `deployment-environments` is an error.                                                                                                                         |
| `version`                                                                               |                   | commit version                                          | Target version (e.g. a release tag). Alone (no `dist-path` / `source-version` / `copy-from-commit`) → repoint an already-deployed version; a target absent from S3 is an error.                                      |
| `force`                                                                                 |                   | `false`                                                 | Re-upload/copy even when the target is already in S3. Any case; an empty value falls back to the default.                                                                                                            |
| `percentage`                                                                            |                   | `100`                                                   | Rollout percentage (integer 0–100).                                                                                                                                                                                  |
| `deployment-name`                                                                       |                   | `_site`                                                 | Rollout name (key into `records`).                                                                                                                                                                                   |
| `require-index`                                                                         |                   | `true`                                                  | Fail a deploy if `dist-path` has no `index.html` at its root. Set `false` for non-HTML asset bundles. Any case; an empty value falls back to the default.                                                            |
| `aws-region`                                                                            |                   | `us-east-1`                                             | STS / S3 region.                                                                                                                                                                                                     |
| `aws-role-to-assume`                                                                    | ✅                | —                                                       | IAM role ARN (OIDC). Reference `vars.CDN_DEPLOY_ROLE_ARN`. Required on **every** flow — each one reads S3 to check whether the target version is already deployed.                                                   |
| `s3-bucket`                                                                             |                   | `cdn-decentraland-org-contentbucket-371d0b7`            | CDN bucket. Must have ACLs enabled (Object Ownership other than `BucketOwnerEnforced`) — objects are written `public-read`.                                                                                          |
| `cloudflare-account-id`                                                                 | unless stage-only | —                                                       | CF account id. Reference `vars.CF_ACCOUNT_ID`. Not needed when `deployment-environments: '[]'`.                                                                                                                      |
| `cloudflare-api-token`                                                                  | unless stage-only | —                                                       | Scoped Workers-KV-Edit token. Reference `secrets.CF_KV_API_TOKEN`. Not needed when `deployment-environments: '[]'`.                                                                                                  |
| `cloudflare-namespace-zone` / `cloudflare-namespace-today` / `cloudflare-namespace-org` |                   | —                                                       | Per-env namespace ids. Reference the org secrets `CF_NS_ZONE` / `CF_NS_TODAY` / `CF_NS_ORG` — only the env(s) you target need one.                                                                                   |
| `cloudflare-namespace-id`                                                               |                   | —                                                       | Single namespace id; overrides the per-env mapping. Rejected for a multi-environment run, which would write every env to the same namespace.                                                                         |
| `slack-webhook`                                                                         |                   | —                                                       | Incoming webhook URL. Skipped if unset.                                                                                                                                                                              |
| `create-github-deployment`                                                              |                   | `true`                                                  | GitHub deployment + `cdn-rollout/upload` commit status. Needs `permissions: { deployments: write, statuses: write }`. Any case; an empty value falls back to the default.                                            |
| `cdn-base-url`                                                                          |                   | `https://cdn.decentraland.org`                          | For the `cdn-url` output.                                                                                                                                                                                            |

### Outputs

| Output    | Value                                                                                                                                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version` | The deployed version (`<base-version>-commit-<shortSha>`, or the `version` input).                                                                                                                                                                                              |
| `s3-path` | `<package-name>/<version>`.                                                                                                                                                                                                                                                     |
| `cdn-url` | `<cdn-base-url>/<package-name>/<version>`.                                                                                                                                                                                                                                      |
| `mode`    | What the S3 step actually did: `upload` \| `copy` \| `skip`. Written once that step has succeeded and before the KV patch, so an `if: always()` step reading it after a later failure learns whether the bytes really landed. Unset if the run failed at or before the S3 step. |

## The three flows (matching the current pipeline)

Each is a job that checks out, then calls the action — see `decentraland/sites` for a complete inert example.

- **push → master**: build, then deploy `["zone","today"]`. One upload; both envs get a KV repoint.
- **release published**: stage the build under the release tag — `version: ${{ github.event.release.tag_name }}`, `copy-from-commit: true`, `deployment-environments: '[]'`, no build step. The action copies the commit's already-uploaded build to the tag prefix; **no KV change**. Without `copy-from-commit: true` the run fails instead of filling the tag from whatever this commit built. (Checkout is still needed for the base version.)
- **workflow_dispatch (manual deploy)**: pick an `environment` and the build to deploy by `version` **or** `commit` — e.g. promote what's on dev to stg. With `commit`, check the repo out at that commit (`actions/checkout` with `ref`) so the base version matches. Nothing is uploaded, but the run still assumes the AWS role: it lists the target prefix and refuses to repoint the KV at a version that isn't in S3.

## Runtime contract preserved

The CF Worker serves `https://cdn.decentraland.org/<prefix>/<version>/…` and selects the version from a KV value `{ records: { <rolloutName>: RolloutRecord[] } }`. S3 key stays `<package-name>/<version>/…`, `prefix === packageName`, and the KV value is merged with [`patchRollouts`](https://www.npmjs.com/package/@well-known-components/rollouts-lib) (the same function `webhooks-receiver` used).

## Notes & caveats

- **One deploy at a time per repo.** Set a workflow `concurrency` group (see Quick start) — the KV update is read-modify-write and Cloudflare KV has no compare-and-swap.
- **Ordering.** The S3 step always runs before the KV patch, so KV never points at bytes not yet in S3. A failed run is safe to re-run (idempotent) — and a re-run after a partially-completed upload can be forced past the "already there" check with `force: true`.
- **Transient failures are retried.** Cloudflare KV and Slack calls retry on a 429, any 5xx and network errors (3 attempts, exponential backoff), so a blip after the bytes land doesn't leave the deploy uploaded-but-not-repointed. S3 is retried by the aws-sdk itself.
- **Multi-env is not atomic.** Repointing several environments writes each KV namespace in turn; on a mid-way failure the action throws an aggregate naming which envs were already updated vs failed (no rollback — KV has none).
- **Conflicting inputs are errors, not silent winners.** `deployment-environments` together with `deployment-environment`; `version` equal to `source-version`; `dist-path` together with `source-version` (the built folder would be silently discarded); `deployment-path` together with `domain`; a duplicated environment; a `commit` that isn't a hex sha; a `dist-path` that is the repo root or resolves outside the workspace.
- **A shared KV namespace is collapsed, not rejected.** If several environments resolve to the same namespace id (for example a single `cloudflare-namespace-id`), the record is written once — writing it twice would be idempotent but pointless. The rollout still reports every environment.
- **Package names must be lower-case** and at most 214 characters. S3 keys are case-sensitive, so an upper-case name would deploy to a prefix the worker never serves.
- **Slack goes wherever the webhook points.** An incoming webhook posts to the channel it was installed on and ignores a `channel` field, so the message lands in `rollouts` only if the webhook was created there. Slack is observability: a failed notification warns, it never fails the deploy.
- **Copy reproduces the whole prefix.** `@dcl/cdn-uploader` writes each file as separate objects (`file`, `file.gzip`, `file.br`) with `public-read`; a copy replicates every object under the prefix with `MetadataDirective: COPY` + `ACL: public-read`.
- **`aws-sdk` v2.** `@dcl/cdn-uploader` takes a v2 `S3` client, constructed with **no** explicit creds so the OIDC session-token env vars are used. (v2 is in maintenance — a v3 shim is a future cleanup.)
- **Pin your refs.** Third-party actions are pinned to commit SHAs. Pin this action to `@cdn-deploy-v1` — the floating major tag the release workflow moves on each stable `cdn-deploy-vX.Y.Z` tag (prereleases are skipped) — as the examples above do.

## Development

Node 24 (`.nvmrc`).

```bash
npm ci                 # a lockfile is committed
npm run typecheck      # tsc --noEmit
npm run format         # prettier --write . (CI runs format:check)
npm test               # jest unit tests
npm run test:coverage  # the same run with coverage, as CI does it
npm run build          # bundle src -> dist/index.js with @vercel/ncc (commit the result)
npm run all            # typecheck + format:check + test + build — run before pushing
```

`dist/index.js` is committed because GitHub runs the action from it. **Always re-run `npm run build` and commit `dist/` when you change `src/`.**

`.github/workflows/cdn-deploy-ci.yml` type-checks, format-checks, tests, rebuilds the bundle and **fails the PR when `dist/` is stale** — otherwise a change to `src/` could merge green and leave the action running the old code. The release workflow repeats the check before moving the `cdn-deploy-v1` tag.
