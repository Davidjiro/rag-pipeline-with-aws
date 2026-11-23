/**
 * environments.ts  -  SINGLE SOURCE OF TRUTH for "what is dev / prod?"
 *
 * Everything that differs between environments, or that you may want to tune, lives here:
 * account and region, the chat model, embedding settings, application limits, cost controls.
 * The other config files (`*.config.ts`) read from this and build the props of each construct.
 *
 * ENVIRONMENT VARIABLES READ HERE (all optional)
 *   CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION   set by the CDK CLI from your credentials
 *   KC_MODEL_PROFILE_ID          chat model inference profile (must start with `global.`)
 *   KC_BUDGET_EMAIL              e-mail for the AWS Budgets alert. No e-mail, no budget is created
 *   KC_BUDGET_USD                monthly budget in US dollars (default 10)
 *   KC_UPLOAD_ORIGIN             browser origin allowed to upload to S3 (default `https://*.cloudfront.net`)
 *   KC_API_RESERVED_CONCURRENCY  reserve Lambda concurrency for the API (see "quota trap" below)
 *   KC_INGEST_RESERVED_CONCURRENCY  same, for the ingest function
 *
 * THE LAMBDA QUOTA TRAP
 *   Reserved concurrency can only be set if the account keeps at least 100 unreserved executions.
 *   A new AWS account has a total quota of 10, so setting it would fail the deployment. For that reason it is
 *   OFF by default. Raise your Lambda concurrency quota in Service Quotas, then set the variables above.
 *   `scripts/preflight.sh` prints your quota.
 *
 * NAMING
 *   `resourceName()` builds hyphenated names (`kc-dev-docs`). AgentCore runtime names allow letters, digits and
 *   underscores only, so use `agentName()` for them. A hyphen fails at deploy time with a cryptic error.
 */
import { RemovalPolicy } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';

export type EnvName = 'dev' | 'prod';

/** Limits enforced by the backend and passed to it as environment variables. Initial values, tune as needed. */
export interface AppLimits {
  /** Largest accepted upload, in megabytes. */
  readonly maxFileMb: number;
  /** File extensions the Knowledge Base parser can read. The API rejects anything else before issuing an upload URL. */
  readonly allowedExtensions: readonly string[];
  /** Documents per project. Bounds ingestion cost and storage. */
  readonly maxDocumentsPerProject: number;
  /** Longest accepted question, in characters. Bounds input tokens and guardrail cost. */
  readonly maxQuestionChars: number;
  /** Questions per user per day. Bounds one account's model spend. */
  readonly dailyQuestionCap: number;
  /** How many previous messages of a chat are sent to the agent. Tokens grow with history. */
  readonly historyMessages: number;
  /** Chunks retrieved per question. */
  readonly topK: number;
  /** Cap on the length of an answer, in tokens. */
  readonly maxOutputTokens: number;
}

export interface EnvironmentConfig {
  readonly name: EnvName;
  /** Undefined only when no credentials are configured: synth still works, with environment-agnostic stacks. */
  readonly account?: string;
  readonly region: string;

  /** dev = DESTROY (everything is removed by `cdk destroy`). prod = RETAIN (stateful resources survive). */
  readonly removalPolicy: RemovalPolicy;
  /** True for prod: termination protection on stacks, deletion protection on the table and user pool. */
  readonly protectedEnvironment: boolean;
  readonly logRetention: logs.RetentionDays;

  /** Inference profile of the chat model, for example `global.amazon.nova-2-lite-v1:0`. */
  readonly modelProfileId: string;
  /** Embedding model used by the Knowledge Base. */
  readonly embeddingModelId: string;
  /** Titan Text v2 supports 256, 512 and 1024. Fixed once the index exists: changing it means a new index. */
  readonly embeddingDimensions: number;
  /** Fixed-size chunking: maximum tokens per chunk. */
  readonly chunkMaxTokens: number;
  /** Fixed-size chunking: percentage of a chunk repeated in the next one. */
  readonly chunkOverlapPercentage: number;

  readonly limits: AppLimits;

