# cdn-deploy

Deploy a pre-built static site to the Decentraland CDN **in a single step**:

1. Put the assets at `s3://<bucket>/<package-name>/<version>/…`
2. Patch the Cloudflare KV rollout record the CF Worker reads to pick a version.

Neither credential lives here. The action authenticates to the **cdn-deploy broker** with a GitHub OIDC token; the broker verifies it against GitHub's published keys, checks that the calling repository owns the package in [`@decentraland/definitions`](https://github.com/decentraland/definitions), and only then mints S3 credentials scoped to one version prefix or writes the rollout. A site repository needs **no Cloudflare token and no IAM role**. It needs `permissions: { id-token: write, contents: read, deployments: write, statuses: write }`: `id-token` to mint the OIDC token the broker authenticates, `contents: read` to read the repository's releases — which is what the version is derived from, so without it the version silently falls back to `package.json` — and `deployments`/`statuses` for the GitHub deployment and commit status, which are best-effort and only warn when missing.

It replaces the old three-stage relay (`oddish-action` npm publish → `static-sites-pipeline` GitLab S3 upload → `set-rollout-action` → `webhooks-receiver` → KV). **No npm publish, no npm re-download, no GitLab, no webhooks-receiver hop.**

The action **runs the site's build itself**, via `build-command`, between settling the version and uploading it. Every Decentraland site bakes its CDN base URL into the bundle from the version at build time, so a build that starts before the version is known emits HTML asking for its assets from a prefix nothing was ever uploaded to. Build it yourself instead if you must, and pass `dist-path` and `version`.

## State-aware: it infers what to do from S3

There are no explicit "modes". The action figures out the S3 work from whether the target version is already uploaded, then repoints the KV:

| Situation                        | S3                                                   | KV                         |
| -------------------------------- | ---------------------------------------------------- | -------------------------- |
| Target version **already** in S3 | **skip**                                             | repoint the environment(s) |
| Not in S3, `dist-path` given     | **upload** the folder                                | repoint                    |
| Not in S3, none of the above     | **error** — the run fails before anything is written | untouched                  |
| `deployment-environments: '[]'`  | upload or skip as above                              | **nothing** — stage only   |

The precedence is the order of the rows above (`deployment-environments` is a modifier, not a step): an already-populated target wins, then a `dist-path`.

A run with **no** `dist-path` and no environments is refused outright: it would upload nothing and publish nothing, and reporting that as a success is how an empty prefix goes unnoticed until someone promotes it. A `build-command` with no `dist-path` is refused too, before the build runs, because its output would have nowhere to go.

**An absent target is an error, not something to fill in.** `version` alone, with no folder, means "repoint at what is already there". A `version` that is merely absent — a typo, an expired prefix — therefore fails rather than being quietly populated from whatever this run happens to have built. A release publishes under its tag by **rebuilding** with `build-command` and `version: <tag>`, not by copying: every site bakes its asset base URL from the version, so copied bytes would ask for their assets from the prefix they were built for.

**"Already deployed?" is the completion marker**, `<package-name>/<version>/.deploy-complete.json`, written as the _last_ object of an upload. Not a `HEAD` on `index.html`: an asset bundle has none, so a HEAD probe could never see it — it would re-upload on every run and make every by-version repoint look like an empty target. And not "does any object exist under the prefix" either, which answers true as soon as the first file lands: a crashed or cancelled upload would then read as deployed, and a rollout would publish a half-written site. Re-running the same commit is idempotent (skips S3, just re-sets KV).

That probe runs **broker-side**, and it is a refusal rather than a report: the broker declines to mint credentials for a version whose marker says it is already published, and the action turns that refusal into a skip. A pure repoint asks for no credentials at all — it does not need to, because `/rollout` re-checks the marker itself before touching the record. The KV is never pointed at a prefix that isn't there, and that guarantee lives in the broker rather than here.

### Versioning

The version is `<base>-<runId>.commit-<shortSha>` — for example `0.69.1-36644372302.commit-1509d74`.

`<base>` is the **highest semver among the repository's first 100 non-draft, non-prerelease releases**, patch-incremented when `package.json` sits below it, and otherwise `package.json` as-is — so that file is a floor, not the anchor. Highest rather than most recent: a patch published for an older line after a newer release would otherwise walk the base version backwards, which is why the code lists releases instead of reading `releases/latest`. This mirrors what oddish did with the npm registry, and it matters: `@dcl/sites` had `0.0.1` in package.json while serving `0.69.x`, so a version derived from that file sorted below everything already live and the deploy changed nothing while reporting success.

The run id is not decoration. Every build between two releases shares a base, and semver compares dot-separated prerelease identifiers — so without it two builds order by **sha, alphabetically**, and roughly half of consecutive deploys would sort below the previous one.

The package name is read from the repo-root `package.json` (not the upload folder — a built `./dist` may not contain one), so the caller must check the repo out, or pass `package-name` explicitly.

## Quick start

Per-repo setup is the `permissions` block above. A site repository passes **no secrets at all** — rollouts are announced by the broker, which holds the Slack credential.

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
      - run: npm ci
      - uses: decentraland/actions/cdn-deploy@cdn-deploy-v1
        with:
          build-command: npm run build
          dist-path: ./dist
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

## What the calling job must set up

The action installs nothing and sets up no toolchain: it runs `build-command` as a child
process, so the build uses whatever `actions/setup-node` put on `PATH`. Node version, npm
cache and registry auth stay with the repository, where they belong.

```yaml
- uses: actions/checkout@...
- uses: actions/setup-node@...
  with:
    node-version: 24.x
    cache: npm
- run: npm ci
- uses: decentraland/actions/cdn-deploy@...
  with:
    build-command: npm run build
    dist-path: ./dist
```

