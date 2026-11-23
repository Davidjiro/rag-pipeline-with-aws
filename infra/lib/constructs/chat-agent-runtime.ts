/**
 * chat-agent-runtime.ts  -  Amazon Bedrock AgentCore Runtime: serverless hosting for the chat agent.
 *
 * WHAT IT IS
 *   You give AgentCore a CONTAINER IMAGE that serves HTTP on port 8080 (`POST /invocations`, `GET /ping`). AgentCore runs
 *   it for you: one isolated microVM per SESSION (here: one per chat), scale to zero when idle, long-running requests,
 *   streaming responses, and the caller is authenticated with IAM (SigV4). The agent code is your choice (plain boto3 over the Bedrock Converse API here)
 *   because AgentCore only cares about the HTTP contract.
 *
 * WHAT THIS CONSTRUCT CREATES
 *   1. A Docker image asset built for linux/arm64 and pushed to ECR by CDK before CloudFormation creates the runtime
 *      (this avoids the "runtime needs an image that does not exist yet" chicken-and-egg problem).
 *   2. The EXECUTION ROLE the agent runs as.
 *   3. The runtime, in PUBLIC network mode: no VPC, no NAT gateway, no VPC endpoints, so no hourly network cost.
 *
 * THE EXECUTION ROLE = THE AGENT'S WHOLE PERMISSION SET
 *   It follows the role AWS documents for AgentCore Runtime ("IAM Permissions for AgentCore Runtime"), tightened where the
 *   documentation uses wildcards:
 *
 *   | Needed for                  | Permission                                                                       |
 *   |-----------------------------|----------------------------------------------------------------------------------|
 *   | pull the image              | ecr:BatchGetImage, GetDownloadUrlForLayer on THIS repository; GetAuthorizationToken |
 *   | logs, traces, metrics       | CloudWatch Logs under /aws/bedrock-agentcore/runtimes/*, X-Ray, PutMetricData (bedrock-agentcore namespace only) |
 *   | runtime identity            | GetWorkloadAccessToken and ...ForJWT for THIS runtime's identity (not ...ForUserId, which AWS advises against) |
 *   | call the chat model         | InvokeModel + InvokeModelWithResponseStream, the three-part policy for a global profile |
 *   | screen the input            | bedrock:ApplyGuardrail on THIS guardrail                                          |
 *   | search the knowledge base   | bedrock:Retrieve on THIS knowledge base                                           |
 *
 *   Note what is missing: no S3, no S3 Vectors, no DynamoDB, no IAM. The agent reads knowledge only through the Knowledge
 *   Base API, and it has no tool that can write anything.
 *
 * THE THREE-PART POLICY FOR A GLOBAL MODEL PROFILE
 *   A `global.` inference profile can route a request to any commercial region, so AWS evaluates three resources:
 *   (1) the profile in your region, (2) the model in your region, and (3) the model with NO region
 *   (`arn:aws:bedrock:::foundation-model/...`), whose evaluation carries `aws:RequestedRegion = unspecified`. All three
 *   are required, or every call fails with AccessDenied. Source: Bedrock user guide, "Global cross-Region inference".
 *
 * COST LEVERS
 *   - `idleSessionTimeoutSeconds`: memory is billed while a session sits idle, CPU is not. The service default is 900 s.
 *   - `maxLifetimeSeconds`: stops a stuck session from billing for hours. The service default is 8 hours.
 *
 * TRAPS
 *   - Runtime names allow letters, digits and underscores only (see `agentName()`).
 *   - Wrong architecture fails at start, not at deploy. The image must be arm64.
 *   - A new image hash updates the runtime and creates a new version. The DEFAULT endpoint follows the latest version.
 *   - Runtime log groups (/aws/bedrock-agentcore/runtimes/...) are created by the service, so CloudFormation cannot set their
 *     retention. Set it once after the first deploy: scripts/set-agent-log-retention.sh.
 */
import { Stack } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { ChatAgentRuntimeProps } from '../props/agent-props';

export class ChatAgentRuntime extends Construct {
  public readonly runtimeArn: string;
  public readonly runtimeId: string;
  public readonly executionRole: iam.Role;

