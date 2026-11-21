/**
 * api-stack.ts  -  the backend API.
 *
 * One Lambda (FastAPI + Lambda Web Adapter) behind a streaming Function URL. It is the only component that talks to the
 * table, the documents bucket, the Knowledge Base APIs and the agent, so it is where project ownership is enforced.
 *
 * Depends on every earlier stack: the user pool (JWT), the table, the documents bucket and Knowledge Base, and the agent.
 */
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { apiConfig } from '../config/api.config';
import { EnvironmentConfig } from '../config/environments';
import { ApiFunction } from '../constructs/api-function';
import { AgentStack } from './agent-stack';
import { AuthStack } from './auth-stack';
import { KnowledgeStack } from './knowledge-stack';

export interface ApiStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly auth: AuthStack;
  readonly table: dynamodb.ITable;
  readonly knowledge: KnowledgeStack;
  readonly agent: AgentStack;
}

export class ApiStack extends Stack {
  public readonly api: ApiFunction;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    this.api = new ApiFunction(this, 'Api', {
      ...apiConfig(props.config),
      table: props.table,
      docsBucket: props.knowledge.docsBucket,
      knowledgeBaseId: props.knowledge.knowledgeBase.knowledgeBaseId,
      dataSourceId: props.knowledge.knowledgeBase.dataSourceId,
      knowledgeBaseArn: props.knowledge.knowledgeBase.knowledgeBaseArn,
      agentRuntimeArn: props.agent.runtime.runtimeArn,
      userPool: props.auth.pool.userPool,
      userPoolClientId: props.auth.pool.client.userPoolClientId,
    });

    new CfnOutput(this, 'ApiFunctionUrl', { value: this.api.functionUrl.url });
    new CfnOutput(this, 'ApiFunctionName', { value: this.api.function.functionName });
  }
}
