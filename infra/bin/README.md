# bin/ - the CDK app entry points

| File           | App                                                                                   | Deployed by                                           |
| -------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `app.ts`       | the six application stacks. The CDK CLI runs it by default (`"app"` in `../cdk.json`) | `npm run deploy`, or the deploy-test workflow         |
| `ci-access.ts` | one stack: the GitHub Actions OIDC role for the deploy-test workflow                  | a person, once (see `../README.md`, "CI deploy test") |

`app.ts` calls `createApp()` from `../lib/app-factory.ts`, so the unit tests build exactly the app that gets deployed. `ci-access.ts` is a
separate app on purpose: `cdk deploy "kc-dev-*"` and teardown never touch the CI role.

```bash
npx cdk deploy "kc-dev-*"                  # dev, the default stage
npx cdk deploy "kc-prod-*" -c stage=prod   # prod
npx cdk synth -c nag=off                   # skip the cdk-nag checks (experiments only, never in CI)
npx cdk -a "npx ts-node --prefer-ts-exts bin/ci-access.ts" deploy -c githubRepo=<owner>/<repo> -c githubOwnerId=<id> -c githubRepoId=<id>   # CI access, once
```
