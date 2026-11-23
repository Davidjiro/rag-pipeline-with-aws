#!/usr/bin/env bash
# preflight.sh [dev|prod]
#
# READ-ONLY checks that the AWS account, region and workstation can deploy this project. It changes nothing.
# Run it before `cdk deploy`. It exits 1 if any check FAILS. Warnings do not fail it.
#
#   PASS  fine
#   WARN  deployable, but read the message (usually a cost or quota note)
#   FAIL  deployment would fail
#
# Needs: aws CLI v2 with credentials, node, docker (for the image builds at deploy time).

# shellcheck disable=SC2015  # `check && pass || fail` is intentional: `pass` is a printf and cannot fail.
set -uo pipefail

STAGE="${1:-dev}"
REGION="${CDK_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
PROFILE_ID="${KC_MODEL_PROFILE_ID:-global.amazon.nova-2-lite-v1:0}"
BASE_MODEL="${PROFILE_ID#global.}"
FAILS=0

pass() { printf '  PASS  %s\n' "$1"; }
warn() { printf '  WARN  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
section() { printf '\n%s\n' "$1"; }
aws_q() { aws --region "$REGION" "$@" 2>/dev/null; }

section "Workstation"
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//; s/\..*//')"
  [ "$major" -ge 20 ] && pass "node $(node -v)" || fail "node 20 or newer is required, found $(node -v)"
else fail "node is not installed"; fi
command -v cdk >/dev/null 2>&1 && pass "cdk $(cdk --version | cut -d' ' -f1)" || fail "AWS CDK CLI missing: npm install -g aws-cdk"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  pass "docker is running (needed at deploy time to build the API and agent images)"
else fail "docker is not running: the API and agent images are built during cdk deploy"; fi

section "AWS identity (region ${REGION})"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
if [ -n "$ACCOUNT" ]; then pass "credentials valid for account ${ACCOUNT}"; else fail "no valid AWS credentials"; fi

section "CDK bootstrap"
BOOT="$(aws_q ssm get-parameter --name /cdk-bootstrap/hnb659fds/version --query Parameter.Value --output text || true)"
if [ -n "$BOOT" ]; then pass "bootstrapped (version ${BOOT})"; else fail "not bootstrapped: run  cdk bootstrap aws://${ACCOUNT}/${REGION}"; fi

section "Lambda quota"
LIMIT="$(aws_q lambda get-account-settings --query 'AccountLimit.ConcurrentExecutions' --output text || true)"
if [ -z "$LIMIT" ]; then warn "could not read the Lambda concurrency quota"
elif [ "$LIMIT" -lt 100 ]; then
  warn "Lambda concurrency quota is ${LIMIT}. Reserved concurrency needs at least 100 unreserved, so leave KC_API_RESERVED_CONCURRENCY and KC_INGEST_RESERVED_CONCURRENCY UNSET (the default). Request an increase in Service Quotas to enable them."
else pass "Lambda concurrency quota is ${LIMIT}: reserved concurrency can be enabled"; fi

section "Bedrock models"
status() { aws_q bedrock get-foundation-model --model-identifier "$1" --query 'modelDetails.modelLifecycle.status' --output text || true; }
[ "$(status amazon.titan-embed-text-v2:0)" = "ACTIVE" ] && pass "Titan Text Embeddings v2 is active" || fail "Titan Text Embeddings v2 is not available in ${REGION}"
[ "$(status "$BASE_MODEL")" = "ACTIVE" ] && pass "chat model ${BASE_MODEL} is active" || fail "chat model ${BASE_MODEL} is not available in ${REGION}"
PSTATUS="$(aws_q bedrock list-inference-profiles --query "inferenceProfileSummaries[?inferenceProfileId=='${PROFILE_ID}'].status | [0]" --output text || true)"
[ "$PSTATUS" = "ACTIVE" ] && pass "inference profile ${PROFILE_ID} is active" || fail "inference profile ${PROFILE_ID} not found (list yours: aws bedrock list-inference-profiles)"
# "ACTIVE" above does not mean the account may call it: Anthropic models refuse every call until the one-time use-case form is
# submitted (found on a real deployment). Amazon models, such as the default Nova 2 Lite, need no form.
if [[ "$BASE_MODEL" == anthropic.* ]]; then
  if aws_q bedrock get-use-case-for-model-access >/dev/null 2>&1; then pass "Anthropic use-case form submitted for this account"
  else fail "Anthropic use-case form not submitted: every model call would fail. Submit it in the Bedrock console, or use the default Amazon Nova model"; fi
fi

section "Services used by the stacks"
aws_q s3vectors list-vector-buckets --max-results 1 >/dev/null && pass "S3 Vectors" || fail "S3 Vectors is not available in ${REGION}"
aws_q bedrock-agentcore-control list-agent-runtimes --max-results 1 >/dev/null && pass "Bedrock AgentCore" || fail "Bedrock AgentCore is not available in ${REGION}"
aws_q bedrock-agent list-knowledge-bases --max-results 1 >/dev/null && pass "Bedrock Knowledge Bases" || fail "Bedrock Knowledge Bases is not available in ${REGION}"
aws_q bedrock list-guardrails --max-results 1 >/dev/null && pass "Bedrock Guardrails" || fail "Bedrock Guardrails is not available in ${REGION}"

section "Name clashes (resources with fixed names)"
clash=0
stacks="$(aws_q cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE ROLLBACK_COMPLETE REVIEW_IN_PROGRESS --query "StackSummaries[?starts_with(StackName,'kc-${STAGE}-')].StackName" --output text || true)"
[ -n "$stacks" ] && { warn "stacks already exist: ${stacks} (a deploy will UPDATE them)"; clash=1; }
if aws_q dynamodb describe-table --table-name "kc-${STAGE}-app" >/dev/null; then
  warn "DynamoDB table kc-${STAGE}-app exists"; clash=1; fi
for fn in api ingest; do
  if aws_q lambda get-function --function-name "kc-${STAGE}-${fn}" >/dev/null; then warn "Lambda kc-${STAGE}-${fn} exists"; clash=1; fi
done
[ "$clash" -eq 0 ] && pass "no existing kc-${STAGE}-* resources"

section "Cost protection"
if [ -n "${KC_BUDGET_EMAIL:-}" ]; then pass "budget alert will be created for ${KC_BUDGET_EMAIL}"
else warn "KC_BUDGET_EMAIL is not set: no budget alert will be created. Set it to get spend e-mails."; fi

printf '\n'
if [ "$FAILS" -gt 0 ]; then printf 'RESULT: %d check(s) FAILED. Fix them before deploying.\n' "$FAILS"; exit 1; fi
printf 'RESULT: ready to deploy.\n'
