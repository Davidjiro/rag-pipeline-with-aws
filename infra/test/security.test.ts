/**
 * security.test.ts  -  properties that must never regress: no public data, least-privilege IAM, tenant isolation inputs.
 */
import { Match } from 'aws-cdk-lib/assertions';
import { asArray, buildApp, iamStatements, StackKey } from './helpers';

const app = buildApp('dev');
const STACKS: StackKey[] = ['auth', 'data', 'knowledge', 'agent', 'api', 'web'];

describe('S3 buckets', () => {
  const bucketStacks: StackKey[] = ['knowledge', 'web'];

  test.each(bucketStacks)('%s: every bucket blocks all public access and is encrypted', (key) => {
    const buckets = Object.values(app.template(key).findResources('AWS::S3::Bucket'));
    expect(buckets.length).toBeGreaterThan(0);
    for (const bucket of buckets) {
      const props = (bucket as any).Properties;
      expect(props.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(
        props.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm,
      ).toBe('AES256');
    }
  });

  test.each(bucketStacks)('%s: a bucket policy denies requests that do not use TLS', (key) => {
    app.template(key).hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        ]),
      },
    });
  });

  test('the documents bucket allows browser uploads (POST) from the configured origin only', () => {
    app.template('knowledge').hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [Match.objectLike({ AllowedMethods: ['POST'], AllowedOrigins: ['https://*.cloudfront.net'] })],
      },
    });
  });

  test('incomplete multipart uploads are cleaned up (they bill silently otherwise)', () => {
    app.template('knowledge').hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }, Status: 'Enabled' })],
      },
    });
  });
});

describe('IAM', () => {
  test.each(STACKS)('%s: no statement allows every action', (key) => {
    for (const statement of iamStatements(app.template(key))) {
      for (const action of asArray(statement.Action)) {
        expect(action).not.toBe('*');
      }
    }
  });

  test('the agent role has no access to S3, S3 Vectors, DynamoDB, IAM or KMS', () => {
    const actions = iamStatements(app.template('agent')).flatMap((s) => asArray<string>(s.Action));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).not.toMatch(/^(s3|s3vectors|dynamodb|iam|kms|sts):/);
    }
  });

  test('the agent can call Bedrock only through the three-part global-profile policy', () => {
    const statements = iamStatements(app.template('agent')).filter((s) =>
      asArray<string>(s.Action).includes('bedrock:InvokeModel'),
    );
    expect(statements).toHaveLength(3);
    const conditions = statements.map((s) => JSON.stringify(s.Condition));
    expect(conditions.some((c) => c.includes('"aws:RequestedRegion":"unspecified"'))).toBe(true);
    expect(conditions.every((c) => c.includes('aws:RequestedRegion'))).toBe(true);
    // The model resources never use a bare wildcard.
    for (const statement of statements) {
      for (const resource of asArray(statement.Resource)) {
        expect(JSON.stringify(resource)).not.toBe('"*"');
        expect(JSON.stringify(resource)).toContain('claude-haiku');
      }
    }
  });

  test('the agent can only retrieve from, and apply, its own Knowledge Base and guardrail', () => {
    const statements = iamStatements(app.template('agent'));
    for (const action of ['bedrock:Retrieve', 'bedrock:ApplyGuardrail']) {
      const matching = statements.filter((s) => asArray<string>(s.Action).includes(action));
      expect(matching).toHaveLength(1);
      expect(asArray(matching[0].Resource)).toHaveLength(1);
      expect(JSON.stringify(matching[0].Resource)).not.toBe('"*"');
    }
  });

  test('the agent execution role trusts AgentCore only, for this account only', () => {
    app.template('agent').hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
            Condition: { StringEquals: Match.anyValue(), ArnLike: Match.anyValue() },
          }),
        ],
      },
    });
  });

  test('the Knowledge Base role trusts Bedrock only, for knowledge bases of this account only', () => {
    app.template('knowledge').hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'bedrock.amazonaws.com' },
            Condition: { StringEquals: Match.anyValue(), ArnLike: Match.anyValue() },
          }),
        ],
      },
    });
  });

  test('the API role cannot invoke models directly: only the agent talks to models', () => {
    const actions = iamStatements(app.template('api')).flatMap((s) => asArray<string>(s.Action));
    expect(actions.some((a) => a.startsWith('bedrock:InvokeModel'))).toBe(false);
    expect(actions).toContain('bedrock-agentcore:InvokeAgentRuntime');
  });

  test('the API may touch S3 objects only under the documents prefix', () => {
    const statement = iamStatements(app.template('api')).find((s) =>
      asArray<string>(s.Action).includes('s3:PutObject'),
    )!;
    expect(JSON.stringify(statement.Resource)).toContain('/projects/*');
    expect(asArray<string>(statement.Action).sort()).toEqual(['s3:DeleteObject', 's3:GetObject', 's3:PutObject']);
  });

  test('the API may list the bucket only under the documents prefix', () => {
    const statement = iamStatements(app.template('api')).find((s) =>
      asArray<string>(s.Action).includes('s3:ListBucket'),
    )!;
    expect(asArray<string>(statement.Action)).toEqual(['s3:ListBucket']);
    expect(statement.Condition).toEqual({ StringLike: { 's3:prefix': ['projects/*'] } });
  });

  test('the ingest role can only start ingestion, update document items, and write its own logs', () => {
    const policies = app.template('knowledge').findResources('AWS::IAM::Policy');
    const ingest = Object.entries(policies).find(([id]) => id.startsWith('IngestFunction'));
    expect(ingest).toBeDefined();
    const statements = asArray<any>((ingest![1] as any).Properties.PolicyDocument.Statement);
    const actions = statements.flatMap((s) => asArray<string>(s.Action)).sort();
    expect(actions).toEqual([
      'bedrock:IngestKnowledgeBaseDocuments',
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
      'logs:CreateLogStream',
      'logs:PutLogEvents',
    ]);
    // Logs are limited to the function's own log group, not `log-group:*`.
    const logs = statements.find((s) => asArray<string>(s.Action).includes('logs:PutLogEvents'));
    expect(JSON.stringify(logs.Resource)).toContain('IngestFunctionLogs');
  });
});

describe('API exposure', () => {
  test('the Function URL is public but can be reached only through the URL, not by direct cross-account invoke', () => {
    app.template('api').hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: '*',
      InvokedViaFunctionUrl: true,
    });
  });

  test('no resource policy lets anyone invoke the ingest function except S3 for this bucket', () => {
    const permissions = Object.values(app.template('knowledge').findResources('AWS::Lambda::Permission'));
    const ingest = permissions.filter((p: any) => p.Properties.Action === 'lambda:InvokeFunction');
    expect(ingest).toHaveLength(1);
    expect((ingest[0] as any).Properties.Principal).toBe('s3.amazonaws.com');
    expect((ingest[0] as any).Properties.SourceArn).toBeDefined();
  });
});

describe('sign-in', () => {
  test('the user pool is invite-only', () => {
    app.template('auth').hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    });
  });

  test('the web client has no secret, uses SRP only, and has OAuth off', () => {
    app.template('auth').hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
    });
    const client = Object.values(app.template('auth').findResources('AWS::Cognito::UserPoolClient'))[0] as any;
    expect(client.Properties.AllowedOAuthFlows).toBeUndefined();
  });

  test('passwords are at least 12 characters with all character classes', () => {
    app.template('auth').hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 12,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        }),
      },
    });
  });
});
