# test/ - the design, as executable checks

Run with `npm test`. Every test builds the **same app the CLI deploys**, with the cdk-nag security checks switched on.

| File               | Checks                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.test.ts`      | six stacks, naming rules, dev vs prod, configuration validation, **a canary proving the security checks really run**                                                                  |
| `security.test.ts` | public access blocked and TLS enforced on every bucket, least-privilege IAM per principal, trust policies, invite-only sign-in, Function URL exposure                                 |
| `stacks.test.ts`   | per-stack facts: vector dimension equals the embedding dimension, one data source limited to `projects/`, one guardrail rule, runtime lifecycle, streaming URL, CloudFront behaviours |
| `cost.test.ts`     | the cost promise: no resource type that bills while idle, arm64 everywhere, on-demand billing, cheapest CloudFront class                                                              |
| `helpers.ts`       | builds the app, extracts IAM statements                                                                                                                                               |

## Why these tests are trustworthy

A test that cannot fail proves nothing, so the suite was **mutation-tested**: seven deliberate breakages (open sign-up, a wrong IAM condition,
versioning on, buffered streaming, an index/embedding dimension mismatch, S3 access for the agent, a KMS key) were each applied and each was caught.
The canary test in `app.test.ts` repeats that idea permanently for the security checks.

Tests deliberately avoid snapshots of whole templates: asset hashes change on every code edit and would make snapshots noise.
