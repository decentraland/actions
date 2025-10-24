# AI PR Reviewer Testing

## Prerequisites

- Docker installed on your system
- Docker Compose (usually comes with Docker Desktop)
- GitHub token with `repo` or `public_repo` scope
- Anthropic API key

## Setup

1. **Navigate to test directory:**
   ```bash
   cd scripts/ai_pr_reviewer/test
   ```

2. **Create environment file in root directory:**
   ```bash
   cp ../env.example ../.env
   ```

3. **Edit root `.env` file with your API keys:**
   - Get a GitHub token from: https://github.com/settings/tokens
   - Get an Anthropic API key from: https://console.anthropic.com/
   - Add both to your `.env` file

## Running Tests

### Basic Test
```bash
# Test the reviewer on a specific PR
docker-compose run --rm ai-reviewer python index.py \
  --pr-number 123 \
  --repo-owner your-org \
  --repo-name your-repo
```

### Test Different PR Types
```bash
# Small bug fixes (should be LOW risk)
docker-compose run --rm ai-reviewer python index.py \
  --pr-number 456 \
  --repo-owner decentraland \
  --repo-name marketplace

# Large refactoring (should be MEDIUM/HIGH risk)
docker-compose run --rm ai-reviewer python index.py \
  --pr-number 789 \
  --repo-owner decentraland \
  --repo-name marketplace

# API changes (should detect breaking changes)
docker-compose run --rm ai-reviewer python index.py \
  --pr-number 101 \
  --repo-owner decentraland \
  --repo-name marketplace
```

### Debug Mode
```bash
# Run with verbose output
docker-compose run --rm ai-reviewer python index.py \
  --pr-number 123 \
  --repo-owner your-org \
  --repo-name your-repo \
  --verbose
```

## Output

The script generates review comment files in the `output/` folder:
- `output/review_comment_pr_XXXX_YYYY.md` - With commit hash

### Getting Help
- Check the main [README.md](../../../README.md) for workflow setup
- Review the [AI PR Reviewer script](../index.py) for implementation details
- Test with known working PRs first before debugging issues