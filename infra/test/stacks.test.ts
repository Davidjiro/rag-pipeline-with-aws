/**
 * stacks.test.ts  -  the configuration of each stack: what the design says must be true of the deployed resources.
 */
import { Match } from 'aws-cdk-lib/assertions';
import { ENVIRONMENTS } from '../lib/config/environments';
import { asArray, buildApp } from './helpers';

const app = buildApp('dev');

describe('data stack', () => {
  test('one on-demand table with PK and SK, TTL, and no point-in-time recovery in dev', () => {
    app.template('data').resourceCountIs('AWS::DynamoDB::Table', 1);
    app.template('data').hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      DeletionProtectionEnabled: false,
    });
  });

  test('prod keeps its data: point-in-time recovery and deletion protection on, table retained', () => {
    const prod = buildApp('prod');
    prod.template('data').hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      DeletionProtectionEnabled: true,
    });
    prod.template('data').hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  });

  test('no budget is created without an e-mail address (an alert with no recipient is useless)', () => {
    app.template('data').resourceCountIs('AWS::Budgets::Budget', 0);
  });
});

describe('knowledge stack', () => {
  const template = app.template('knowledge');

  test('the vector index dimension equals the embedding dimension, with cosine distance', () => {
    template.hasResourceProperties('AWS::S3Vectors::Index', {
      Dimension: ENVIRONMENTS.dev.embeddingDimensions,
      DataType: 'float32',
      DistanceMetric: 'cosine',
    });
    template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
      KnowledgeBaseConfiguration: {
        VectorKnowledgeBaseConfiguration: Match.objectLike({
          EmbeddingModelConfiguration: {
            BedrockEmbeddingModelConfiguration: {
              Dimensions: ENVIRONMENTS.dev.embeddingDimensions,
              EmbeddingDataType: 'FLOAT32',
            },
          },
        }),
      },
    });
  });

  test('the Bedrock-managed metadata keys are non-filterable (otherwise realistic chunks fail to ingest)', () => {
    template.hasResourceProperties('AWS::S3Vectors::Index', {
      MetadataConfiguration: { NonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'] },
    });
  });

  test('the Knowledge Base uses S3 Vectors and a single S3 data source limited to the projects/ prefix', () => {
    template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
      StorageConfiguration: Match.objectLike({ Type: 'S3_VECTORS' }),
    });
    template.resourceCountIs('AWS::Bedrock::DataSource', 1);
    template.hasResourceProperties('AWS::Bedrock::DataSource', {
      DataSourceConfiguration: { Type: 'S3', S3Configuration: Match.objectLike({ InclusionPrefixes: ['projects/'] }) },
      DataDeletionPolicy: 'DELETE',
      VectorIngestionConfiguration: {
        ChunkingConfiguration: {
          ChunkingStrategy: 'FIXED_SIZE',
          FixedSizeChunkingConfiguration: { MaxTokens: 300, OverlapPercentage: 20 },
        },
      },
    });
  });

  test('uploads under projects/ trigger the ingest function, and nothing else does', () => {
    template.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          Match.objectLike({
            Events: ['s3:ObjectCreated:*'],
            Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'projects/' }] } },
          }),
        ],
      },
    });
  });

  test('the ingest function is Python on arm64, with bounded retries and the ids it needs', () => {
    const functions = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
    const ingest = functions.find((f) => f.Properties.FunctionName === 'kc-dev-ingest');
    expect(ingest.Properties.Runtime).toBe('python3.15');
    expect(ingest.Properties.Architectures).toEqual(['arm64']);
    expect(Object.keys(ingest.Properties.Environment.Variables).sort()).toEqual([
      'DATA_SOURCE_ID',
      'KNOWLEDGE_BASE_ID',
      'TABLE_NAME',
    ]);
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 2,
      MaximumEventAgeInSeconds: 3600,
    });
  });

  test('document storage is not versioned (documents are never overwritten)', () => {
    const bucket = Object.values(template.findResources('AWS::S3::Bucket'))[0] as any;
    expect(bucket.Properties.VersioningConfiguration).toBeUndefined();
  });
});

describe('agent stack', () => {
  const template = app.template('agent');

  test('there is exactly one guardrail rule: the prompt-attack filter on input only', () => {
    template.hasResourceProperties('AWS::Bedrock::Guardrail', {
      ContentPolicyConfig: {
        FiltersConfig: [{ Type: 'PROMPT_ATTACK', InputStrength: 'HIGH', OutputStrength: 'NONE' }],
      },
    });
    const guardrail = Object.values(template.findResources('AWS::Bedrock::Guardrail'))[0] as any;
    expect(guardrail.Properties.SensitiveInformationPolicyConfig).toBeUndefined();
    expect(guardrail.Properties.ContextualGroundingPolicyConfig).toBeUndefined();
    expect(guardrail.Properties.TopicPolicyConfig).toBeUndefined();
  });

  test('the guardrail is pinned to a version whose description carries a configuration hash', () => {
    template.hasResourceProperties('AWS::Bedrock::GuardrailVersion', {
      Description: Match.stringLikeRegexp('^Pinned snapshot, config [0-9a-f]{12}$'),
    });
  });

  test('the runtime: container image, public network, HTTP protocol, short idle timeout, capped lifetime', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'kc_dev_chat_agent',
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      ProtocolConfiguration: 'HTTP',
      LifecycleConfiguration: { IdleRuntimeSessionTimeout: 300, MaxLifetime: 3600 },
      AgentRuntimeArtifact: { ContainerConfiguration: Match.objectLike({ ContainerUri: Match.anyValue() }) },
    });
  });

  test('the runtime receives exactly the configuration the agent code reads, and no secrets', () => {
    const runtime = Object.values(template.findResources('AWS::BedrockAgentCore::Runtime'))[0] as any;
    expect(Object.keys(runtime.Properties.EnvironmentVariables).sort()).toEqual(
      [
        'AWS_REGION',
        'GUARDRAIL_ID',
        'GUARDRAIL_VERSION',
        'KNOWLEDGE_BASE_ID',
        'MAX_OUTPUT_TOKENS',
        'MODEL_ID',
        'TOP_K',
      ].sort(),
    );
    expect(runtime.Properties.EnvironmentVariables.MODEL_ID).toBe(ENVIRONMENTS.dev.modelProfileId);
  });

  test('the cost-driven removals hold: no AgentCore Memory or Gateway', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Memory', 0);
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 0);
  });
});

