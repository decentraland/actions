#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from datetime import datetime
from typing import Dict, List

import requests
from anthropic import Anthropic


def get_pr_data(repo_owner: str, repo_name: str, pr_number: int, token: str) -> tuple[Dict, List[Dict], str]:
    """Get all PR data in a single optimized call - PR info, files, and diff"""
    # Get PR info
    pr_url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/pulls/{pr_number}"
    headers = {"Authorization": f"token {token}"}
    
    pr_response = requests.get(pr_url, headers=headers)
    pr_response.raise_for_status()
    pr_info = pr_response.json()
    
    # Get files with diff content (this endpoint has everything we need)
    files_url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/pulls/{pr_number}/files"
    files_response = requests.get(files_url, headers=headers)
    files_response.raise_for_status()
    changed_files = files_response.json()
    
    # Build diff content from files
    diff_content = ""
    for file in changed_files:
        if file['status'] in ['added', 'modified', 'removed']:
            diff_content += f"diff --git a/{file['filename']} b/{file['filename']}\n"
            diff_content += f"--- a/{file['filename']}\n"
            diff_content += f"+++ b/{file['filename']}\n"
            if file.get('patch'):
                diff_content += file['patch'] + "\n"
    
    return pr_info, changed_files, diff_content


def analyze_diff(diff_content: str) -> Dict:
    """Simple diff analysis"""
    if not diff_content:
        return {"total_changes": 0, "file_types": {}, "apis_used": [], "env_vars": []}
    
    # Count changes
    additions = len(re.findall(r'^\+', diff_content, re.MULTILINE))
    deletions = len(re.findall(r'^-', diff_content, re.MULTILINE))
    
    # Find file types
    file_types = {}
    for line in diff_content.split('\n'):
        if line.startswith('diff --git'):
            filename = line.split(' b/')[-1]
            if '.' in filename:
                ext = filename.split('.')[-1]
                file_types[ext] = file_types.get(ext, 0) + 1
    
    # Find API calls
    api_patterns = [
        r'https?://([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})',
        r'fetch\(["\']([^"\']+)["\']',
        r'axios\.(get|post|put|delete)\(["\']([^"\']+)["\']',
        r'requests\.(get|post|put|delete)\(["\']([^"\']+)["\']'
    ]
    
    apis_used = set()
    for pattern in api_patterns:
        matches = re.findall(pattern, diff_content, re.IGNORECASE)
        for match in matches:
            if isinstance(match, tuple):
                apis_used.add(match[1] if len(match) > 1 else match[0])
            else:
                apis_used.add(match)
    
    # Find environment variables
    env_patterns = [
        r'process\.env\.([A-Z_][A-Z0-9_]*)',
        r'os\.environ\[["\']([A-Z_][A-Z0-9_]*)["\']\]',
        r'os\.getenv\(["\']([A-Z_][A-Z0-9_]*)["\']',
        r'\$\{([A-Z_][A-Z0-9_]*)\}',
        r'\$([A-Z_][A-Z0-9_]*)'
    ]
    
    env_vars = set()
    for pattern in env_patterns:
        matches = re.findall(pattern, diff_content, re.IGNORECASE)
        env_vars.update(matches)
    
    return {
        "total_changes": additions + deletions,
        "additions": additions,
        "deletions": deletions,
        "file_types": file_types,
        "apis_used": list(apis_used),
        "env_vars": list(env_vars)
    }


def analyze_with_llm(pr_info: Dict, diff_content: str, api_key: str) -> Dict:
    """Analyze PR with Anthropic Claude"""
    
    client = Anthropic(api_key=api_key)
    
    # Build context
    context = f"""
**Pull Request Information:**
- Title: {pr_info['title']}
- Description: {pr_info['body'] or 'No description'}
- Author: {pr_info['user']['login']}

**DIFF CONTENT:**
{diff_content}

**IMPORTANT: Respond ONLY with valid JSON. No additional text before or after.**

{{
  "summary": "Brief summary (MAX 1000 chars - be concise)",
  "risk_assessment": "Risk level (LOW/MEDIUM/HIGH/CRITICAL) with explanation and main risks (MAX 800 chars - be concise)",
  "api_impact": "API changes analysis (MAX 500 chars - be concise)",
  "dependency_impact": "Dependency analysis (MAX 300 chars - be concise)",
  "suggested_tests": "Specific test suggestions and checklist items (MAX 400 chars - be concise)",
  "code_quality": "Quality assessment (MAX 200 chars - be concise)"
}}

**ANALYSIS RULES:**
- Analyze ONLY the actual code changes shown in the diff
- Use exact parameter names, function names, and API calls from the code
- Don't invent or guess details - base analysis on real code
- Be factual and precise
- Only mention EXPLICITLY added/changed items
- If no changes detected, say "No [type] changes detected"

**DEPENDENCY RULES:**
- Don't assume dependencies based on imports - check if they're actually added
- Be specific about version numbers only if they appear in the diff
- IMPORTANT: If you see imports but no package.json changes, say "Uses existing dependencies"
- CRITICAL: Look for actual "+" lines in package.json files, not just imports in code files

**API RULES:**
- Don't assume API usage - check actual implementation
- Be specific about method names and parameters as they appear in the code
- IMPORTANT: Don't invent method names - use only what's visible in the diff

**JSON Requirements:**
- Character limits are MAXIMUM - write concisely, don't pad with filler words
"""
    
    try:
        response = client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=64000,
            temperature=0.1,
            messages=[{"role": "user", "content": context}],
            stream=True
        )
        
        # Collect streaming response
        content = ""
        for chunk in response:
            if chunk.type == "content_block_delta":
                content += chunk.delta.text
        
        print(f"🔍 Collected content length: {len(content)} characters")
        print(f"🔍 First 200 chars: {content[:200]}")
        
        # Clean content - remove any markdown code blocks
        if content.startswith("```json"):
            content = content[7:]  # Remove ```json
        if content.endswith("```"):
            content = content[:-3]  # Remove ```
        content = content.strip()
        
        print(f"🔍 Cleaned content length: {len(content)} characters")
        print(f"🔍 Cleaned first 200 chars: {content[:200]}")
        
        # Try to parse JSON
        try:
            return json.loads(content)
        except json.JSONDecodeError as e:
            print(f"❌ JSON parsing failed: {e}")
            print(f"📄 Raw response length: {len(content)} characters")
            
            # Return only the raw response when parsing fails
            return {
                "summary": content,
                "risk_assessment": f"Could not parse LLM response. Error: {e}",
                "api_impact": "Raw response shown in summary above",
                "dependency_impact": "Raw response shown in summary above",
                "code_quality": "Raw response shown in summary above"
            }
    
    except Exception as e:
        return {
            "summary": f"Error analyzing with Claude: {str(e)}",
            "risk_assessment": "Analysis failed",
            "api_impact": "Analysis failed",
            "dependency_impact": "Analysis failed",
            "code_quality": "Analysis failed"
        }


