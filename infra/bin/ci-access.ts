#!/usr/bin/env node
/**
 * ci-access.ts  -  a SEPARATE CDK app with one stack: the role GitHub Actions assumes to deploy, test and destroy `dev`.
 *
 * Deploy it once, by hand, with your own credentials:
 *
 *   npx cdk -a "npx ts-node --prefer-ts-exts bin/ci-access.ts" deploy -c githubRepo=<owner>/<repo> \
 *     -c githubOwnerId=<owner.id> -c githubRepoId=<id>     # from: curl -s https://api.github.com/repos/<owner>/<repo>
 *
 * Optional context: -c branch=<name> (default main), -c existingOidcProviderArn=<arn> if the account already has a GitHub
 * OIDC provider. Remove access with the same command and `destroy`.
 */
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ENVIRONMENTS } from '../lib/config/environments';
import { CiAccessStack } from '../lib/stacks/ci-access-stack';

const app = new App();
const githubRepo = app.node.tryGetContext('githubRepo');
if (!githubRepo) throw new Error('Pass the repository: -c githubRepo=<owner>/<repo>');

const stack = new CiAccessStack(app, 'kc-ci-github-access', {
  env: { account: ENVIRONMENTS.dev.account, region: ENVIRONMENTS.dev.region },
  description: 'Bedrock Knowledge Chat: GitHub Actions OIDC role for the dev deploy test',
  githubRepo,
  githubOwnerId: app.node.tryGetContext('githubOwnerId'),
  githubRepoId: app.node.tryGetContext('githubRepoId'),
  branch: app.node.tryGetContext('branch'),
  existingOidcProviderArn: app.node.tryGetContext('existingOidcProviderArn'),
});

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
Validations.of(stack.role).acknowledge({
  id: 'AwsSolutions-IAM5',
  reason:
    'SCOPE: every wildcard is a name pattern limited to dev resources (kc-dev-*, kc_dev_*) or the CDK bootstrap roles, or ' +
    '`*` for the three actions that have no resource-level permissions (ValidateTemplate, ListStacks, DescribeLogGroups). ' +
    'Knowledge Base and user pool ids are random, so their two read-only actions use `*` ids; Cognito admin calls are ' +
    'limited by tag to the dev user pool.',
});
