#!/usr/bin/env bash
# set-agent-log-retention.sh [dev|prod] [days]
#
# AgentCore creates the agent's log group itself (/aws/bedrock-agentcore/runtimes/<runtime id>-DEFAULT), so CloudFormation
# cannot set its retention. Left alone it keeps logs forever and the CloudWatch bill creeps up. Run this ONCE after the first
# deployment of the agent stack, and again if the runtime is ever recreated.
#
# The log group exists only after the first invocation of the agent, so a message "no log groups yet" is normal before then.

set -euo pipefail
STAGE="${1:-dev}"
DAYS="${2:-7}"
REGION="${CDK_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
PREFIX="/aws/bedrock-agentcore/runtimes/"

# Runtime ids start with the runtime name, for example kc_dev_chat_agent-AbCdEf1234
GROUPS_FOUND="$(aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "${PREFIX}kc_${STAGE}_" \
  --query 'logGroups[].logGroupName' --output text)"

if [ -z "$GROUPS_FOUND" ]; then
  echo "No agent log groups yet for stage '${STAGE}'. Invoke the agent once, then run this again."
  exit 0
fi

for group in $GROUPS_FOUND; do
  aws logs put-retention-policy --region "$REGION" --log-group-name "$group" --retention-in-days "$DAYS"
  echo "retention set to ${DAYS} days: ${group}"
done
