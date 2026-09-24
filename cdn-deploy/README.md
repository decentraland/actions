# cdn-deploy

Deploy a pre-built static site to the Decentraland CDN **in a single step**:

1. Put the assets at `s3://<bucket>/<package-name>/<version>/…`
2. Patch the Cloudflare KV rollout record the CF Worker reads to pick a version.

Neither credential lives here. The action authenticates to the **cdn-deploy broker** with a GitHub OIDC token; the broker verifies it against GitHub's published keys, checks that the calling repository owns the package in [`@decentraland/definitions`](https://github.com/decentraland/definitions), and only then mints S3 credentials scoped to one version prefix or writes the rollout. A site repository needs **no Cloudflare token and no IAM role** — only `permissions: { id-token: write }`.

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

**"Already deployed?" is the completion marker**, `<package-name>/<version>/.deploy-complete.json`, written as the _last_ object of an upload. Not a `HEAD` on `index.html`: an asset bundle deployed with `require-index: false` has none, so a HEAD probe could never see it — it would re-upload on every run and make every by-version repoint look like an empty target. And not "does any object exist under the prefix" either, which answers true as soon as the first file lands: a crashed or cancelled upload would then read as deployed, and a rollout would publish a half-written site. Re-running the same commit is idempotent (skips S3, just re-sets KV).

That probe runs **broker-side**: the completion marker is checked when credentials are minted, and the answer comes back as `targetExists` on the grant. A run that writes bytes therefore learns whether it can skip. A pure repoint asks for no credentials at all, so it never sees `targetExists` — and does not need to, because `/rollout` re-checks the marker itself before touching the record. The KV is never pointed at a prefix that isn't there, and that guarantee lives in the broker rather than here.

### Versioning

The version is **commit-deterministic**: `<base-version>-commit-<shortSha>` (no run id). So a later run on the same commit reconstructs the same S3 path — which is how a release **copies the build the last `master` commit already uploaded to dev**, with no rebuild.

The package name and base version are read from the **repo-root `package.json`** (not the upload folder — a built `./dist` may not contain one), so every flow (deploy, release-copy, manual) computes the same version for a given commit. The caller must check the repo out in the deploy job, or pass `package-name` / `base-version` explicitly. A missing base version is a **hard error**; it is not silently treated as `0.0.0`.

## Quick start

Per-repo setup is one line of `permissions`. The only secret a site repository still passes is the Slack webhook, and that is optional.

