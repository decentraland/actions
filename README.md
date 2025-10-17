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

An ultra-simple AI-powered PR review system that analyzes code impact and dependencies.

**Features:**
- Single-file solution (no external dependencies file)
- Self-contained GitHub Action with embedded dependencies
- Code and dependency analysis
- External API and environment variable detection
- Indirect directory impact identification
- Manual trigger or comment trigger `/ai-review`

**Usage:**
```yaml
name: AI Pull Request Review
on:
  workflow_dispatch:
  issue_comment:
    types: [created, edited]

jobs:
  ai-review:
    uses: decentraland/actions/.github/workflows/ai-pr-review.yml@main
```

**Setup:**
1. Copy `.github/workflows/ai-pr-review.yml` to your workflows
2. Add `ANTHROPIC_API_KEY` secret
3. Done! The script downloads automatically.

## Testing

### Local Testing with Docker

The easiest way to test the AI reviewer without installing Python on your system:

1. **Navigate to test directory:**
   ```bash
   cd test
   ```

2. **Set up environment:**
   ```bash
   cp ../env.example ../.env
   # Edit .env with your GitHub token and Anthropic API key
   ```

3. **Test with Docker Compose:**
   ```bash
   # Run tests
   docker-compose run --rm test
   
   # Test the reviewer on a specific PR
   docker-compose run --rm ai-reviewer python ai_reviewer.py \
     --pr-number 123 \
     --repo-owner your-org \
     --repo-name your-repo
   ```

3. **Check output:**
   - The script generates a `review_comment.md` file with the AI review
   - Review the generated comment for accuracy and completeness

### Manual Testing

**Test with a real PR:**
```bash
# Navigate to test directory first
cd test

# Replace with actual values
docker-compose run --rm ai-reviewer python ai_reviewer.py \
  --pr-number 456 \
  --repo-owner decentraland \
  --repo-name marketplace
```

**Test different PR types:**
- Small bug fixes (should be LOW risk)
- Large refactoring (should be MEDIUM/HIGH risk)
- API changes (should detect breaking changes)
- New dependencies (should flag dependency impact)

### Validation Checklist

When testing, verify the AI reviewer correctly identifies:
- [ ] **Risk level** matches the actual impact
- [ ] **API changes** are detected and flagged
- [ ] **Environment variables** are identified
- [ ] **Dependencies** are analyzed for impact
- [ ] **Code quality** assessment is reasonable
- [ ] **Suggested tests** are relevant and actionable
- [ ] **Directory impact** analysis is accurate

### Troubleshooting Tests

**Common issues:**
- **API key errors:** Check your root `.env` file has correct keys
- **Permission errors:** Ensure GitHub token has `repo` or `public_repo` scope
- **Rate limiting:** Wait between test runs if hitting API limits
- **Empty reviews:** Check if PR has actual code changes

**Debug mode:**
```bash
# Navigate to test directory first
cd test

# Run with verbose output
docker-compose run --rm ai-reviewer python ai_reviewer.py \
  --pr-number 123 \
  --repo-owner your-org \
  --repo-name your-repo \
  --verbose
```
