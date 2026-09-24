# Decentraland Actions

A collection of reusable GitHub Actions for Decentraland repositories.

## Table of Contents

- [validate-pr-title](#validate-pr-title)
  - [Integration](#integration)
- [AI Pull Request Reviewer](#ai-pull-request-reviewer)
  - [Usage](#usage)
  - [Setup](#setup)
  - [Testing](#testing)
- [deploy-service](#deploy-service)
  - [Inputs](#inputs)
  - [Migrating from dcl-deploy-action](#migrating-from-dcl-deploy-action)
- [cdn-deploy](#cdn-deploy)
  - [Inputs](#inputs-1)

---

# validate-pr-title

It's a workflow that enforces every pr's title to follow our [Git style guide](https://github.com/decentraland/adr/blob/main/docs/ADR-6-git-style-guide.md).

## Integration

1. Add a workflow like the following:

   ```yaml
   name: validate-pr-title

   on:
   pull_request:
     types: [edited, opened, reopened, synchronize]

   jobs:
   title-matches-convention:
     uses: decentraland/actions/.github/workflows/validate-pr-title.yml@main
   ```

2. Add a rule to your repository to [make the check for title-matches-convention required](docs/check_required/CHECK_REQUIRED.md). If not, when the title doesn't match the convention, the check will be mark as failed but users will be able to merge.

3. [Activate squash merges](docs/squash_merge/SQUASH_MERGE.md) in your repository. When this is activated and you click on `squash and merge` button, it uses the pr's title as a commit message. If not, it puts the title in the body and the message will look like `Merge pull request #1 from ...`.

## AI Pull Request Reviewer

An AI-powered PR review system that analyzes code impact and dependencies, providing automated code reviews with risk assessment and actionable feedback.

### Usage

```yaml
name: AI Pull Request Review

on:
  workflow_dispatch:
  pull_request:
    types: [labeled]
  issue_comment:
    types: [created, edited]

jobs:
  ai-review:
    if: |
      (github.event_name == 'pull_request' && github.event.label.name == 'ai-review') ||
      (github.event_name == 'issue_comment' && 
       github.event.issue.pull_request &&
       github.event.comment.body == 'ai-review')
    uses: decentraland/actions/.github/workflows/ai-pr-review.yml@main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Setup

1. **Add the workflow** to your repository using one of the options above
2. **Add `ANTHROPIC_API_KEY`** as a repository or organization secret
3. **Done!** The script downloads automatically from the main branch

### Testing

For detailed testing instructions, see [scripts/ai_pr_reviewer/test/README.md](scripts/ai_pr_reviewer/test/README.md)

---

# deploy-service

Creates the GitHub Deployment record that `webhooks-receiver` turns into a Pulumi deploy. Replaces the archived `decentraland/dcl-deploy-action`.

```yaml
- uses: decentraland/actions/deploy-service@main
  with:
    service-name: my-service
    docker-image: quay.io/decentraland/my-service:1.2.3
    env: prd
    token: ${{ secrets.GITHUB_TOKEN }}
```

The calling job needs `permissions: { contents: read, deployments: write }`.

## Inputs

| Input          | Required | Description                                                                                                                                  |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `service-name` | Yes      | Name of the service to deploy                                                                                                                |
| `docker-image` | Yes      | Full image reference, e.g. `quay.io/decentraland/my-service:1.2.3`                                                                           |
| `env`          | Yes      | Target environment: `dev`, `stg`, `prd` or `biz`. Accepts several, space separated (`dev prd`), which creates one deployment per environment |
| `token`        | Yes      | GitHub token with `deployments: write`                                                                                                       |

| Output           | Description                                                   |
| ---------------- | ------------------------------------------------------------- |
| `deployment-ids` | JSON array of the deployment ids created, one per environment |

Prefer an immutable version tag in `docker-image` for `prd`. A mutable tag such as `latest` can be repointed, and once it moves off a digest Quay garbage-collects that digest, so a running task can fail to pull on its next placement.

## Migrating from dcl-deploy-action

Inputs were renamed to kebab-case, and there is a new output:

| `dcl-deploy-action` | `deploy-service`       |
| ------------------- | ---------------------- |
| `serviceName`       | `service-name`         |
| `dockerImage`       | `docker-image`         |
| `env`               | `env` (unchanged)      |
| `token`             | `token` (unchanged)    |
| —                   | `deployment-ids` (new) |

Behaviour is otherwise unchanged: same `dcl/container-deployment` task, same payload, same environment allowlist, same one-deployment-per-environment split.

---

# cdn-deploy

Deploys a pre-built static site to the Decentraland CDN in one step: uploads the folder to S3, then patches the Cloudflare KV rollout record the CDN worker reads to pick a version. Replaces the `oddish-action` → `static-sites-pipeline` → `set-rollout-action` → `webhooks-receiver` relay.

A site repository holds **no Cloudflare token and no IAM role**. The action authenticates to the cdn-deploy broker with a GitHub OIDC token; the broker checks the repository owns the package in [`decentraland/definitions`](https://github.com/decentraland/definitions) before minting S3 credentials scoped to one version prefix, or writing the rollout.

```yaml
- uses: actions/checkout@v4
- run: npm ci && npm run build # the site builds its own artifact
- uses: decentraland/actions/cdn-deploy@cdn-deploy-v1
  with:
    dist-path: ./dist
    deployment-environments: '["zone","today"]'
```

Unlike the rest of this repository, which is consumed from `@main`, `cdn-deploy` is consumed from the pinned major tag `@cdn-deploy-v1`: it runs from a committed bundle, and the release workflow only moves that tag onto a commit whose bundle matches its sources.

The calling job needs `permissions: { id-token: write, contents: read, deployments: write, statuses: write }` — `id-token` to mint the OIDC token the broker authenticates, `deployments` and `statuses` only while `create-github-deployment` is on. Give it a `concurrency` group too, so one deploy runs at a time per repository; the KV update is read-modify-write.

## Inputs

Most inputs are defaulted from the checked-out `package.json`. The ones a caller normally sets:

| Input                     | Required      | Description                                                                                             |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `dist-path`               | For an upload | Pre-built directory to upload, e.g. `./dist`. Omit for a release copy or a repoint                      |
| `deployment-environments` | No            | Environments to repoint, `zone,today` by default. `'[]'` stages the bytes in S3 without rolling out     |
| `version`                 | No            | Target version. Defaults to `<package.json version>-commit-<shortSha>`                                  |
| `copy-from-commit`        | No            | Release flow: fill the target version by copying this commit's build. Off by default                    |
| `slack-webhook`           | No            | The only secret a site repository still passes, and it is optional                                      |
| `broker-url`              | No            | Overrides the broker endpoint. Defaults to the production one                                           |

| Output    | Description                                                    |
| --------- | -------------------------------------------------------------- |
| `version` | The deployed version                                           |
| `s3-path` | The S3 key prefix that was written: `<package-name>/<version>` |
| `cdn-url` | Where the worker serves that version from                      |
| `mode`    | What the S3 step did: `upload`, `copy` or `skip`               |

See [cdn-deploy/README.md](cdn-deploy/README.md) for the full input list, the state table that decides upload vs copy vs skip, and the push / release / manual-deploy flows.
