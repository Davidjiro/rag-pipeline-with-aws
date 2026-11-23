# lib/constructs/ - one class per building block

Every file opens with a docstring: what it builds, why, the cost angle, and the traps. Read the headers: they are the study notes.

| File                          | AWS service                         | Key lesson                                                                                                   |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `invite-only-user-pool.ts`    | Cognito                             | no public sign-up (it protects the model bill); SRP sign-in; public client without a secret                  |
| `app-table.ts`                | DynamoDB                            | single-table design; on-demand; TTL; point-in-time recovery only where it matters                            |
| `budget-alert.ts`             | AWS Budgets                         | an alert is a notification, not a cut-off                                                                    |
| `secure-bucket.ts`            | S3                                  | block public access, SSL only, SSE-S3, no versioning, abort stale multipart uploads, CORS for presigned POST |
| `s3-vector-knowledge-base.ts` | Bedrock Knowledge Base + S3 Vectors | managed RAG; fixed index dimension; non-filterable metadata keys; shared index with a metadata filter        |
| `ingest-function.ts`          | Lambda + S3 trigger                 | an S3 event instead of a workflow; reads the owner from DynamoDB, never from the object                      |
| `lambda-log-role.ts`          | IAM                                 | an execution role that can write to ONE log group, instead of the broad managed policy                       |
| `chat-guardrail.ts`           | Bedrock Guardrails                  | one cheap prompt-attack check; a pinned version whose description carries a config hash                      |
| `chat-agent-runtime.ts`       | AgentCore Runtime                   | arm64 container; AWS's documented execution role; the three-part IAM policy for a global model profile       |
| `api-function.ts`             | Lambda + Function URL               | FastAPI through the Lambda Web Adapter, response streaming, public URL protected by a JWT                    |
| `web-distribution.ts`         | CloudFront + S3                     | one domain for app and API; SPA routing with a function, not error pages; security headers                   |

## Rules for writing a construct here

1. Extend `Construct`. The constructor is `(scope, id, props)` and `props` is an interface from `../props`.
2. Never import from `../config` and never read `process.env`.
3. Expose what other stacks need as `public readonly` fields (ids, ARNs, URLs).
4. Secure by default: least-privilege IAM scoped to specific ARNs, encryption, no public access.
5. Document dependencies and gotchas in the header comment.
6. Add a test in `../../test` for every property the design depends on.
