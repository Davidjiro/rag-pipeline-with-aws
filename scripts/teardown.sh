#!/usr/bin/env bash
# teardown.sh [dev|prod]
#
# Removes a deployed stage COMPLETELY:
#   1. `cdk destroy` of the six stacks (dev only: prod is protected on purpose, see below);
#   2. the CloudWatch log groups that AWS services create OUTSIDE CloudFormation, which a plain destroy leaves behind:
#        - /aws/bedrock-agentcore/runtimes/kc_<stage>_*   (created by AgentCore on first use)
#        - /aws/lambda/kc-<stage>-*                       (created lazily for the helper Lambdas CDK adds)
#
# It does NOT delete Docker images in the shared CDK bootstrap repository: other projects may use that repository.
# They cost a few cents a month. List them with:
#   aws ecr describe-images --repository-name <cdk-hnb659fds-container-assets-...>
#
# Prod: its data stores use RETAIN and its stacks have termination protection, so this script refuses it.
# To remove prod deliberately, disable termination protection and delete the retained resources by hand.

set -euo pipefail
STAGE="${1:-dev}"
REGION="${CDK_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$STAGE" != "dev" ]; then
  echo "Refusing to tear down '${STAGE}': only dev is disposable. See the note at the top of this script." >&2
  exit 1
fi

echo "==> Destroying the kc-${STAGE} stacks (this can take several minutes: CloudFront is slow to delete)"
(cd "$ROOT/infra" && npx cdk destroy "kc-${STAGE}-*" --force)

echo "==> Removing log groups created outside CloudFormation"
removed=0
for prefix in "/aws/bedrock-agentcore/runtimes/kc_${STAGE}_" "/aws/lambda/kc-${STAGE}-"; do
  for group in $(aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "$prefix" \
      --query 'logGroups[].logGroupName' --output text); do
    aws logs delete-log-group --region "$REGION" --log-group-name "$group"
    echo "    deleted ${group}"
    removed=$((removed + 1))
  done
done
echo "    ${removed} log group(s) removed"

echo "==> Remaining kc-${STAGE} stacks: $(aws cloudformation list-stacks --region "$REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE DELETE_FAILED \
  --query "length(StackSummaries[?starts_with(StackName,'kc-${STAGE}-')])" --output text)"
echo "Done."
