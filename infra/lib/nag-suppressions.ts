/**
 * nag-suppressions.ts  -  every cdk-nag finding this project accepts, each with a written reason.
 *
 * The rule pack is `AwsSolutions`. Findings the project could fix were fixed (for example the two application Lambdas use a
 * log-only role instead of the broad managed log policy, and Python 3.15 is used to satisfy the runtime rule). What is left
 * falls in three groups:
 *
 *   1. COST      A control that bills monthly, which this project deliberately leaves out (WAF, access logs, Plus plan).
 *   2. SERVICE   The AWS service offers no narrower form (for example X-Ray cannot be scoped to a resource).
 *   3. HELPER    A Lambda that CDK itself creates (bucket deployment, bucket notifications). Its role and runtime are owned by
 *                aws-cdk-lib, and they change when the CDK version changes.
 *
 * Acknowledgements are placed on the narrowest construct that works, never on a whole stack, so a future real finding on a new
 * resource is still reported. The table of accepted deviations in infra/README.md mirrors this file.
 */
import { Validations } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';
import { EnvironmentConfig } from './config/environments';
import { AgentStack } from './stacks/agent-stack';
import { ApiStack } from './stacks/api-stack';
import { AuthStack } from './stacks/auth-stack';
import { DataStack } from './stacks/data-stack';
import { KnowledgeStack } from './stacks/knowledge-stack';
import { WebStack } from './stacks/web-stack';

export interface AppStacks {
  readonly auth: AuthStack;
  readonly data: DataStack;
  readonly knowledge: KnowledgeStack;
  readonly agent: AgentStack;
  readonly api: ApiStack;
  readonly web: WebStack;
}

/** Acknowledge a rule on every CDK-created helper construct in a stack whose id starts with one of the prefixes. */
function acknowledgeHelpers(
  stack: { node: IConstruct['node'] },
  prefixes: string[],
  acknowledgements: { id: string; reason: string }[],
): void {
  for (const child of stack.node.children) {
    if (prefixes.some((prefix) => child.node.id.startsWith(prefix))) {
      Validations.of(child).acknowledge(...acknowledgements);
    }
  }
}

const HELPER_ROLE =
  'HELPER: this role belongs to a Lambda that aws-cdk-lib creates. It uses the AWS managed basic execution policy. ' +
  'It cannot be replaced from application code, and it is updated by upgrading aws-cdk-lib.';

