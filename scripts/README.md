# scripts/  -  verify, check and operate

| Script | When | Changes AWS? | What it does |
|--------|------|--------------|--------------|
| `verify.sh` | any time, and in CI | no | the nine-layer proof: format, types, tests, synth with cdk-nag, cfn-lint, AWS template validation, python compile, backend lint and tests, agent lint and tests. Uses `backend/.venv` and `agent/.venv` (separate, because both services have a package named `app`); override with `BACKEND_PYTHON` / `AGENT_PYTHON` |
| `preflight.sh [stage]` | before the first deploy | no (read-only) | checks tools, credentials, CDK bootstrap, Lambda quota, Bedrock models and inference profile, the services the stacks use, and name clashes |
| `smoke-test.sh [stage]` | right after deploy | writes then deletes one tiny object | checks CloudFront, the SPA routing, `/api/health` through CloudFront and directly, the agent, invite-only sign-in, the Knowledge Base status, and the S3 ingest trigger |
| `teardown.sh [dev]` | when finished | **yes: deletes the dev stacks** | `cdk destroy`, then removes the log groups AgentCore and the CDK helper Lambdas create outside CloudFormation. Refuses prod |
| `set-agent-log-retention.sh [stage] [days]` | once after the first agent invocation | sets one log retention | AgentCore creates its own log group, so CloudFormation cannot set its retention |

```bash
bash scripts/preflight.sh dev      # ready to deploy?
(cd infra && npx cdk deploy "kc-dev-*")
bash scripts/smoke-test.sh dev     # did it wire up?
```

All scripts pass `shellcheck` at every severity. `verify.sh` marks any layer it cannot run as SKIPPED, never as passed.
`smoke-test.sh` needs a deployment. It passed against a real dev deployment, and it fails cleanly when the stacks are missing.
