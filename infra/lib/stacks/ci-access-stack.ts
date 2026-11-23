/**
 * ci-access-stack.ts  -  lets ONE GitHub repository's `main` branch deploy, test and destroy the `dev` stacks. Nothing else.
 *
 * Deployed once, by a person, with their own credentials (see infra/README.md, "CI deploy test"). It is a separate CDK app
 * (bin/ci-access.ts), so `cdk deploy "kc-dev-*"` and teardown never touch it.
 *
 * HOW GITHUB GETS IN, WITHOUT STORED KEYS
 *   GitHub signs a short-lived OIDC token for each workflow run that says which repository and branch it belongs to. AWS checks
 *   the signature against the OIDC provider below and, if the trust conditions match, issues temporary credentials for the role.
 *   Nothing secret is kept in GitHub: the role ARN is not a credential.
 *
 * WHAT THE ROLE MAY DO
 *   - Deploy and destroy: only by assuming the roles `cdk bootstrap` created (deploy, file and image publishing, lookup). Those are
 *     what `cdk deploy` uses anyway; this role adds no CloudFormation or resource permissions of its own.
 *   - Everything the test scripts call directly, limited to `dev` resource names (`kc-dev-*`, `kc_dev_*`). Prod names never match.
 *   - Cognito admin calls (create and delete the test users) only on user pools tagged Project=bedrock-knowledge-chat and
 *     Environment=dev, because pool ids are random and cannot be named in a policy.
 *   It has no IAM, no wildcard actions and no access to other projects in the account.
 */
import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';

export interface CiAccessStackProps extends StackProps {
  /** `owner/name` of the GitHub repository allowed to assume the role. */
  readonly githubRepo: string;
  /**
   * GitHub's numeric ids of the owner and the repository. GitHub puts them in the token's `sub`
   * (`repo:<owner>@<ownerId>/<repo>@<repoId>:ref:...`) for repositories that use the immutable-id format, which this one does
   * (found on the first run). With them, a repository deleted and re-created under the same name is refused.
   * Find them with: curl -s https://api.github.com/repos/<owner>/<repo>  (fields `owner.id` and `id`).
   */
  readonly githubOwnerId?: string;
  readonly githubRepoId?: string;
  /** Branch allowed to assume the role. Default `main`. */
  readonly branch?: string;
  /** ARN of an existing GitHub OIDC provider in the account. An account can hold only one per URL; omit to create it. */
  readonly existingOidcProviderArn?: string;
}

