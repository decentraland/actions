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

3. (Activate squash merges)[docs/squash_merge/SQUASH_MERGE.md] in your repository. When this is activated and you click on `squash and merge` button, it uses the pr's title as a commit message. If not, it puts the title in the body and the message will look like `Merge pull request #1 from ...`.
