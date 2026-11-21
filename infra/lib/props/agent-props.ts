/**
 * agent-props.ts  -  inputs of the agent building blocks.
 */

/** Bedrock Guardrail that screens what users type before it reaches the model. */
export interface ChatGuardrailProps {
  readonly name: string;
  /** Text returned when the guardrail blocks an input. */
  readonly blockedMessage: string;
}

/** AgentCore Runtime: the managed, serverless host of the chat agent container. */
export interface ChatAgentRuntimeProps {
  /** Underscore name, see `agentName()` in config/environments.ts. */
  readonly name: string;
  readonly description: string;
  /** Folder with the Dockerfile. CDK builds it for linux/arm64 and pushes it to ECR. */
  readonly sourceDir: string;

  /** Inference profile id the agent calls, for example `global.anthropic.claude-haiku-4-5-20251001-v1:0`. */
  readonly modelProfileId: string;
  /** The model behind the profile, for example `anthropic.claude-haiku-4-5-20251001-v1:0`. */
  readonly baseModelId: string;

  readonly knowledgeBaseId: string;
  readonly knowledgeBaseArn: string;
  readonly guardrailId: string;
  readonly guardrailArn: string;
  readonly guardrailVersion: string;

  /** Chunks retrieved per question. */
  readonly topK: number;
  /** Cap on the length of an answer, in tokens. */
  readonly maxOutputTokens: number;

  /** Seconds an idle session is kept (service default 900, minimum 60). Memory is billed while idle. */
  readonly idleSessionTimeoutSeconds: number;
  /** Hard cap on one session, in seconds (service default 28800). */
  readonly maxLifetimeSeconds: number;
}
