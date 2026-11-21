/**
 * agent-stack.ts  -  the chat agent: a guardrail and the AgentCore runtime that hosts the agent container.
 *
 * Changes often (new agent code means a new image and a new runtime version), unlike the Knowledge stack.
 * The runtime receives the Knowledge Base and guardrail ids as environment variables, so CDK creates those first.
 */
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { agentRuntimeConfig, guardrailConfig } from '../config/agent.config';
import { EnvironmentConfig } from '../config/environments';
import { ChatAgentRuntime } from '../constructs/chat-agent-runtime';
import { ChatGuardrail } from '../constructs/chat-guardrail';
import { KnowledgeStack } from './knowledge-stack';

export interface AgentStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly knowledge: KnowledgeStack;
}

export class AgentStack extends Stack {
  public readonly runtime: ChatAgentRuntime;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);
    const env = props.config;

    const guardrail = new ChatGuardrail(this, 'Guardrail', guardrailConfig(env));

    this.runtime = new ChatAgentRuntime(this, 'Runtime', {
      ...agentRuntimeConfig(env),
      knowledgeBaseId: props.knowledge.knowledgeBase.knowledgeBaseId,
      knowledgeBaseArn: props.knowledge.knowledgeBase.knowledgeBaseArn,
      guardrailId: guardrail.guardrailId,
      guardrailArn: guardrail.guardrailArn,
      guardrailVersion: guardrail.guardrailVersion,
    });

    new CfnOutput(this, 'AgentRuntimeArn', { value: this.runtime.runtimeArn });
    new CfnOutput(this, 'AgentRuntimeId', { value: this.runtime.runtimeId });
    new CfnOutput(this, 'GuardrailId', { value: guardrail.guardrailId });
    new CfnOutput(this, 'GuardrailVersion', { value: guardrail.guardrailVersion });
  }
}
