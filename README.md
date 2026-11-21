# Bedrock Knowledge Chat

A web app for uploading documents into a project knowledge base and chatting with an AI that answers from them, with citations.
Built on Amazon Bedrock (Knowledge Bases on S3 Vectors, Guardrails) and Bedrock AgentCore, deployed with TypeScript CDK.
Designed to be cheap: nothing bills by the hour, and cost is dominated by model tokens.

**Status: infrastructure (deployed once and smoke-tested) and backend (API and ingest function, tested with simulated AWS) are implemented. The agent and the UI are the next stages.**
Start with [ARCHITECTURE.md](ARCHITECTURE.md) (the design, cost model and risks) and [infra/README.md](infra/README.md) (the deployment runbook).

```
.
├── ARCHITECTURE.md      <- diagrams, flows, decisions, cost model, risks
├── infra/               <- CDK app: six stacks, 70+ tests, cdk-nag security checks        [done]
├── backend/             <- FastAPI API and the S3-triggered ingest Lambda                  [done: 126 tests]
├── agent/               <- the chat agent container for AgentCore Runtime                  [placeholder]
├── web/                 <- single-page app, published through CloudFront                   [placeholder]
├── scripts/             <- verify, preflight, smoke test, log retention
└── .github/workflows/   <- CI: the same verification, no deployment, no credentials
```

## What gets deployed (six stacks, nothing billed by the hour)

```
 AuthStack ─────────────────────────────────────────────────────┐
 DataStack ──► KnowledgeStack ──► AgentStack ──► ApiStack ──► WebStack
```

Cognito (invite-only) · DynamoDB (on-demand) · S3 + Bedrock Knowledge Base on S3 Vectors + ingest Lambda · Bedrock guardrail + AgentCore runtime ·
FastAPI on Lambda with a streaming Function URL · CloudFront serving the app and `/api/*`.

## Quick start

```bash
cd infra && npm ci
export KC_BUDGET_EMAIL=you@example.com        # recommended: spend alerts
bash ../scripts/preflight.sh dev              # read-only: is this account ready?
npm run verify                                # format, types, tests, cdk-nag, cfn-lint, AWS template validation
npx cdk deploy "kc-dev-*"
bash ../scripts/smoke-test.sh dev             # did it wire up?
```

Requirements: Node 20+, AWS CLI v2 with credentials, Docker (images are built at deploy time), an account bootstrapped for CDK,
and access to Titan Text Embeddings v2 and the chat model. `preflight.sh` checks all of it.

## How the infrastructure is verified

Seven independent layers, run by `npm run verify` and in CI: prettier, strict TypeScript, unit tests (security, correctness and cost properties,
**mutation-tested**), the cdk-nag `AwsSolutions` rules, cfn-lint against AWS's resource schemas, AWS's own `validate-template`, and a Python compile.
The two container images were also built for arm64 and run locally. What static checks cannot prove (runtime IAM evaluation, AgentCore starting
the container, CloudFront streaming) is listed in [infra/README.md](infra/README.md) and covered by the post-deploy smoke test.
