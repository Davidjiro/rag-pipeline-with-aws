#!/usr/bin/env node
/**
 * app.ts  -  ENTRY POINT of the CDK app (`"app"` in ../cdk.json). The stacks are assembled in lib/app-factory.ts.
 *
 *   npx cdk synth "kc-dev-*" --quiet           # build CloudFormation, no AWS changes
 *   npx cdk deploy "kc-dev-*"                  # deploy all six stacks, in dependency order
 *   npx cdk deploy "kc-prod-*" -c stage=prod   # prod (termination protection, RETAIN)
 *   npx cdk destroy "kc-dev-*"                 # delete everything in dev
 */
import { createApp } from '../lib/app-factory';

createApp().synth();
