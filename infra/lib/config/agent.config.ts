/**
 * agent.config.ts  -  VALUES for the agent layer (guardrail and AgentCore runtime).
 */
import { ChatAgentRuntimeProps, ChatGuardrailProps } from '../props/agent-props';
import { agentName, baseModelId, EnvironmentConfig, resourceName } from './environments';
import { PATHS } from './paths';

export function guardrailConfig(env: EnvironmentConfig): ChatGuardrailProps {
  return {
    name: resourceName(env, 'guardrail'),
    blockedMessage: 'This message was blocked by a safety check. Please rephrase your question.',
  };
}

/** The live references (Knowledge Base and guardrail ids) are added by AgentStack. */
export function agentRuntimeConfig(
  env: EnvironmentConfig,
): Pick<
  ChatAgentRuntimeProps,
  | 'name'
  | 'description'
  | 'sourceDir'
  | 'modelProfileId'
  | 'baseModelId'
  | 'topK'
  | 'maxOutputTokens'
  | 'idleSessionTimeoutSeconds'
  | 'maxLifetimeSeconds'
> {
  return {
    name: agentName(env, 'chat_agent'),
    description: 'Answers questions from the Knowledge Base, with citations.',
    sourceDir: PATHS.agentDir,
    modelProfileId: env.modelProfileId,
    baseModelId: baseModelId(env.modelProfileId),
    topK: env.limits.topK,
    maxOutputTokens: env.limits.maxOutputTokens,
    idleSessionTimeoutSeconds: env.agent.idleSessionTimeoutSeconds,
    maxLifetimeSeconds: env.agent.maxLifetimeSeconds,
  };
}
