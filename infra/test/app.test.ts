/**
 * app.test.ts  -  the shape of the whole app: stacks, naming, environments, and configuration validation.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { agentName, baseModelId, ENVIRONMENTS, resourceName } from '../lib/config/environments';
import { buildApp } from './helpers';

describe('app', () => {
  const dev = buildApp('dev');

  test('has exactly the six expected stacks', () => {
    const names = dev
      .stack('auth')
      .node.scope!.node.children.map((c) => c.node.id)
      .sort();
    expect(names).toEqual(
      ['kc-dev-agent', 'kc-dev-api', 'kc-dev-auth', 'kc-dev-data', 'kc-dev-knowledge', 'kc-dev-web'].sort(),
    );
  });

  test('synthesises with the cdk-nag AwsSolutions checks enabled and no unacknowledged finding', () => {
    // buildApp turns the checks on; creating any template runs them and throws on an error.
    expect(() => dev.template('web')).not.toThrow();
  });

  test('the security checks really run: a deliberately bad bucket makes the same checks fail', () => {
    // Guards against the plugin being silently disabled, which would make the previous test pass for the wrong reason.
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-nag-canary-'));
    const canary = new App({ outdir });
    const stack = new Stack(canary, 'canary');
    new s3.Bucket(stack, 'Bad', { enforceSSL: false });
    Validations.of(canary).addPlugins(new AwsSolutionsChecks(canary));
    expect(() => canary.synth()).toThrow();
  });

  test('every stack is tagged with project and environment', () => {
    const tags = dev.stack('data').tags.tagValues();
    expect(tags).toMatchObject({ Project: 'bedrock-knowledge-chat', Environment: 'dev', ManagedBy: 'cdk' });
  });

  test('dev is disposable and prod is protected', () => {
    expect(ENVIRONMENTS.dev.removalPolicy).toBe(RemovalPolicy.DESTROY);
    expect(ENVIRONMENTS.prod.removalPolicy).toBe(RemovalPolicy.RETAIN);
    expect(dev.stack('data').terminationProtection).toBe(false);
    const prod = buildApp('prod');
    expect(prod.stack('data').terminationProtection).toBe(true);
    expect(prod.stack('auth').terminationProtection).toBe(true);
  });
});

describe('naming', () => {
  test('resource names are hyphenated and prefixed', () => {
    expect(resourceName(ENVIRONMENTS.dev, 'docs')).toBe('kc-dev-docs');
  });

  test('agent names use underscores only and match the AgentCore pattern', () => {
    const name = agentName(ENVIRONMENTS.prod, 'chat-agent');
    expect(name).toBe('kc_prod_chat_agent');
    expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
  });

  test('an over-long agent name fails at synth time, not at deploy time', () => {
    expect(() => agentName(ENVIRONMENTS.dev, 'x'.repeat(60))).toThrow(/Invalid AgentCore name/);
  });
});

describe('model profile', () => {
  test('global profiles resolve to their base model id', () => {
    expect(baseModelId('global.amazon.nova-2-lite-v1:0')).toBe('amazon.nova-2-lite-v1:0');
    // other global profiles keep working when chosen with KC_MODEL_PROFILE_ID
    expect(baseModelId('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      'anthropic.claude-haiku-4-5-20251001-v1:0',
    );
  });

  test('a regional profile is rejected with an explanation (its IAM policy has a different shape)', () => {
    expect(() => baseModelId('us.amazon.nova-2-lite-v1:0')).toThrow(/global inference profile/);
  });
});

describe('configuration from the environment', () => {
  const OLD = process.env;
  afterEach(() => {
    process.env = OLD;
    jest.resetModules();
  });

  function load(vars: Record<string, string>) {
    process.env = { ...OLD, ...vars };
    let loaded: typeof import('../lib/config/environments') | undefined;
    jest.isolateModules(() => {
      loaded = require('../lib/config/environments');
    });
    return loaded!;
  }

  test('reserved concurrency is OFF by default (a new account has a total Lambda quota of 10)', () => {
    const cfg = load({}).ENVIRONMENTS.dev;
    expect(cfg.reservedConcurrency.api).toBeUndefined();
    expect(cfg.reservedConcurrency.ingest).toBeUndefined();
  });

  test('reserved concurrency can be switched on with environment variables', () => {
    const cfg = load({ KC_API_RESERVED_CONCURRENCY: '5', KC_INGEST_RESERVED_CONCURRENCY: '2' }).ENVIRONMENTS.dev;
    expect(cfg.reservedConcurrency).toEqual({ api: 5, ingest: 2 });
  });

  test('a bad number is rejected with the variable name in the message', () => {
    expect(() => load({ KC_API_RESERVED_CONCURRENCY: 'many' })).toThrow(/KC_API_RESERVED_CONCURRENCY/);
  });

  test('the budget alert exists only when an e-mail is configured', () => {
    expect(load({}).ENVIRONMENTS.dev.budget.email).toBeUndefined();
    expect(load({ KC_BUDGET_EMAIL: 'me@example.com' }).ENVIRONMENTS.dev.budget.email).toBe('me@example.com');
  });
});