describe('api stack', () => {
  const template = app.template('api');

  test('a container-image function on arm64, with a streaming public Function URL', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      PackageType: 'Image',
      Architectures: ['arm64'],
      MemorySize: 512,
      Timeout: 120,
    });
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE', InvokeMode: 'RESPONSE_STREAM' });
  });

  test('the Lambda Web Adapter is configured to stream and to wait for the app to be ready', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          AWS_LWA_INVOKE_MODE: 'response_stream',
          AWS_LWA_READINESS_CHECK_PATH: '/api/health',
          AWS_LWA_PORT: '8080',
        }),
      },
    });
  });

  test('every application limit reaches the app as an environment variable', () => {
    const fn = Object.values(template.findResources('AWS::Lambda::Function'))[0] as any;
    const variables = fn.Properties.Environment.Variables;
    const { limits } = ENVIRONMENTS.dev;
    expect(variables).toMatchObject({
      MAX_FILE_MB: String(limits.maxFileMb),
      ALLOWED_EXTENSIONS: limits.allowedExtensions.join(','),
      MAX_DOCUMENTS_PER_PROJECT: String(limits.maxDocumentsPerProject),
      MAX_QUESTION_CHARS: String(limits.maxQuestionChars),
      DAILY_QUESTION_CAP: String(limits.dailyQuestionCap),
      HISTORY_MESSAGES: String(limits.historyMessages),
      TOP_K: String(limits.topK),
      DOCS_PREFIX: 'projects/',
    });
    expect(Object.keys(variables)).toEqual(
      expect.arrayContaining([
        'TABLE_NAME',
        'DOCS_BUCKET',
        'KNOWLEDGE_BASE_ID',
        'AGENT_RUNTIME_ARN',
        'COGNITO_USER_POOL_ID',
        'COGNITO_CLIENT_ID',
      ]),
    );
  });

  test('no reserved concurrency by default, because a new account would fail to deploy with it', () => {
    const fn = Object.values(template.findResources('AWS::Lambda::Function'))[0] as any;
    expect(fn.Properties.ReservedConcurrentExecutions).toBeUndefined();
  });

  test('logs are kept for the configured retention, not forever', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  });
});

describe('web stack', () => {
  const template = app.template('web');

  test('/api/* is never cached, HTTPS only, allows all methods, and is not compressed (so streams are not buffered)', () => {
    const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as any;
    const config = distribution.Properties.DistributionConfig;
    const api = config.CacheBehaviors.find((b: any) => b.PathPattern === '/api/*');
    expect(api.ViewerProtocolPolicy).toBe('https-only');
    expect(api.AllowedMethods).toEqual(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']);
    expect(api.Compress).toBe(false);
    // Managed policies by id: CachingDisabled and AllViewerExceptHostHeader.
    expect(api.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    expect(api.OriginRequestPolicyId).toBe('b689b0a8-53d0-40ab-baf2-68738e2966ac');
  });

  test('single-page-app routing uses a function on the app behaviour, not distribution-wide error pages', () => {
    const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as any;
    const config = distribution.Properties.DistributionConfig;
    expect(config.CustomErrorResponses).toBeUndefined(); // would rewrite real API 404s into the HTML page
    expect(config.DefaultCacheBehavior.FunctionAssociations).toHaveLength(1);
    expect(config.DefaultCacheBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
    expect(config.DefaultRootObject).toBe('index.html');
  });

  test('the cheapest price class and modern HTTP versions', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ PriceClass: 'PriceClass_100', HttpVersion: 'http2and3' }),
    });
  });

  test('the web bucket is read only through Origin Access Control', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    const policies = Object.values(template.findResources('AWS::S3::BucketPolicy')) as any[];
    const grants = policies
      .flatMap((p) => asArray<any>(p.Properties.PolicyDocument.Statement))
      .filter((s) => s.Principal?.Service === 'cloudfront.amazonaws.com');
    expect(grants).toHaveLength(1);
    expect(JSON.stringify(grants[0].Condition)).toContain('AWS:SourceArn');
  });

  test('security headers: HSTS, nosniff, frame denial, referrer policy and a CSP that names Cognito and the documents bucket', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: {
        SecurityHeadersConfig: Match.objectLike({
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: 'DENY', Override: true },
          StrictTransportSecurity: Match.objectLike({ IncludeSubdomains: true, Override: true }),
        }),
      },
    });
    const policy = Object.values(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0] as any;
    const csp = JSON.stringify(
      policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy,
    );
    expect(csp).toContain('cognito-idp');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  test('the app is deployed with a generated runtime config and the cache is invalidated', () => {
    template.resourceCountIs('Custom::CDKBucketDeployment', 1);
    template.hasResourceProperties('Custom::CDKBucketDeployment', { Prune: true, DistributionPaths: ['/*'] });
  });
});
