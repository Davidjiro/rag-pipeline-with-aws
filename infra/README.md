# infra/  -  the CDK app (TypeScript)

Everything that creates AWS resources. Run all commands from this directory. Design background: [../ARCHITECTURE.md](../ARCHITECTURE.md).

## What it deploys: six stacks

```
 AuthStack ─────────────────────────────────────────────────────┐
                                                                 ▼
 DataStack ──► KnowledgeStack ──► AgentStack ──► ApiStack ──► WebStack
```

| Stack | Resources | Outputs |
|-------|-----------|---------|
| `kc-<env>-auth` | Cognito user pool (invite-only, Lite plan) and a public SRP client | `UserPoolId`, `UserPoolClientId`, `JwtIssuer` |
| `kc-<env>-data` | one DynamoDB table (on-demand, TTL), optional AWS Budgets alert | `TableName` |
| `kc-<env>-knowledge` | private docs bucket, Bedrock Knowledge Base on S3 Vectors (S3 data source), ingest Lambda with an S3 trigger | `DocsBucketName`, `KnowledgeBaseId`, `DataSourceId`, `VectorIndexArn`, `IngestFunctionName` |
| `kc-<env>-agent` | Bedrock guardrail (pinned version), AgentCore runtime with its execution role | `AgentRuntimeArn`, `AgentRuntimeId`, `GuardrailId`, `GuardrailVersion` |
| `kc-<env>-api` | FastAPI container Lambda with a streaming Function URL | `ApiFunctionUrl`, `ApiFunctionName` |
| `kc-<env>-web` | private web bucket, CloudFront (app + `/api/*`), security headers, deployed web app | `WebUrl`, `DistributionId` |

Nothing here bills by the hour: no VPC, NAT gateway, VPC endpoint, load balancer, search cluster, KMS key, WAF or state machine.
`lib/config/environments.ts` holds every tunable value.

## The four layers

```
 config/  ──fills──►  props/  ──input to──►  constructs/  ──assembled by──►  stacks/  ──joined in──►  lib/app-factory.ts
 (values)            (interfaces)           (one per building block)         (deployable units)        (the app)
```

| Directory | Question it answers | Rule |
|-----------|---------------------|------|
| `lib/config` | What VALUES do dev and prod use? | the only place with model ids, sizes, limits, names |
| `lib/props` | What does each construct NEED? | interfaces only, no logic |
| `lib/constructs` | How do I build one block well? | never reads config or `process.env`; every file starts with a docstring of concepts and traps |
| `lib/stacks` | Which constructs go together, in what order? | passes live objects between stacks |
| `bin/app.ts` | What do I deploy right now? | three lines: call the factory and synth |
| `test/` | What must always stay true? | security, correctness and cost properties, as tests |

## Commands

```bash
npm ci                                   # exact dependency versions
npm run verify                           # EVERYTHING below, in order (never deploys)
npm test                                 # unit tests only
npx cdk synth "kc-dev-*" --quiet         # build CloudFormation into cdk.out/ (no AWS changes)
npx cdk diff "kc-dev-*"                  # what would change
npx cdk deploy "kc-dev-*"                # deploy the six stacks in dependency order
npx cdk deploy "kc-prod-*" -c stage=prod # prod: RETAIN, termination protection, point-in-time recovery
npx cdk destroy "kc-dev-*"               # remove dev
```

## Configuration (environment variables, all optional)

| Variable | Default | Meaning |
|----------|---------|---------|
| `CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION` | from your credentials, `us-east-1` | target account and region |
| `KC_MODEL_PROFILE_ID` | `global.amazon.nova-2-lite-v1:0` | chat model. Must be a `global.` inference profile. Anthropic models also need the one-time Anthropic use-case form for the account |
| `KC_BUDGET_EMAIL` | none | e-mail for the spend alert. Without it no budget is created |
| `KC_BUDGET_USD` | `10` | monthly budget threshold |
| `KC_UPLOAD_ORIGIN` | `https://*.cloudfront.net` | browser origin allowed to upload to S3. Set your exact origin when you have a custom domain |
| `KC_API_RESERVED_CONCURRENCY`, `KC_INGEST_RESERVED_CONCURRENCY` | unset | Lambda reserved concurrency (see the quota note below) |

**The Lambda quota trap.** Reserved concurrency needs the account to keep at least 100 unreserved executions. A new AWS account has a
total quota of 10, so setting it would FAIL the deployment. It is therefore off by default. `scripts/preflight.sh` prints your account's
quota. Request an increase in Service Quotas before turning it on.

## Verification: what is proven, and how

`npm run verify` runs seven layers. Each is independent, so a problem has to get past all of them.

| # | Layer | What it proves |
|---|-------|----------------|
| 1 | prettier | consistent formatting |
| 2 | `tsc --strict` | the TypeScript is type-correct against the CDK library |
| 3 | jest | the design as executable checks: public access blocked, IAM least privilege, the guardrail's single rule, the vector dimension matches the embedding model, Function URL streaming, CloudFront routing, no resource that bills while idle |
| 4 | `cdk synth` + **cdk-nag** `AwsSolutions` | no security finding without a written justification (see below) |
| 5 | **cfn-lint** | every property of every resource against AWS's CloudFormation resource schemas |
| 6 | `aws cloudformation validate-template` | AWS itself accepts each template (read-only API call) |
| 7 | python compile | the application sources parse |

