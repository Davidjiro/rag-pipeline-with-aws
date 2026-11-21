/**
 * app-factory.ts  -  builds the whole CDK app: six stacks, tags, and the security checks.
 *
 * It is a function (not top-level code in bin/app.ts) so the unit tests can build exactly the app the CLI deploys.
 *
 * STACKS AND DEPLOYMENT ORDER (CDK derives the order from the references between stacks)
 *
 *   AuthStack ──────────────────────────────────────────────┐
 *   DataStack ──► KnowledgeStack ──► AgentStack ──► ApiStack ──► WebStack
 *
 *   auth       Cognito user pool (invite-only)
 *   data       DynamoDB table, optional budget alert
 *   knowledge  docs bucket, Bedrock Knowledge Base on S3 Vectors, ingest Lambda
 *   agent      guardrail, AgentCore runtime
 *   api        FastAPI Lambda with a streaming Function URL
 *   web        CloudFront + S3 web app, forwards /api/* to the API
 *
 * SECURITY CHECKS
 *   The cdk-nag `AwsSolutions` rule pack runs on every synth. A finding is a synth ERROR unless it is acknowledged with a written
 *   reason in lib/nag-suppressions.ts. Turn it off for a quick experiment with `-c nag=off`. Never do that in CI.
 */
import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ENVIRONMENTS, EnvName, resourceName } from './config/environments';
import { applyNagSuppressions } from './nag-suppressions';
import { AgentStack } from './stacks/agent-stack';
import { ApiStack } from './stacks/api-stack';
import { AuthStack } from './stacks/auth-stack';
import { DataStack } from './stacks/data-stack';
import { KnowledgeStack } from './stacks/knowledge-stack';
import { WebStack } from './stacks/web-stack';

export interface AppOptions {
  /** `dev` (default) or `prod`. Also settable with `-c stage=prod`. */
  readonly stage?: EnvName;
  /** Run the cdk-nag AwsSolutions checks. Default true. */
  readonly nag?: boolean;
  /** Where CDK writes the cloud assembly. Tests pass a temporary directory. */
  readonly outdir?: string;
}

export function createApp(options: AppOptions = {}): App {
  const app = new App({ outdir: options.outdir });

  const stage = (options.stage ?? app.node.tryGetContext('stage') ?? 'dev') as EnvName;
  const config = ENVIRONMENTS[stage];
  if (!config) {
    throw new Error(`Unknown stage "${stage}". Use one of: ${Object.keys(ENVIRONMENTS).join(', ')}`);
  }

  const env = { account: config.account, region: config.region };
  const common = { env, config, terminationProtection: config.protectedEnvironment };

  const auth = new AuthStack(app, resourceName(config, 'auth'), {
    ...common,
    description: 'Bedrock Knowledge Chat: invite-only Cognito user pool',
  });
  const data = new DataStack(app, resourceName(config, 'data'), {
    ...common,
    description: 'Bedrock Knowledge Chat: DynamoDB application table and budget alert',
  });
  const knowledge = new KnowledgeStack(app, resourceName(config, 'knowledge'), {
    ...common,
    table: data.appTable.table,
    description: 'Bedrock Knowledge Chat: documents bucket, Bedrock Knowledge Base on S3 Vectors, ingest Lambda',
  });
  const agent = new AgentStack(app, resourceName(config, 'agent'), {
    ...common,
    knowledge,
    description: 'Bedrock Knowledge Chat: guardrail and AgentCore runtime for the chat agent',
  });
  const api = new ApiStack(app, resourceName(config, 'api'), {
    ...common,
    auth,
    table: data.appTable.table,
    knowledge,
    agent,
    description: 'Bedrock Knowledge Chat: FastAPI Lambda with a streaming Function URL',
  });
  const web = new WebStack(app, resourceName(config, 'web'), {
    ...common,
    auth,
    knowledge,
    api,
    description: 'Bedrock Knowledge Chat: CloudFront distribution and web app',
  });

  for (const [key, value] of Object.entries({
    Project: 'bedrock-knowledge-chat',
    Environment: stage,
    ManagedBy: 'cdk',
  })) {
    Tags.of(app).add(key, value);
  }

  const nagEnabled = options.nag ?? app.node.tryGetContext('nag') !== 'off';
  if (nagEnabled) {
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
    applyNagSuppressions(config, { auth, data, knowledge, agent, api, web });
  }

  return app;
}