  /** AgentCore session lifecycle. Memory is billed while a session sits idle, so keep the idle timeout short. */
  readonly agent: {
    readonly idleSessionTimeoutSeconds: number;
    readonly maxLifetimeSeconds: number;
  };

  /** Optional Lambda reserved concurrency. See "the Lambda quota trap" in the header. */
  readonly reservedConcurrency: {
    readonly api?: number;
    readonly ingest?: number;
  };

  readonly budget: {
    readonly monthlyUsd: number;
    /** No e-mail, no budget resource. */
    readonly email?: string;
  };

  /** Browser origins allowed by the S3 CORS rule on the documents bucket (used by presigned POST uploads). */
  readonly uploadAllowedOrigins: readonly string[];
}

function optionalInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

const DEFAULT_LIMITS: AppLimits = {
  maxFileMb: 20,
  allowedExtensions: ['pdf', 'txt', 'md', 'html', 'docx', 'csv'],
  maxDocumentsPerProject: 25,
  maxQuestionChars: 2000,
  dailyQuestionCap: 50,
  historyMessages: 6,
  topK: 5,
  maxOutputTokens: 1024,
};

function build(name: EnvName, prod: boolean): EnvironmentConfig {
  return {
    name,
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
    removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    protectedEnvironment: prod,
    logRetention: prod ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
    // `global.` profiles are priced about 10% below the US-only profile, see ARCHITECTURE.md section 11.
    // Amazon Nova 2 Lite: needs no per-account use-case form (Anthropic models do), so a fresh account deploys with no manual step.
    modelProfileId: process.env.KC_MODEL_PROFILE_ID ?? 'global.amazon.nova-2-lite-v1:0',
    embeddingModelId: 'amazon.titan-embed-text-v2:0',
    embeddingDimensions: 512,
    chunkMaxTokens: 300,
    chunkOverlapPercentage: 20,
    limits: DEFAULT_LIMITS,
    agent: { idleSessionTimeoutSeconds: 300, maxLifetimeSeconds: 3600 },
    reservedConcurrency: {
      api: optionalInt('KC_API_RESERVED_CONCURRENCY'),
      ingest: optionalInt('KC_INGEST_RESERVED_CONCURRENCY'),
    },
    budget: {
      monthlyUsd: optionalInt('KC_BUDGET_USD') ?? 10,
      email: process.env.KC_BUDGET_EMAIL || undefined,
    },
    uploadAllowedOrigins: [process.env.KC_UPLOAD_ORIGIN ?? 'https://*.cloudfront.net'],
  };
}

export const ENVIRONMENTS: Record<EnvName, EnvironmentConfig> = {
  dev: build('dev', false),
  prod: build('prod', true),
};

/** Hyphenated name, for example `kc-dev-docs`. For S3, Cognito, DynamoDB, Lambda, CloudFront... */
export function resourceName(env: EnvironmentConfig, suffix: string): string {
  return `kc-${env.name}-${suffix}`;
}

/**
 * Underscore name for AgentCore runtimes, for example `kc_dev_chat_agent`.
 * Must match ^[a-zA-Z][a-zA-Z0-9_]{0,47}$. Throws at synth time instead of failing at deploy time.
 */
export function agentName(env: EnvironmentConfig, suffix: string): string {
  const name = `kc_${env.name}_${suffix}`.replace(/-/g, '_');
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(name)) {
    throw new Error(`Invalid AgentCore name "${name}": use letters, digits and underscores, at most 48 characters.`);
  }
  return name;
}

/**
 * The model id behind an inference profile id: `global.amazon.nova-2-lite-v1:0` becomes `amazon.nova-2-lite-v1:0`.
 * Only global profiles are supported, because the IAM policy for them has a specific three-part shape
 * (see constructs/chat-agent-runtime.ts).
 */
export function baseModelId(profileId: string): string {
  if (!profileId.startsWith('global.')) {
    throw new Error(
      `Model profile "${profileId}" is not supported: use a global inference profile (prefix "global."). ` +
        'List yours with: aws bedrock list-inference-profiles',
    );
  }
  return profileId.substring('global.'.length);
}
