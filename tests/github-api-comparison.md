# DCP vs JSON — GitHub API Token Comparison

## Purpose

Measure token reduction when converting real GitHub API responses to DCP format.

## Data Source

- Repository: `modelcontextprotocol/servers` (high-activity public repo)
- Endpoints: issues (7 fields), pull requests (15 fields)
- Sample size: 20 records each
- Date: 2026-03-27

## Results

### Issues — 7 fields × 20 records

| Format | Bytes | ~Tokens | vs DCP |
|--------|-------|---------|--------|
| JSON   | 3653  | 914     | 1.50x  |
| DCP    | 2441  | 611     | 1.00x  |

**Reduction: 33.2%** (~303 tokens saved)

### Pull Requests — 15 fields × 20 records

| Format | Bytes | ~Tokens | vs DCP |
|--------|-------|---------|--------|
| JSON   | 7106  | 1777    | 2.01x  |
| DCP    | 3528  | 882     | 1.00x  |

**Reduction: 50.4%** (~895 tokens saved)

## Observations

- More fields per record → higher reduction ratio (33% at 7 fields, 50% at 15 fields)
- Consistent with specification benchmark (40-60% range)
- Text-heavy fields (titles, branch names) reduce the ratio — DCP saves on keys, not values
- Null fields from API (additions, deletions not returned in list endpoint) suggest cutdown mask would improve further

## Reproduction

```bash
# Fetch data
gh api repos/modelcontextprotocol/servers/issues?per_page=20 \
  --jq '[.[] | {number, title, state, user: .user.login, labels: [.labels[].name], created_at, comments}]' \
  > tests/github-issues-sample.json

# Generate schema + encode
cat tests/github-issues-sample.json | npx dcp-core init github-issue
cat tests/github-issues-sample.json | npx dcp-core encode --schema dcp-schemas/github-issue.v1.json
```