  constructor(scope: Construct, id: string, props: ChatAgentRuntimeProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { region, account } = stack;

    // 1) THE IMAGE: built from agent/Dockerfile and published to the CDK bootstrap ECR repository.
    const image = new ecrAssets.DockerImageAsset(this, 'AgentImage', {
      directory: props.sourceDir,
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    // 2) THE EXECUTION ROLE. Only the AgentCore service may assume it, and only for this account's runtimes.
    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${region}:${account}:*` },
        },
      }),
      description: 'Permissions of the chat agent container.',
    });
    this.executionRole = role;

    // -- image and logs
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrImageAccess',
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: [image.repository.repositoryArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({ sid: 'EcrTokenAccess', actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }),
    );
    const runtimeLogGroups = `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes`;
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeLogGroups',
        actions: ['logs:DescribeLogStreams', 'logs:CreateLogGroup'],
        resources: [`${runtimeLogGroups}/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeLogPolicy',
        actions: ['logs:PutResourcePolicy'],
        resources: [`${runtimeLogGroups}/${props.name}-*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DiscoverLogGroups',
        actions: ['logs:DescribeLogGroups'],
        resources: [`arn:aws:logs:${region}:${account}:log-group:*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteRuntimeLogs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${runtimeLogGroups}/*:log-stream:*`],
      }),
    );
    // X-Ray and metrics do not support resource-level scoping, so the documented `*` is used. The metric statement is
    // narrowed with a namespace condition.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Tracing',
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
        ],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Metrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
      }),
    );

    // -- runtime identity. ForUserId is left out on purpose: AWS advises against it in production.
    const identityDirectory = `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`;
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WorkloadAccessToken',
        actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT'],
        resources: [identityDirectory, `${identityDirectory}/workload-identity/${props.name}-*`],
      }),
    );

    // -- the chat model: the three-part policy for a global inference profile
    const profileArn = `arn:aws:bedrock:${region}:${account}:inference-profile/${props.modelProfileId}`;
    const modelActions = ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'];
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ModelProfileInRegion',
        actions: modelActions,
        resources: [profileArn],
        conditions: { StringEquals: { 'aws:RequestedRegion': region } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ModelInRegion',
        actions: modelActions,
        resources: [`arn:aws:bedrock:${region}::foundation-model/${props.baseModelId}`],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': region, 'bedrock:InferenceProfileArn': profileArn },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ModelGlobalRouting',
        actions: modelActions,
        resources: [`arn:aws:bedrock:::foundation-model/${props.baseModelId}`],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': 'unspecified', 'bedrock:InferenceProfileArn': profileArn },
        },
      }),
    );

    // -- guardrail and knowledge base
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ApplyGuardrail',
        actions: ['bedrock:ApplyGuardrail'],
        resources: [props.guardrailArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RetrieveFromKnowledgeBase',
        actions: ['bedrock:Retrieve'],
        resources: [props.knowledgeBaseArn],
      }),
    );

    // 3) THE RUNTIME.
    const runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: props.name,
      description: props.description,
      roleArn: role.roleArn,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: image.imageUri } },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: props.idleSessionTimeoutSeconds,
        maxLifetime: props.maxLifetimeSeconds,
      },
      // Read by agent/app. Plain configuration, never secrets.
      environmentVariables: {
        AWS_REGION: region,
        MODEL_ID: props.modelProfileId,
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        GUARDRAIL_ID: props.guardrailId,
        GUARDRAIL_VERSION: props.guardrailVersion,
        TOP_K: String(props.topK),
        MAX_OUTPUT_TOKENS: String(props.maxOutputTokens),
      },
    });
    // The role is already referenced by the runtime. What must exist BEFORE the runtime is the policy attached to it, because
    // AgentCore checks the role's permissions (for example image pull) when the runtime is created.
    const rolePolicy = role.node.tryFindChild('DefaultPolicy');
    if (rolePolicy) runtime.node.addDependency(rolePolicy);

    this.runtimeArn = runtime.attrAgentRuntimeArn;
    this.runtimeId = runtime.attrAgentRuntimeId;
  }
}
