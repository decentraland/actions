# Decentraland Actions

A collection of reusable GitHub Actions for Decentraland repositories.

## Table of Contents

- [validate-pr-title](#validate-pr-title)
  - [Integration](#integration)
- [AI Pull Request Reviewer](#ai-pull-request-reviewer)
  - [Usage](#usage)
  - [Setup](#setup)
  - [Testing](#testing)

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