export class CiAccessStack extends Stack {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: CiAccessStackProps) {
    super(scope, id, props);
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(props.githubRepo)) {
      throw new Error(`githubRepo must look like "owner/name", got "${props.githubRepo}"`);
    }
    const branch = props.branch ?? 'main';
    if (Boolean(props.githubOwnerId) !== Boolean(props.githubRepoId)) {
      throw new Error('Pass both githubOwnerId and githubRepoId, or neither');
    }
    for (const id of [props.githubOwnerId, props.githubRepoId]) {
      if (id !== undefined && !/^\d{1,20}$/.test(id)) throw new Error(`GitHub ids are numbers, got "${id}"`);
    }
    const [owner, repo] = props.githubRepo.split('/');
    const subject = props.githubOwnerId
      ? `repo:${owner}@${props.githubOwnerId}/${repo}@${props.githubRepoId}:ref:refs/heads/${branch}`
      : `repo:${props.githubRepo}:ref:refs/heads/${branch}`;
    const { account, region } = this;

    const provider = props.existingOidcProviderArn
      ? iam.OidcProviderNative.fromOidcProviderArn(this, 'GitHubOidc', props.existingOidcProviderArn)
      : new iam.OidcProviderNative(this, 'GitHubOidc', { url: GITHUB_OIDC_URL, clientIds: ['sts.amazonaws.com'] });

    this.role = new iam.Role(this, 'DeployTestRole', {
      roleName: 'kc-ci-github-deploy-test',
      description: `GitHub Actions (${props.githubRepo}, ${branch}): deploy, test and destroy the kc-dev stacks`,
      maxSessionDuration: Duration.hours(2), // deploy + tests + teardown take about 30 minutes; this leaves room for slow runs
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          // Exact match: one repository, one branch. Pull requests and forks get a different `sub` and are refused.
          'token.actions.githubusercontent.com:sub': subject,
        },
      }),
    });

    const arn = (service: string, resource: string) => `arn:aws:${service}:${region}:${account}:${resource}`;
    const allow = (sid: string, actions: string[], resources: string[], conditions?: Record<string, unknown>) =>
      this.role.addToPolicy(new iam.PolicyStatement({ sid, actions, resources, conditions }));

    // cdk deploy / destroy: assume the bootstrap roles, nothing more.
    allow(
      'UseCdkBootstrapRoles',
      ['sts:AssumeRole'],
      [`arn:aws:iam::${account}:role/cdk-hnb659fds-*-${account}-${region}`],
    );

    // verify.sh layer 6. ValidateTemplate has no resource-level permissions.
    allow('ValidateTemplates', ['cloudformation:ValidateTemplate'], ['*']);
    // Reading stack outputs and status (smoke test, end-to-end test, teardown, the "already deployed" guard).
    allow('ReadDevStacks', ['cloudformation:DescribeStacks'], [arn('cloudformation', 'stack/kc-dev-*/*')]);
    allow('ListStacks', ['cloudformation:ListStacks'], ['*']); // no resource-level permissions

    // Smoke test and end-to-end test.
    allow(
      'InvokeDevAgent',
      ['bedrock-agentcore:InvokeAgentRuntime'],
      [arn('bedrock-agentcore', 'runtime/kc_dev_*'), arn('bedrock-agentcore', 'runtime/kc_dev_*/runtime-endpoint/*')],
    );
    allow(
      'ReadKnowledgeBaseStatus',
      ['bedrock:GetKnowledgeBase', 'bedrock:GetDataSource'],
      [arn('bedrock', 'knowledge-base/*')],
    );
    allow('ReadDevFunctions', ['lambda:GetFunctionConfiguration'], [arn('lambda', 'function:kc-dev-*')]);
    allow('ReadDevLogs', ['logs:FilterLogEvents'], [arn('logs', 'log-group:kc-dev-*')]);
    allow(
      'SmokeTestObject',
      ['s3:PutObject', 's3:DeleteObject'],
      ['arn:aws:s3:::kc-dev-knowledge-*/projects/smoke-test/*'],
    );
    allow('ListDevDocuments', ['s3:ListBucket'], ['arn:aws:s3:::kc-dev-knowledge-*']);
    allow('ReadUserPool', ['cognito-idp:DescribeUserPool'], [arn('cognito-idp', 'userpool/*')]);
    allow(
      'ManageTestUsers',
      ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminDeleteUser'],
      [arn('cognito-idp', 'userpool/*')],
      { StringEquals: { 'aws:ResourceTag/Project': 'bedrock-knowledge-chat', 'aws:ResourceTag/Environment': 'dev' } },
    );

    // Teardown: remove the log groups AgentCore and the CDK helper Lambdas create outside CloudFormation.
    allow('FindLogGroups', ['logs:DescribeLogGroups'], ['*']); // no resource-level permissions
    allow(
      'DeleteDevLogGroups',
      ['logs:DeleteLogGroup'],
      [
        arn('logs', 'log-group:/aws/lambda/kc-dev-*'),
        arn('logs', 'log-group:/aws/bedrock-agentcore/runtimes/kc_dev_*'),
      ],
    );
    allow(
      'ReadCdkImages',
      ['ecr:DescribeImages'],
      [arn('ecr', `repository/cdk-hnb659fds-container-assets-${account}-${region}`)],
    );

    new CfnOutput(this, 'RoleArn', {
      value: this.role.roleArn,
      description:
        'Set this as the AWS_ROLE_ARN variable of the GitHub repository (Settings > Secrets and variables > Actions > Variables)',
    });
  }
}
