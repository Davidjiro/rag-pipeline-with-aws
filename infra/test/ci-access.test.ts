/**
 * The GitHub Actions role is the most powerful thing in this repository: it can deploy. These tests pin who may assume it
 * and keep every permission inside the dev resource names.
 */
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CiAccessStack } from '../lib/stacks/ci-access-stack';

const env = { account: '123456789012', region: 'us-east-1' };

function synth(props: Partial<ConstructorParameters<typeof CiAccessStack>[2]> = {}) {
  const app = new App();
  const stack = new CiAccessStack(app, 'ci', { env, githubRepo: 'owner/repo', ...props });
  return Template.fromStack(stack);
}

function statements(template: Template): any[] {
  const policy = Object.values(template.findResources('AWS::IAM::Policy'))[0] as any;
  return policy.Properties.PolicyDocument.Statement;
}

const asArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

test('only one repository and one branch can assume the role, with the STS audience', () => {
  const role = Object.values(synth().findResources('AWS::IAM::Role'))[0] as any;
  const [statement, ...rest] = role.Properties.AssumeRolePolicyDocument.Statement;
  expect(rest).toHaveLength(0);
  expect(statement.Action).toBe('sts:AssumeRoleWithWebIdentity');
  expect(statement.Condition).toEqual({
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': 'repo:owner/repo:ref:refs/heads/main',
    },
  });
});

test('a different branch can be chosen, and a malformed repository is refused at synth time', () => {
  const role = Object.values(synth({ branch: 'release' }).findResources('AWS::IAM::Role'))[0] as any;
  expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).toContain('repo:owner/repo:ref:refs/heads/release');
  expect(() => synth({ githubRepo: 'owner/repo:ref:*' })).toThrow(/owner\/name/);
  expect(() => synth({ githubRepo: '*' })).toThrow(/owner\/name/);
});

test('creates the OIDC provider unless an existing one is passed', () => {
  synth().resourceCountIs('AWS::IAM::OIDCProvider', 1);
  synth({
    existingOidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
  }).resourceCountIs('AWS::IAM::OIDCProvider', 0);
});

test('no wildcard actions and no IAM permissions except assuming the CDK bootstrap roles', () => {
  for (const s of statements(synth())) {
    for (const action of asArray<string>(s.Action)) {
      expect(action).not.toContain('*');
      if (action.startsWith('iam:')) throw new Error(`unexpected IAM permission ${action}`);
      if (action === 'sts:AssumeRole')
        expect(JSON.stringify(s.Resource)).toContain(':role/cdk-hnb659fds-*-123456789012-us-east-1');
    }
  }
});

test('every resource is a dev name pattern, the CDK roles or repository, or `*` only where AWS allows nothing narrower', () => {
  const STAR_ALLOWED = new Set([
    'cloudformation:ValidateTemplate',
    'cloudformation:ListStacks',
    'logs:DescribeLogGroups',
  ]);
  for (const s of statements(synth())) {
    for (const resource of asArray<unknown>(s.Resource)) {
      const text = JSON.stringify(resource);
      if (text === '"*"') {
        for (const action of asArray<string>(s.Action)) expect(STAR_ALLOWED.has(action)).toBe(true);
        continue;
      }
      const ok = /kc-dev-|kc_dev_|cdk-hnb659fds-|knowledge-base\/\*|userpool\/\*/.test(text);
      expect({ sid: s.Sid, resource: text, ok }).toEqual({ sid: s.Sid, resource: text, ok: true });
      expect(text).not.toMatch(/kc-prod|kc_prod/);
    }
  }
});

test('Cognito admin actions are limited by tag to the dev user pool', () => {
  const admin = statements(synth()).find((s) => asArray<string>(s.Action).includes('cognito-idp:AdminCreateUser'));
  expect(admin.Condition).toEqual({
    StringEquals: { 'aws:ResourceTag/Project': 'bedrock-knowledge-chat', 'aws:ResourceTag/Environment': 'dev' },
  });
});
