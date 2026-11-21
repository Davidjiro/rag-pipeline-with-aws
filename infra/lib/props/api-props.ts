/**
 * api-props.ts  -  inputs of the API building block.
 */
import { RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AppLimits } from '../config/environments';

export interface ApiFunctionProps {
  /** Function name, for example `kc-dev-api`. */
  readonly name: string;
  /** Folder with the Dockerfile of the FastAPI app. */
  readonly sourceDir: string;
  readonly table: dynamodb.ITable;
  readonly docsBucket: s3.IBucket;
  /** Key prefix the API may read, write and delete in the docs bucket, for example `projects/`. */
  readonly docsPrefix: string;
  readonly knowledgeBaseId: string;
  /** Required by the document status and delete calls, which address a document by data source. */
  readonly dataSourceId: string;
  readonly knowledgeBaseArn: string;
  readonly agentRuntimeArn: string;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClientId: string;
  /** Application limits, passed to the app as environment variables. */
  readonly limits: AppLimits;
  /** Leave undefined unless the account quota allows it (see config/environments.ts). */
  readonly reservedConcurrency?: number;
  readonly logRetention: logs.RetentionDays;
  readonly removalPolicy: RemovalPolicy;
}
