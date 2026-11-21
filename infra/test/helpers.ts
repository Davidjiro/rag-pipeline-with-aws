/**
 * helpers.ts  -  shared test utilities.
 *
 * Every test builds the SAME app the CLI deploys, with the cdk-nag security checks switched on. If a check fails, building
 * the template throws, so a security regression fails the whole suite rather than one test.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { createApp } from '../lib/app-factory';
import { EnvName } from '../lib/config/environments';

export type StackKey = 'auth' | 'data' | 'knowledge' | 'agent' | 'api' | 'web';

export interface TestApp {
  readonly stage: EnvName;
  stack(key: StackKey): Stack;
  template(key: StackKey): Template;
}

export function buildApp(stage: EnvName = 'dev'): TestApp {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-cdk-test-'));
  const app = createApp({ stage, nag: true, outdir });
  const stack = (key: StackKey): Stack => app.node.findChild(`kc-${stage}-${key}`) as Stack;
  return { stage, stack, template: (key) => Template.fromStack(stack(key)) };
}

/** Every IAM statement in a template, as plain objects, from both inline policies and roles. */
export function iamStatements(template: Template): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const policies = template.findResources('AWS::IAM::Policy');
  for (const policy of Object.values(policies)) {
    const statements = (policy as any).Properties.PolicyDocument.Statement;
    out.push(...(Array.isArray(statements) ? statements : [statements]));
  }
  return out;
}

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