def generate_comment(pr_info: Dict, analysis: Dict, commit_sha: str = None) -> str:
    """Generate markdown comment"""
    
    comment = f"""## 🤖 AI Pull Request Review

**PR:** #{pr_info['number']} - {pr_info['title']}  
**Author:** @{pr_info['user']['login']}  
**Commit:** `{commit_sha}`  
**Generated:** {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}

---

### 📋 Summary
{analysis.get('summary', 'No summary available')}

### ⚠️ Risk Assessment
{analysis.get('risk_assessment', 'No risk assessment available')}

### 🔌 API Impact Analysis
{analysis.get('api_impact', 'No API changes detected')}

### 📦 Dependency Impact
{analysis.get('dependency_impact', 'No dependency issues detected')}

### 🧪 Suggested Tests & Checklist
{analysis.get('suggested_tests', 'No specific test suggestions')}

### 🔧 Code Quality Assessment
{analysis.get('code_quality', 'No specific quality assessment')}
"""
    
    return comment


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(description='AI Pull Request Reviewer')
    parser.add_argument('--pr-number', type=int, required=True, help='Pull request number')
    parser.add_argument('--repo-owner', required=True, help='Repository owner')
    parser.add_argument('--repo-name', required=True, help='Repository name')
    
    args = parser.parse_args()
    
    # Get environment variables
    github_token = os.getenv('GITHUB_TOKEN')
    anthropic_api_key = os.getenv('ANTHROPIC_API_KEY')
    
    if not github_token:
        print("Error: GITHUB_TOKEN environment variable is required")
        return 1
    
    if not anthropic_api_key:
        print("Error: ANTHROPIC_API_KEY environment variable is required")
        return 1
    
    try:
        print(f"🔍 Starting AI review for PR #{args.pr_number}")
        
        # Get all PR data in one optimized call
        pr_info, changed_files, diff_content = get_pr_data(args.repo_owner, args.repo_name, args.pr_number, github_token)
        print(f"📋 PR: {pr_info['title']}")
        print(f"📁 {len(changed_files)} files changed")
        
        # Check if review already exists for this commit (before expensive AI call)
        output_dir = 'output'
        os.makedirs(output_dir, exist_ok=True)
        
        pr_head_sha = pr_info['head']['sha'][:8]  # First 8 characters of commit SHA
        output_file = os.path.join(output_dir, f'review_comment_pr_{args.pr_number}_{pr_head_sha}.md')
        
        if os.path.exists(output_file):
            print(f"📋 Review already exists for PR #{args.pr_number} commit {pr_head_sha}")
            print(f"📁 Existing file: {output_file}")
            return 0
        
        print(f"🔗 Commit SHA: {pr_head_sha}")
        
        # Analyze diff
        diff_analysis = analyze_diff(diff_content)
        print(f"🔍 Analysis: {diff_analysis['total_changes']} total changes")
        
        # Generate AI analysis (only if no existing review)
        print("🤖 Generating AI analysis...")
        analysis = analyze_with_llm(pr_info, diff_content, anthropic_api_key)
        
        # Generate and post comment
        print("📝 Generating review comment...")
        comment = generate_comment(pr_info, analysis, pr_head_sha)
        
        # Write comment to file for GitHub Action
        with open(output_file, 'w') as f:
            f.write(comment)
        
        print(f"📁 Review saved to: {output_file}")
        
        print("✅ AI review completed successfully")
        return 0
        
    except Exception as e:
        print(f"❌ AI review failed: {e}")
        return 1


if __name__ == '__main__':
    sys.exit(main())
