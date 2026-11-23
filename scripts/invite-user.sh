#!/usr/bin/env bash
# invite-user.sh <email> [dev|prod] [--resend]
#
# Invites a user to the app. There is no public sign-up (the user pool is invite-only), so this is how accounts are made.
# Cognito e-mails the user a temporary password; on first sign-in the app asks them to choose a new one.
#
#   bash scripts/invite-user.sh someone@example.com            # invite to dev
#   bash scripts/invite-user.sh someone@example.com prod
#   bash scripts/invite-user.sh someone@example.com dev --resend   # send the invitation again (temporary password expired)
#
# Changes AWS: creates one Cognito user (or re-sends its invitation). Nothing else.
set -euo pipefail

EMAIL="${1:-}"
STAGE="${2:-dev}"
RESEND="${3:-}"
REGION="${CDK_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"

usage() { echo "usage: $0 <email> [dev|prod] [--resend]" >&2; exit 2; }
[ -n "$EMAIL" ] || usage
[[ "$STAGE" =~ ^(dev|prod)$ ]] || usage
[ -z "$RESEND" ] || [ "$RESEND" = "--resend" ] || usage
# A plain address only: it is passed to the AWS CLI as an argument, never through a shell.
[[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "Not a valid e-mail address: $EMAIL" >&2; exit 2; }

POOL="$(aws --region "$REGION" cloudformation describe-stacks --stack-name "kc-${STAGE}-auth" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue | [0]" --output text 2>/dev/null || true)"
if [ -z "$POOL" ] || [ "$POOL" = "None" ]; then
  echo "Stack kc-${STAGE}-auth not found in ${REGION}. Deploy first." >&2
  exit 1
fi

args=(--region "$REGION" cognito-idp admin-create-user --user-pool-id "$POOL" --username "$EMAIL"
  --user-attributes "Name=email,Value=${EMAIL}" "Name=email_verified,Value=true" --desired-delivery-mediums EMAIL)
[ "$RESEND" = "--resend" ] && args+=(--message-action RESEND)

if err="$(aws "${args[@]}" 2>&1 >/dev/null)"; then
  echo "Invitation sent to ${EMAIL} (${STAGE}). The temporary password is valid for 3 days."
  WEB="$(aws --region "$REGION" cloudformation describe-stacks --stack-name "kc-${STAGE}-web" \
    --query "Stacks[0].Outputs[?OutputKey=='WebUrl'].OutputValue | [0]" --output text 2>/dev/null || true)"
  [ -n "$WEB" ] && [ "$WEB" != "None" ] && echo "Sign in at: ${WEB}"
elif [[ "$err" == *UsernameExistsException* ]]; then
  echo "${EMAIL} already has an account. To send the invitation again: $0 ${EMAIL} ${STAGE} --resend" >&2
  exit 1
else
  echo "Could not invite ${EMAIL}: ${err}" >&2
  exit 1
fi
