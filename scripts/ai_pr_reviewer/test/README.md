# Docker Setup for AI PR Reviewer Testing

Simple Docker setup for testing the AI PR Reviewer locally.

## Prerequisites

- Docker installed on your system
- Docker Compose (usually comes with Docker Desktop)

## Setup

1. **Create environment file in root directory:**
   ```bash
   cp ../env.example ../.env
   ```

2. **Edit root `.env` file with your API keys:**
   - Get a GitHub token from: https://github.com/settings/tokens
   - Get an Anthropic API key from: https://console.anthropic.com/
   - Add both to your `.env` file

## Running the AI Reviewer

**Test on a specific PR:**
```bash
docker-compose run --rm ai-reviewer python index.py \
  --pr-number 123 \
  --repo-owner your-org \
  --repo-name your-repo
```

## Output

The script will generate a review comment file in the `output/` folder:
- `output/review_comment_pr_XXXX.md`

## Troubleshooting

- Make sure your root `.env` file has the correct API keys
- Ensure Docker is running
- Check that the repository and PR number exist
- Verify your GitHub token has the necessary permissions