That `node` is also what runs the action itself — `node "$GITHUB_ACTION_PATH/dist/index.js"`
resolves from `PATH` — so the job's node version is the action's runtime too. The bundle
needs **Node 22 or newer** and refuses anything older up front, naming the version it found,
rather than failing later inside whichever dependency reaches for a missing API.

Put anything the build needs (`SENTRY_AUTH_TOKEN` and the like) in **job-level** `env:`.
The build is a child process of the action's step, so it inherits the job environment;
job level is what this repository's callers use and what has been verified working.

## Inputs

| Input                     | Required | Default                               | Description                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | -------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build-command`           |          | —                                     | Build the site inside the action, after the version is settled and before it is uploaded. The version is exported as `CDN_DEPLOY_VERSION` and written into `package.json` first, because every site bakes its CDN base URL from the version at build time — a build that runs before the version is known emits HTML pointing at a prefix nothing was uploaded to. Leave empty to build yourself and pass `version`. |
| `dist-path`               |          | —                                     | Directory the deploy uploads (e.g. ./dist) — what `build-command` produces, or what you built yourself. Must be inside the workspace. Required unless the run only repoints an already-uploaded version.                                                                                                                                                                                                             |
| `package-name`            |          | —                                     | CDN prefix / S3 key root / KV record prefix. Defaults to `name` from the repo-root package.json. Validated as an npm package name.                                                                                                                                                                                                                                                                                   |
| `deployment-environments` |          | `zone`                                | Environments to repoint, as a JSON array or comma list (e.g. '["zone"]'). Empty array '[]' stages the bytes in S3 without touching any KV. Defaults to zone only — staging and production are promoted deliberately from a job that declares a GitHub environment.                                                                                                                                                   |
| `percentage`              |          | `100`                                 | Rollout percentage (0-100) for the deployed version.                                                                                                                                                                                                                                                                                                                                                                 |
| `version`                 |          | —                                     | Target version. Defaults to the computed commit version. Provide it to deploy under a specific version (e.g. a release tag), or alone to repoint the KV at an already-uploaded version. A target that is absent from S3 is an error unless `dist-path` says how to fill it.                                                                                                                                          |
| `broker-url`              |          | `https://cdn-deploy.decentraland.org` | Base URL of the cdn-deploy broker. It holds the Cloudflare token and the right to write the CDN bucket, so this action holds neither.                                                                                                                                                                                                                                                                                |

### Outputs

| Output    | Value                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `version` | The deployed version (computed snapshot, or the `version` input).                                                                           |
| `s3-path` | The S3 key prefix that was uploaded: <package-name>/<version>.                                                                              |
| `cdn-url` | https://cdn.decentraland.org/<package-name>/<version> — where the worker serves the version from.                                           |
| `mode`    | What the S3 step did: upload \| skip. Set before the KV write, so it is readable from an `if: always()` step even when the run later fails. |

## The three flows (matching the current pipeline)

Each is a job that checks out, then calls the action — see `decentraland/sites` for a complete inert example.

- **push → master**: build, then deploy `["zone"]` (the default). One upload, one KV repoint. Staging and production are promoted deliberately — see below.
- **release published**: stage the build under the release tag — `build-command`, `version: ${{ github.event.release.tag_name }}`, `deployment-environments: '[]'`. The site is rebuilt with the tag as its version so its assets resolve from the tag prefix, uploaded there, and **no KV record changes**. Promotion is a separate, deliberate run.
- **workflow_dispatch (promote)**: pick an `environment` and name the `version` to put live — e.g. promote what is on dev to stg. Copy the version from the deploy run that produced it; it cannot be reconstructed from a commit sha, because it carries the run id of the run that built it. Nothing is uploaded, so the action asks for no credentials at all — the broker checks the version is present and complete before it touches the rollout record.

## Runtime contract preserved

The CF Worker serves `https://cdn.decentraland.org/<prefix>/<version>/…` and selects the version from a KV value `{ records: { <rolloutName>: RolloutRecord[] } }`. S3 key stays `<package-name>/<version>/…`, `prefix === packageName`, and the KV value is merged with `patchRollouts` — by the **broker**, not by this action, which no longer touches KV at all.

## Notes & caveats

- **One deploy at a time per repo.** Set a workflow `concurrency` group (see Quick start) — the KV update is read-modify-write and Cloudflare KV has no compare-and-swap.
- **Ordering.** The S3 step always runs before the rollout, and the broker refuses to publish a prefix without a completion marker, so KV never points at a half-written version. A failed run is safe to re-run (idempotent). A crashed upload leaves no completion marker, so the prefix stays re-openable and a re-run simply finishes it; a _finished_ version is immutable and a re-run is reported as a skip.
- **Transient failures are retried.** Broker calls retry on a 429, any 5xx and network errors (3 attempts, exponential backoff), so a blip after the bytes land doesn't leave the deploy uploaded-but-not-repointed. S3 is retried by the aws-sdk itself, and the broker retries Cloudflare on its own side.
- **Multi-env is not atomic.** Repointing several environments writes each KV namespace in turn; on a mid-way failure the action throws an aggregate naming which envs were already updated vs failed (no rollback — KV has none).
- **Bad inputs are errors, not silent winners.** A duplicated environment; a version containing a path separator; a `dist-path` that is the repo root, resolves outside the workspace, or holds a nested `.git`; a run that would upload nothing and publish nothing.
- **The KV key is not yours to choose.** It comes from `deploymentPath` in definitions. Which key a package may write decides whose site a deploy replaces, so accepting it as an input would let any authorised repository repoint another team's site.
- **Package names must be lower-case** and at most 214 characters. S3 keys are case-sensitive, so an upper-case name would deploy to a prefix the worker never serves.
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
