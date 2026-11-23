#!/usr/bin/env bash
# smoke-test.sh [dev|prod]
#
# RUN AFTER `cdk deploy`. Proves the deployed infrastructure is wired together, using the real ingest function and agent. It creates one tiny object in the documents bucket and deletes it again. It does NOT call a model.
#
#   1  web          CloudFront serves the app shell (the built app or, without a build, the placeholder: both have this title)
#   2  spa routing  a deep link such as /projects/123 returns the app shell (the CloudFront Function)
#   3  api path     /api/health through CloudFront reaches FastAPI (CloudFront -> Function URL -> Lambda Web Adapter)
#   4  api direct   the Function URL answers the same health check
#   5  agent        AgentCore Runtime answers an invocation
#   6  sign-in      Cognito self sign-up is disabled
#   7  knowledge    Knowledge Base ACTIVE and its S3 data source AVAILABLE
#   8  ingest       an upload under projects/ invokes the ingest Lambda (its log line proves it; the object has no document record, so the function skips it)
#
# Exit code 1 if any check fails.

# shellcheck disable=SC2015  # `check && pass || fail` is intentional: `pass` is a printf and cannot fail.
set -uo pipefail
STAGE="${1:-dev}"
REGION="${CDK_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
FAILS=0

pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }

out() { # <layer> <OutputKey>
  aws --region "$REGION" cloudformation describe-stacks --stack-name "kc-${STAGE}-$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text 2>/dev/null
}

WEB="$(out web WebUrl)"; API="$(out api ApiFunctionUrl)"; RUNTIME="$(out agent AgentRuntimeArn)"
POOL="$(out auth UserPoolId)"; KB="$(out knowledge KnowledgeBaseId)"; DS="$(out knowledge DataSourceId)"
BUCKET="$(out knowledge DocsBucketName)"; INGEST="$(out knowledge IngestFunctionName)"
for v in WEB API RUNTIME POOL KB DS BUCKET INGEST; do
  if [ -z "${!v}" ] || [ "${!v}" = "None" ]; then echo "Stack outputs missing (${v}). Is kc-${STAGE} deployed in ${REGION}?"; exit 1; fi
done
echo "Web: ${WEB}"

printf '\n[1-4] HTTP paths\n'
body="$(curl -fsS "${WEB}/" 2>/dev/null || true)"
echo "$body" | grep -q "Knowledge Chat</title>" && pass "1 CloudFront serves the app shell" || fail "1 app shell not served at ${WEB}/"
body="$(curl -fsS "${WEB}/projects/123" 2>/dev/null || true)"
echo "$body" | grep -q "Knowledge Chat</title>" && pass "2 deep link returns the app shell" || fail "2 SPA routing: /projects/123 did not return the app"
code="$(curl -sS -o /tmp/kc-health -w '%{http_code}' "${WEB}/api/health" 2>/dev/null || true)"
grep -q '"status":"ok"' /tmp/kc-health 2>/dev/null && [ "$code" = "200" ] && pass "3 /api/health through CloudFront reaches FastAPI" || fail "3 /api/health via CloudFront returned HTTP ${code}: $(cat /tmp/kc-health 2>/dev/null)"
code="$(curl -sS -o /tmp/kc-health2 -w '%{http_code}' "${API%/}/api/health" 2>/dev/null || true)"
[ "$code" = "200" ] && pass "4 Function URL answers directly" || fail "4 Function URL returned HTTP ${code}"

printf '\n[5] Agent\n'
reply="$(aws --region "$REGION" bedrock-agentcore invoke-agent-runtime --agent-runtime-arn "$RUNTIME" \
  --runtime-session-id "smoke-test-session-$(date +%s)-0123456789abcdef" --content-type application/json \
  --cli-binary-format raw-in-base64-out --payload '{"text":"ping"}' /tmp/kc-agent.json >/dev/null 2>&1 && cat /tmp/kc-agent.json || true)"
# An incomplete request is rejected by the real agent before any model call, so this check costs nothing.
echo "$reply" | grep -q "'user_id' is missing" && pass "5 AgentCore Runtime runs the agent (rejected an incomplete request, no model call)" || fail "5 AgentCore invocation failed: ${reply}"

printf '\n[6] Sign-in\n'
only="$(aws --region "$REGION" cognito-idp describe-user-pool --user-pool-id "$POOL" --query 'UserPool.AdminCreateUserConfig.AllowAdminCreateUserOnly' --output text 2>/dev/null)"
[ "$only" = "True" ] && pass "6 user pool is invite-only" || fail "6 user pool allows self sign-up (AllowAdminCreateUserOnly=${only})"

printf '\n[7] Knowledge Base\n'
kb="$(aws --region "$REGION" bedrock-agent get-knowledge-base --knowledge-base-id "$KB" --query 'knowledgeBase.status' --output text 2>/dev/null)"
ds="$(aws --region "$REGION" bedrock-agent get-data-source --knowledge-base-id "$KB" --data-source-id "$DS" --query 'dataSource.status' --output text 2>/dev/null)"
[ "$kb" = "ACTIVE" ] && pass "7a knowledge base is ACTIVE" || fail "7a knowledge base status: ${kb}"
[ "$ds" = "AVAILABLE" ] && pass "7b data source is AVAILABLE" || fail "7b data source status: ${ds}"

printf '\n[8] Upload trigger\n'
DOC="$(date +%s)"; KEY="projects/smoke-test/${DOC}/hello.txt"
echo "smoke test" | aws --region "$REGION" s3 cp - "s3://${BUCKET}/${KEY}" >/dev/null 2>&1 && pass "8a object written under projects/" || fail "8a could not write to the documents bucket"
# CDK creates the log group itself (to set the retention), so ask Lambda for its name instead of guessing it.
LOG_GROUP="$(aws --region "$REGION" lambda get-function-configuration --function-name "$INGEST" --query 'LoggingConfig.LogGroup' --output text 2>/dev/null)"
found=""
for _ in 1 2 3 4 5 6; do
  sleep 5
  found="$(aws --region "$REGION" logs filter-log-events --log-group-name "$LOG_GROUP" --filter-pattern "\"${DOC}\"" --query 'events[0].message' --output text 2>/dev/null || true)"
  { [ -n "$found" ] && [ "$found" != "None" ]; } && break
done
{ [ -n "$found" ] && [ "$found" != "None" ]; } && pass "8b ingest function handled the upload (it has no record for it and skips it)" || fail "8b no ingest log line for ${DOC} after 30 s (log group ${LOG_GROUP})"
aws --region "$REGION" s3 rm "s3://${BUCKET}/${KEY}" >/dev/null 2>&1 || true

printf '\n'
if [ "$FAILS" -gt 0 ]; then printf 'SMOKE TEST FAILED (%d check(s)).\n' "$FAILS"; exit 1; fi
printf 'SMOKE TEST OK\n'
