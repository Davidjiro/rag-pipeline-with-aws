/**
 * knowledge-stack.ts  -  the document store and the RAG pipeline.
 *
 *   docs bucket (S3) ──ObjectCreated──► ingest Lambda ──IngestKnowledgeBaseDocuments──► Bedrock Knowledge Base ──► S3 Vectors
 *
 * Everything that handles uploaded documents lives in this one stack on purpose. The bucket notification, the function it
 * triggers and the bucket itself must be in the same stack, otherwise CloudFormation reports a circular dependency
 * (the bucket would need the function, and the function would need the bucket's permissions).
 *
 * Changes rarely and holds data, so it is separate from the agent and the API, which change often.
 */
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { EnvironmentConfig, resourceName } from '../config/environments';
import { DOCS_PREFIX, ingestConfig, knowledgeBaseConfig } from '../config/knowledge.config';
import { IngestFunction } from '../constructs/ingest-function';
import { S3VectorKnowledgeBase } from '../constructs/s3-vector-knowledge-base';
import { SecureBucket } from '../constructs/secure-bucket';

export interface KnowledgeStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  /** The application table. Passing it makes CDK deploy the data stack first. */
  readonly table: dynamodb.ITable;
}

export class KnowledgeStack extends Stack {
  public readonly docsBucket: s3.IBucket;
  public readonly docsPrefix = DOCS_PREFIX;
  public readonly knowledgeBase: S3VectorKnowledgeBase;
  public readonly ingest: IngestFunction;

  constructor(scope: Construct, id: string, props: KnowledgeStackProps) {
    super(scope, id, props);
    const env = props.config;

    const docs = new SecureBucket(this, 'DocsBucket', {
      removalPolicy: env.removalPolicy,
      uploadAllowedOrigins: env.uploadAllowedOrigins,
    });
    this.docsBucket = docs.bucket;

    this.knowledgeBase = new S3VectorKnowledgeBase(this, 'KnowledgeBase', {
      ...knowledgeBaseConfig(env),
      docsBucket: docs.bucket,
    });

    this.ingest = new IngestFunction(this, 'IngestFunction', {
      ...ingestConfig(env),
      bucket: docs.bucket,
      table: props.table,
      knowledgeBaseId: this.knowledgeBase.knowledgeBaseId,
      knowledgeBaseArn: this.knowledgeBase.knowledgeBaseArn,
      dataSourceId: this.knowledgeBase.dataSourceId,
    });

    new CfnOutput(this, 'DocsBucketName', { value: docs.bucket.bucketName });
    new CfnOutput(this, 'KnowledgeBaseId', { value: this.knowledgeBase.knowledgeBaseId });
    new CfnOutput(this, 'DataSourceId', { value: this.knowledgeBase.dataSourceId });
    new CfnOutput(this, 'VectorIndexArn', { value: this.knowledgeBase.indexArn });
    new CfnOutput(this, 'IngestFunctionName', { value: resourceName(env, 'ingest') });
  }
}
