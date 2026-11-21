/**
 * api-function.ts  -  the backend API: FastAPI on AWS Lambda, streaming over a Function URL.
 *
 * HOW A REQUEST REACHES IT
 *
 *   browser ──HTTPS──► CloudFront ──/api/*──► Lambda Function URL ──► Lambda Web Adapter ──► FastAPI (port 8080)
 *
 *   The Lambda Web Adapter is a small extension in the container image. It turns each Lambda invocation into a normal HTTP
 *   request to the FastAPI app, so the app is an ordinary web app that also runs locally. The Function URL is configured for
 *   RESPONSE STREAMING (`RESPONSE_STREAM`), so chat answers can be sent token by token as Server-Sent Events.
 *
 * WHY A FUNCTION URL AND NOT API GATEWAY
 *   A Function URL is free and supports streaming, and CloudFront already provides the HTTPS front door. API Gateway would
 *   add a service and a per-request fee. The price of this choice: there is no built-in request throttling or WAF hook, and
 *   the JWT is verified by the application code. Cost controls replace them (per-user daily cap, optional reserved
 *   concurrency, a budget alert). Bring API Gateway back if you need usage plans or WAF integration.
 *
 * THE URL IS PUBLIC, THE API IS NOT
 *   The Function URL uses auth type NONE, so anyone who finds it can call it. Every route except `/api/health` rejects a request
 *   that has no valid Cognito JWT, and each route checks that the user owns the project it touches.
 *
 * WHY A CONTAINER IMAGE
 *   FastAPI needs third-party packages. A zip would require bundling them at synth time, which needs Docker on every machine
 *   that runs `cdk synth`. An image is built only at deploy time, so synth and the unit tests need no Docker.
 *
 * LEAST PRIVILEGE (the role can do exactly this)
 *   - DynamoDB: item and query calls on the one table.
 *   - S3: get, put and delete on `projects/*` of the documents bucket. (Put is required to SIGN presigned uploads.)
 *   - Bedrock: `Retrieve`, `GetKnowledgeBaseDocuments`, `DeleteKnowledgeBaseDocuments` on the one Knowledge Base, and
 *     `InvokeAgentRuntime` on the one runtime. No model access: only the agent talks to models.
 *
 * TRAPS
 *   - The Function URL timeout is the Lambda timeout, not CloudFront's. CloudFront waits at most 60 s for the next byte, so
 *     the app sends a keep-alive line immediately when a stream starts.
 *   - Reserved concurrency fails to deploy on accounts whose total Lambda quota is below 100. It is optional here.
 *   - Routes live under `/api`, because CloudFront forwards the path unchanged.
 */
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { ApiFunctionProps } from '../props/api-props';
import { createLogOnlyRole } from './lambda-log-role';

export class ApiFunction extends Construct {
  public readonly function: lambda.DockerImageFunction;
  public readonly functionUrl: lambda.FunctionUrl;

  constructor(scope: Construct, id: string, props: ApiFunctionProps) {
    super(scope, id);
    const { limits } = props;

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: props.logRetention,
      removalPolicy: props.removalPolicy === RemovalPolicy.RETAIN ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.function = new lambda.DockerImageFunction(this, 'Function', {
      functionName: props.name,
      description: 'FastAPI backend: projects, documents, chats and streamed answers.',
      code: lambda.DockerImageCode.fromImageAsset(props.sourceDir, { platform: ecrAssets.Platform.LINUX_ARM64 }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(2),
      reservedConcurrentExecutions: props.reservedConcurrency,
      environment: {
        // Lambda Web Adapter: stream responses and wait for FastAPI before accepting traffic.
        AWS_LWA_INVOKE_MODE: 'response_stream',
        AWS_LWA_PORT: '8080',
        AWS_LWA_READINESS_CHECK_PATH: '/api/health',
        // What the app needs to find its AWS dependencies.
        TABLE_NAME: props.table.tableName,
        DOCS_BUCKET: props.docsBucket.bucketName,
        DOCS_PREFIX: props.docsPrefix,
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        DATA_SOURCE_ID: props.dataSourceId,
        AGENT_RUNTIME_ARN: props.agentRuntimeArn,
        // How the app verifies the caller's JWT.
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        COGNITO_CLIENT_ID: props.userPoolClientId,
        // Application limits (see config/environments.ts).
        MAX_FILE_MB: String(limits.maxFileMb),
        ALLOWED_EXTENSIONS: limits.allowedExtensions.join(','),
        MAX_DOCUMENTS_PER_PROJECT: String(limits.maxDocumentsPerProject),
        MAX_QUESTION_CHARS: String(limits.maxQuestionChars),
        DAILY_QUESTION_CAP: String(limits.dailyQuestionCap),
        HISTORY_MESSAGES: String(limits.historyMessages),
        TOP_K: String(limits.topK),
      },
      logGroup,
      role: createLogOnlyRole(this, 'Role', logGroup),
    });

    this.functionUrl = this.function.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    // ---- least-privilege permissions
    props.table.grant(
      this.function,
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:Query',
      'dynamodb:BatchWriteItem',
    );
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DocumentObjects',
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [props.docsBucket.arnForObjects(`${props.docsPrefix}*`)],
      }),
    );
    // Deleting a project lists its folder first. Listing is limited to the documents prefix.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ListDocuments',
        actions: ['s3:ListBucket'],
        resources: [props.docsBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': [`${props.docsPrefix}*`] } },
      }),
    );
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'KnowledgeBase',
        actions: ['bedrock:Retrieve', 'bedrock:GetKnowledgeBaseDocuments', 'bedrock:DeleteKnowledgeBaseDocuments'],
        resources: [props.knowledgeBaseArn],
      }),
    );
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvokeChatAgent',
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [props.agentRuntimeArn, `${props.agentRuntimeArn}/runtime-endpoint/*`],
      }),
    );
  }
}
