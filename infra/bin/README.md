# bin/  -  the app entry point

`app.ts` is the file the CDK CLI runs (`"app"` in `../cdk.json`). It is three lines: it calls `createApp()` from
`../lib/app-factory.ts` and synthesises the result.

The stacks are assembled in `lib/app-factory.ts`, not here, so the unit tests can build exactly the app that gets deployed.

```bash
npx cdk deploy "kc-dev-*"                  # dev, the default stage
npx cdk deploy "kc-prod-*" -c stage=prod   # prod
npx cdk synth -c nag=off                   # skip the cdk-nag checks (experiments only, never in CI)
```