What a site does need is an entry in [`decentraland/definitions`](https://github.com/decentraland/definitions) → `src/static-site-rollouts.ts`, naming the repository that owns the package, the domains it may roll out to, and its `deploymentPath`. The broker will not deploy a package it cannot attribute to a repository.

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
          slack-webhook: ${{ secrets.ROLLOUTS_SLACK_WEBHOOK }}
```

`package-name` comes from the checked-out `package.json`; pass it explicitly when the repository's root package name is not the published one. The KV key is **not** an input — it comes from `deploymentPath` in definitions, because which key a package may write decides whose site a deploy replaces.

## Auth

| Concern                             | Auth                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **The broker**                      | GitHub **OIDC** token, minted per call with `core.getIDToken`. Needs `permissions: { id-token: write }`. |
| **AWS S3**                          | Short-lived credentials the broker mints, scoped to one `<package>/<version>/` prefix, valid 15 minutes. |
| **Cloudflare KV**                   | Held by the broker. Never reaches a site repository.                                                     |
| **GitHub** deployment/commit status | built-in ephemeral `GITHUB_TOKEN`                                                                        |

The broker ties the prefix to where the workflow actually is in git, so a repository authorised for a package cannot mint credentials for an arbitrary version of it: a branch build may only write `<base>-commit-<sha7>` of its own commit, and a tag build may only write its own tag.

Credentials last 15 minutes, which is `AssumeRole`'s floor rather than a policy choice. A large site can take longer than that to upload, so the action refreshes rather than failing — every part of a multipart upload is signed separately, so the swap is transparent.

## Completion marker

An upload writes `<package>/<version>/.deploy-complete.json` as its **last** object, and the broker refuses to roll out a prefix that does not have one.

This exists because "does any object exist under the prefix?" answers yes as soon as the first file lands, so a crashed or cancelled upload reads as deployed and a rollout would put a half-written site in front of users. It is a guard against crashes, not against a hostile caller — a caller is already authorised to write that whole prefix.

## Inputs

| Input                      | Required | Default                               | Description                                                                                                                                                                                                                                                                                                         |
| -------------------------- | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dist-path`                |          | —                                     | Path to the pre-built site directory to upload (e.g. ./dist). The caller builds it. Must be a directory inside the workspace. Required for a normal deploy; omit for a release copy (`copy-from-commit`) or a repoint.                                                                                              |
| `source-version`           |          | —                                     | Explicit version in S3 to copy FROM. Outranks `dist-path`: set it only when you mean to copy already-uploaded bytes rather than publish the folder.                                                                                                                                                                 |
| `copy-from-commit`         |          | `false`                               | Release flow: when the target `version` is not yet in S3, fill it by copying the current commit's already-uploaded build. Off by default, so a `version` that is simply absent fails instead of being silently filled with whatever this commit built.                                                              |
| `commit`                   |          | —                                     | Commit sha to compute the version from (manual deploy by commit). Defaults to the workflow commit. Must be a hex sha, not a branch name, and the repo must be checked out at it so the base version is read from package.json.                                                                                      |
| `package-name`             |          | —                                     | CDN prefix / S3 key root / KV record prefix. Defaults to `name` from the repo-root package.json. Validated as an npm package name.                                                                                                                                                                                  |
| `base-version`             |          | —                                     | Base version the deployed version is built from. Defaults to `version` in the repo-root package.json; set it when the repo isn't checked out.                                                                                                                                                                       |
| `deployment-environments`  |          | —                                     | Environments to repoint, as a JSON array or comma list (e.g. '["zone","today"]'). Empty array '[]' stages the bytes in S3 without touching any KV. Defaults to zone + today. Mutually exclusive with `deployment-environment`.                                                                                      |
| `deployment-environment`   |          | —                                     | Single-environment shorthand for `deployment-environments` (e.g. `org`).                                                                                                                                                                                                                                            |
| `force`                    |          | `false`                               | Re-upload / re-copy the bytes even when the target version is already in S3.                                                                                                                                                                                                                                        |
| `deployment-name`          |          | `_site`                               | Rollout name (key into the KV `records` map).                                                                                                                                                                                                                                                                       |
| `percentage`               |          | `100`                                 | Rollout percentage (0-100) for the deployed version.                                                                                                                                                                                                                                                                |
| `require-index`            |          | `true`                                | Fail a deploy when the folder has no index.html at its root (guards against an empty/broken build). Set to 'false' to deploy non-HTML asset bundles.                                                                                                                                                                |
| `version`                  |          | —                                     | Target version. Defaults to the computed commit version. Provide it to deploy under a specific version (e.g. a release tag), or alone to repoint the KV at an already-uploaded version. A target that is absent from S3 is an error unless `dist-path`, `source-version` or `copy-from-commit` says how to fill it. |
| `slack-webhook`            |          | —                                     | Incoming Slack webhook URL. Posts to the channel the webhook was installed on. Skipped if unset.                                                                                                                                                                                                                    |
| `create-github-deployment` |          | `true`                                | Create a GitHub deployment + commit status for observability. Needs `permissions: { deployments: write, statuses: write }`.                                                                                                                                                                                         |
| `broker-url`               |          | `https://cdn-deploy.decentraland.org` | Base URL of the cdn-deploy broker. It holds the Cloudflare token and the right to write the CDN bucket, so this action holds neither.                                                                                                                                                                               |
| `oidc-audience`            |          | `dcl-cdn-deploy`                      | Audience requested on the GitHub OIDC token. Must match what the broker expects; the calling job needs `permissions: { id-token: write }`.                                                                                                                                                                          |
| `cdn-base-url`             |          | `https://cdn.decentraland.org`        | CDN origin used to compute the cdn-url output.                                                                                                                                                                                                                                                                      |

### Outputs

| Output    | Value                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version` | The deployed version (computed snapshot, or the `version` input).                                                                                   |
| `s3-path` | The S3 key prefix that was uploaded: <package-name>/<version>.                                                                                      |
| `cdn-url` | <cdn-base-url>/<package-name>/<version> — where the worker serves the version from.                                                                 |
| `mode`    | What the S3 step did: upload \| copy \| skip. Set before the KV write, so it is readable from an `if: always()` step even when the run later fails. |

## The three flows (matching the current pipeline)

Each is a job that checks out, then calls the action — see `decentraland/sites` for a complete inert example.

- **push → master**: build, then deploy `["zone","today"]`. One upload; both envs get a KV repoint.
- **release published**: stage the build under the release tag — `version: ${{ github.event.release.tag_name }}`, `copy-from-commit: true`, `deployment-environments: '[]'`, no build step. The action copies the commit's already-uploaded build to the tag prefix; **no KV change**. Without `copy-from-commit: true` the run fails instead of filling the tag from whatever this commit built. (Checkout is still needed for the base version.)
- **workflow_dispatch (manual deploy)**: pick an `environment` and the build to deploy by `version` **or** `commit` — e.g. promote what's on dev to stg. With `commit`, check the repo out at that commit (`actions/checkout` with `ref`) so the base version matches. Nothing is uploaded, so the action asks for no credentials at all — the broker checks the version is present and complete before it touches the rollout record.

## Runtime contract preserved

The CF Worker serves `https://cdn.decentraland.org/<prefix>/<version>/…` and selects the version from a KV value `{ records: { <rolloutName>: RolloutRecord[] } }`. S3 key stays `<package-name>/<version>/…`, `prefix === packageName`, and the KV value is merged with `patchRollouts` — by the **broker**, not by this action, which no longer touches KV at all.

## Notes & caveats

- **One deploy at a time per repo.** Set a workflow `concurrency` group (see Quick start) — the KV update is read-modify-write and Cloudflare KV has no compare-and-swap.
- **Ordering.** The S3 step always runs before the rollout, and the broker refuses to publish a prefix without a completion marker, so KV never points at a half-written version. A failed run is safe to re-run (idempotent) — and a re-run after a partially-completed upload can be forced past the "already there" check with `force: true`.
- **Transient failures are retried.** Broker and Slack calls retry on a 429, any 5xx and network errors (3 attempts, exponential backoff), so a blip after the bytes land doesn't leave the deploy uploaded-but-not-repointed. S3 is retried by the aws-sdk itself, and the broker retries Cloudflare on its own side.
- **Multi-env is not atomic.** Repointing several environments writes each KV namespace in turn; on a mid-way failure the action throws an aggregate naming which envs were already updated vs failed (no rollback — KV has none).
- **Conflicting inputs are errors, not silent winners.** `deployment-environments` together with `deployment-environment`; `version` equal to `source-version`; `dist-path` together with `source-version` (the built folder would be silently discarded); a duplicated environment; a `commit` that isn't a hex sha; a `dist-path` that is the repo root or resolves outside the workspace.
- **The KV key is not yours to choose.** It comes from `deploymentPath` in definitions. Which key a package may write decides whose site a deploy replaces, so accepting it as an input would let any authorised repository repoint another team's site.
- **Package names must be lower-case** and at most 214 characters. S3 keys are case-sensitive, so an upper-case name would deploy to a prefix the worker never serves.
- **Slack goes wherever the webhook points.** An incoming webhook posts to the channel it was installed on and ignores a `channel` field, so the message lands in `rollouts` only if the webhook was created there. Slack is observability: a failed notification warns, it never fails the deploy.
- **The release copy runs in the broker.** `CopyObject` keeps the bytes inside S3, so a release needs no AWS credentials in the runner. It is resumable because API Gateway caps a call at 29 seconds and a site is a few thousand objects once the `.gzip`/`.br` variants are counted; the action drives the continuation to completion, and waits rather than failing when the source build is still uploading.
- **`aws-sdk` v2.** `@dcl/cdn-uploader` takes a v2 `S3` client, built with the brokered credentials explicitly rather than letting the default chain find ambient `AWS_*` variables — there is no assume-role step populating those any more, and falling back to whatever the runner happens to have would be a quiet path to a wider credential than the broker granted. (v2 is in maintenance — a v3 shim is a future cleanup.)
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