export function applyNagSuppressions(config: EnvironmentConfig, stacks: AppStacks): void {
  const { auth, data, knowledge, agent, api, web } = stacks;

  // ---------------------------------------------------------------- auth
  Validations.of(auth.pool.userPool).acknowledge(
    {
      id: 'AwsSolutions-COG2',
      reason:
        'COST/SCOPE: the pool is invite-only (an administrator creates every user), which is the main control against abuse. ' +
        'Mandatory MFA needs enrolment screens in the web app. Optional TOTP MFA is listed as hardening in ARCHITECTURE.md.',
    },
    {
      id: 'AwsSolutions-COG8',
      reason:
        'COST: the Plus feature plan (advanced threat protection) is billed per monthly active user. The Lite plan is the ' +
        'cheapest and is enough for password sign-in of an invite-only pool.',
    },
  );

  // ---------------------------------------------------------------- data
  if (!config.protectedEnvironment) {
    Validations.of(data.appTable.table).acknowledge({
      id: 'AwsSolutions-DDB3',
      reason:
        'COST: point-in-time recovery bills per GB-month. It is OFF in dev, where data is disposable, and ON in prod ' +
        '(this acknowledgement is only applied for non-protected environments).',
    });
  }

  // ----------------------------------------------------------- knowledge
  Validations.of(knowledge.docsBucket).acknowledge({
    id: 'AwsSolutions-S1',
    reason:
      'COST: server access logging needs a second bucket and stores a log line per request. Object-level audit is not a ' +
      'requirement of this project. CloudTrail data events can be enabled later if it becomes one.',
  });
  Validations.of(knowledge.knowledgeBase).acknowledge({
    id: 'AwsSolutions-IAM5',
    reason:
      'SERVICE: the Knowledge Base role may read `<docs bucket>/projects/*`. Object keys are created by users at upload time, ' +
      'so a prefix wildcard is the narrowest possible resource. The role cannot read anything outside that prefix.',
  });
  Validations.of(knowledge.ingest).acknowledge({
    id: 'AwsSolutions-IAM5',
    reason:
      'SERVICE: the ingest role may put `<docs bucket>/projects/*.metadata.json` only: the metadata file the Knowledge Base ' +
      'reads next to each document. Keys are created at upload time, so a suffix wildcard is the narrowest form. It cannot ' +
      'read any object or write a document.',
  });
  acknowledgeHelpers(knowledge, ['BucketNotificationsHandler'], [{ id: 'AwsSolutions-IAM4', reason: HELPER_ROLE }]);

  // --------------------------------------------------------------- agent
  Validations.of(agent.runtime.executionRole).acknowledge({
    id: 'AwsSolutions-IAM5',
    reason:
      'SERVICE: this is the execution role AWS documents for AgentCore Runtime, scoped as tightly as the service allows. ' +
      'Wildcards: (1) `Resource: *` for ecr:GetAuthorizationToken, X-Ray and cloudwatch:PutMetricData, which do not support ' +
      'resource-level permissions (the metric statement is limited by a namespace condition); (2) log groups under ' +
      '`/aws/bedrock-agentcore/runtimes/`, whose names contain a runtime id that does not exist until the runtime is created; ' +
      "(3) `log-group:*` for logs:DescribeLogGroups, which AWS documents without a narrower form; (4) the runtime's workload " +
      'identity name prefix. No wildcard grants data access: there is no S3, DynamoDB or IAM permission at all.',
  });

  // ----------------------------------------------------------------- api
  Validations.of(api.api).acknowledge({
    id: 'AwsSolutions-IAM5',
    reason:
      'SERVICE: two prefix wildcards, both narrowest possible. (1) `<docs bucket>/projects/*`: object keys are created by users ' +
      'at upload time. (2) `<runtime arn>/runtime-endpoint/*`: the form AgentCore uses for runtime endpoint ARNs.',
  });

  // ----------------------------------------------------------------- web
  Validations.of(web.web.webBucket.bucket).acknowledge({
    id: 'AwsSolutions-S1',
    reason:
      'COST: the bucket only holds the public web app, is private and readable only by CloudFront. Server access logs would ' +
      'cost more than they reveal.',
  });
  Validations.of(web.web.distribution).acknowledge(
    {
      id: 'AwsSolutions-CFR1',
      reason: 'SCOPE: there is no geographic restriction requirement for a research project.',
    },
    {
      id: 'AwsSolutions-CFR2',
      reason:
        'COST: AWS WAF bills a monthly fee per web ACL and per rule. The API is protected by JWT verification, a per-user daily ' +
        'cap and a budget alert. WAF is listed as hardening in ARCHITECTURE.md.',
    },
    {
      id: 'AwsSolutions-CFR3',
      reason:
        'COST: access logging needs a log bucket and stores every request. Request counts are visible in CloudWatch metrics.',
    },
    {
      id: 'AwsSolutions-CFR4',
      reason:
        'SERVICE: with the default *.cloudfront.net certificate, CloudFront fixes the minimum viewer TLS version at 1.0 and ignores ' +
        'any configured value. Requiring TLS 1.2 needs a custom domain and an ACM certificate, which is out of scope for now ' +
        '(listed in ARCHITECTURE.md). Traffic is still HTTPS-only: HTTP is redirected, and /api/* refuses plain HTTP.',
    },
  );
  acknowledgeHelpers(
    web,
    ['Custom::CDKBucketDeployment'],
    [
      { id: 'AwsSolutions-IAM4', reason: HELPER_ROLE },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'HELPER: the BucketDeployment custom resource (owned by aws-cdk-lib) copies the web app into the bucket. Its policy ' +
          'uses wildcard S3 actions and the asset bucket, scoped to the web bucket and the CDK asset bucket only.',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'HELPER: the runtime of the BucketDeployment Lambda is chosen by aws-cdk-lib, not by this project.',
      },
    ],
  );
}
