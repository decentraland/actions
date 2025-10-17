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


def get_pr_info(repo_owner: str, repo_name: str, pr_number: int, token: str) -> Dict:
    """Get PR information from GitHub API"""
    url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/pulls/{pr_number}"
    headers = {"Authorization": f"token {token}"}
    
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    return response.json()


def get_pr_diff(repo_owner: str, repo_name: str, pr_number: int, token: str) -> str:
    """Get PR diff from GitHub API"""
    url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/pulls/{pr_number}"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3.diff"
    }
    
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    return response.text


def get_pr_files(repo_owner: str, repo_name: str, pr_number: int, token: str) -> List[Dict]:
    """Get changed files from GitHub API"""
    url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/pulls/{pr_number}/files"
    headers = {"Authorization": f"token {token}"}
    
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    return response.json()


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


def analyze_with_llm(pr_info: Dict, changed_files: List[Dict], diff_analysis: Dict, api_key: str) -> Dict:
    """Analyze PR with Anthropic Claude"""
    
    client = Anthropic(api_key=api_key)
    
    # Build context
    context = f"""
**Pull Request Information:**
- Title: {pr_info['title']}
- Description: {pr_info['body'] or 'No description'}
- Author: {pr_info['user']['login']}
- Files changed: {len(changed_files)}
- Additions: +{pr_info['additions']}
- Deletions: -{pr_info['deletions']}

**Changed Files:**
"""
    
    for file_info in changed_files[:10]:  # Limit to first 10
        context += f"- {file_info['filename']} ({file_info['status']})\n"
    
    context += f"""
**Analysis Summary:**
- Total changes: {diff_analysis['total_changes']}
- File types: {', '.join([f'{k}: {v}' for k, v in diff_analysis['file_types'].items()])}
- APIs used: {', '.join(diff_analysis['apis_used'][:5])}
- Environment variables: {', '.join(diff_analysis['env_vars'][:5])}

**IMPORTANT: Respond ONLY with valid JSON. No additional text before or after.**

{{
  "summary": "Brief summary (MAX 1000 chars - be concise)",
  "risk_assessment": "Risk level (LOW/MEDIUM/HIGH/CRITICAL) with explanation and main risks (MAX 800 chars - be concise)",
  "api_impact": "API changes analysis (MAX 500 chars - be concise)",
  "dependency_impact": "Dependency analysis (MAX 300 chars - be concise)",
  "code_quality": "Quality assessment (MAX 200 chars - be concise)"
}}

**CRITICAL ANALYSIS REQUIREMENTS:**
- Analyze ONLY the actual code changes shown in the diff
- Use exact parameter names, function names, and API calls from the code
- Don't invent or guess details - base analysis on real code
- Focus on concrete changes, not hypothetical scenarios
- Be factual and precise

**JSON Requirements:**
- Use double quotes for all strings
- No trailing commas
- Escape quotes in strings with \"
- Character limits are MAXIMUM - write concisely, don't pad with filler words
- Ensure valid JSON syntax
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
            print(f"📄 Full raw response:")
            print(content)
            
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


def post_comment(repo_owner: str, repo_name: str, pr_number: int, comment: str, token: str) -> bool:
    """Post comment on PR"""
    url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/issues/{pr_number}/comments"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json"
    }
    
    data = {"body": comment}
    
    try:
        response = requests.post(url, headers=headers, json=data)
        response.raise_for_status()
        return True
    except Exception as e:
        print(f"Error posting comment: {e}")
        return False


def generate_comment(pr_info: Dict, analysis: Dict, diff_analysis: Dict) -> str:
    """Generate markdown comment"""
    
    comment = f"""## 🤖 AI Pull Request Review

**PR:** #{pr_info['number']} - {pr_info['title']}  
**Author:** @{pr_info['user']['login']}  
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
        
        # Get PR information first to check for existing reviews
        pr_info = get_pr_info(args.repo_owner, args.repo_name, args.pr_number, github_token)
        print(f"📋 PR: {pr_info['title']}")
        
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
        
        # Get changed files
        changed_files = get_pr_files(args.repo_owner, args.repo_name, args.pr_number, github_token)
        print(f"📁 {len(changed_files)} files changed")
        
        # Get diff and analyze
        diff_content = get_pr_diff(args.repo_owner, args.repo_name, args.pr_number, github_token)
        diff_analysis = analyze_diff(diff_content)
        print(f"🔍 Analysis: {diff_analysis['total_changes']} total changes")
        
        # Generate AI analysis (only if no existing review)
        print("🤖 Generating AI analysis...")
        analysis = analyze_with_llm(pr_info, changed_files, diff_analysis, anthropic_api_key)
        
        # Generate and post comment
        print("📝 Generating review comment...")
        comment = generate_comment(pr_info, analysis, diff_analysis)
        
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