The test suite was also checked by **mutation**: seven deliberate breakages (public sign-up, a model-routing IAM condition, versioning, buffered
streaming, an index/embedding dimension mismatch, S3 access for the agent, a KMS key) were each applied in turn, and every one was caught.

The two container images were built for `linux/arm64` and run locally: the API answers `/api/health` and hides its docs, the Lambda Web Adapter
extension is present, and the agent answers `/ping` and `/invocations` on port 8080 as a non-root user.

### Deployment verification

The stacks were deployed once to a development account and `scripts/smoke-test.sh` passed: CloudFront serves the app and the single-page-app
deep links, `/api/health` is answered through CloudFront and directly, AgentCore started the placeholder container and answered, the user pool
is invite-only, the Knowledge Base and its data source are active, and an upload under `projects/` invoked the ingest Lambda. The stacks were
then removed with `cdk destroy` (see `scripts/teardown.sh`).

### Still unproven (needs the real backend and agent)

Static checks and a placeholder deployment cannot show these. They belong to the next stages:

- that the agent's model policy for the global inference profile (AWS's documented three-part form) is accepted on a real model call;
- that a real document is parsed, embedded and searchable (the ingest Lambda is a placeholder);
- that CloudFront streams a long answer without buffering it (risk R1 in the architecture).

## Deploy runbook

```bash
cd infra && npm ci
export KC_BUDGET_EMAIL=you@example.com     # recommended
../scripts/preflight.sh dev                # read-only: account, quotas, models, services, name clashes
npm run verify                             # optional but cheap: the whole pipeline
npx cdk deploy "kc-dev-*" --require-approval broadening
../scripts/smoke-test.sh dev               # wiring checks against the deployed stacks
```

Expect the first deploy to take several minutes. Two Docker images are built and pushed (API and agent), and the Knowledge Base and
AgentCore runtime are the slowest resources. Docker must be running.

After the first deploy:

```bash
# 1. there is no public sign-up: create your user (the temporary password arrives by e-mail)
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
# 2. keep the agent's logs for 7 days instead of forever (run again after the first agent invocation)
../scripts/set-agent-log-retention.sh dev
```

Tear down with `bash ../scripts/teardown.sh dev`. It runs `cdk destroy`, then removes the CloudWatch log groups that AgentCore and the CDK helper
Lambdas create outside CloudFormation (they survive a plain destroy and would otherwise keep logs forever). Dev buckets are emptied automatically.
Prod keeps its data and refuses deletion on purpose. Docker images pushed for the Lambda and the agent stay in the shared CDK bootstrap repository
(a few cents a month at most) until you delete them.

## Accepted deviations (cdk-nag `AwsSolutions`)

Findings the project could fix were fixed. These remain, each acknowledged on the narrowest construct in `lib/nag-suppressions.ts`.

| Rule | Where | Why it is accepted |
|------|-------|--------------------|
| COG2 (MFA) | user pool | invite-only is the main control. Mandatory MFA needs enrolment screens in the app (listed as hardening) |
| COG8 (Plus plan) | user pool | the Plus feature plan bills per active user. Lite is enough |
| DDB3 (point-in-time recovery) | table, dev only | costs per GB-month. ON in prod |
| S1 (access logs) | both buckets | a second bucket and a log line per request, for no stated requirement |
| CFR1 (geo restriction) | CloudFront | no requirement |
| CFR2 (WAF) | CloudFront | monthly fee per web ACL and rule. JWT checks, a daily cap and a budget alert cover the API |
| CFR3 (access logs) | CloudFront | log bucket and per-request storage |
| CFR4 (TLS version) | CloudFront | the default `*.cloudfront.net` certificate fixes TLS 1.0 as the minimum. Fixing it needs a custom domain and certificate |
| IAM5 (wildcards) | Knowledge Base policy, API role, agent role | prefix wildcards (`projects/*`, runtime and log group names created later) and service actions with no resource-level form (X-Ray, metrics). The agent role follows AWS's documented AgentCore role, and has no S3, DynamoDB or IAM access |
| IAM4, IAM5, L1 | two CDK-created helper Lambdas | owned by `aws-cdk-lib` (bucket deployment, bucket notifications) |

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| `Docker daemon is not running` during deploy | start Docker: the API and agent images are built at deploy time |
| Deploy fails on `ReservedConcurrentExecutions` | the account quota is below 100. Unset `KC_*_RESERVED_CONCURRENCY` |
| AgentCore name validation error | runtime names allow letters, digits and `_` only. `agentName()` enforces it |
| `cdk synth` prints a cdk-nag ERROR | a new resource has a finding. Fix it, or add a reasoned acknowledgement. Never use `-c nag=off` in CI |
| Agent calls fail with `AccessDenied` on the model | the model policy has three parts (profile, regional model, global model). See `chat-agent-runtime.ts` |
| Stack stuck in `ROLLBACK_COMPLETE` | delete it and redeploy: `npx cdk destroy kc-dev-<layer>` |
