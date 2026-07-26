# Status Publisher Example

A KukGit CI runner can publish a check with a `repo:write` personal access token.

```bash
KUKGIT_URL="https://git.example.com"
ORG="kuklabs"
REPO="project"
SHA="$(git rev-parse HEAD)"
TOKEN="<kgp_token>"

curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  "${KUKGIT_URL}/api/status-checks/${ORG}/${REPO}/commits/${SHA}/statuses" \
  -d '{
    "context": "test",
    "state": "pending",
    "description": "Test suite is running"
  }'

if npm test; then
  STATE="success"
  DESCRIPTION="All tests passed"
else
  STATE="failure"
  DESCRIPTION="Test suite failed"
fi

curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  "${KUKGIT_URL}/api/status-checks/${ORG}/${REPO}/commits/${SHA}/statuses" \
  -d "{\"context\":\"test\",\"state\":\"${STATE}\",\"description\":\"${DESCRIPTION}\"}"
```

Use a separate short-lived token per runner, never print it in build logs, and revoke it when the runner is replaced.
