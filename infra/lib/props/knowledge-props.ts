/**
 * knowledge-props.ts  -  inputs of the document and RAG building blocks.
 */
import { RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface SecureBucketProps {
  /** DESTROY (also empties the bucket) for dev, RETAIN for prod. */
  readonly removalPolicy: RemovalPolicy;
  /**
   * Browser origins allowed to POST to this bucket (presigned uploads). Leave undefined for buckets that
   * browsers never call directly. A single `*` wildcard is allowed, for example `https://*.cloudfront.net`.
   */
  readonly uploadAllowedOrigins?: readonly string[];
}

/** Everything needed to build a managed RAG store: Bedrock Knowledge Base with Amazon S3 Vectors. */
export interface S3VectorKnowledgeBaseProps {
  /** Knowledge Base name, for example `kc-dev-kb`. */
  readonly name: string;
  readonly description: string;
  /** Source documents live here. Chunks and vectors do NOT. */
  readonly docsBucket: s3.IBucket;
  /** Only objects under this key prefix are ingested, for example `projects/`. */
  readonly docsPrefix: string;
  /** Bedrock embedding model id, for example `amazon.titan-embed-text-v2:0`. */
  readonly embeddingModelId: string;
  /** Must equal what the embedding model emits. The S3 Vectors index has a fixed dimension. */
  readonly embeddingDimensions: number;
  readonly chunkMaxTokens: number;
  readonly chunkOverlapPercentage: number;
  /** DESTROY for dev. RETAIN for prod. */
  readonly removalPolicy: RemovalPolicy;
}

/** The Lambda that starts ingestion of one uploaded file. */
export interface IngestFunctionProps {
  readonly name: string;
  /** Folder with `handler.py`. */
  readonly codeDir: string;
  /** Bucket whose `ObjectCreated` events trigger the function. */
  readonly bucket: s3.IBucket;
  readonly prefix: string;
  readonly table: dynamodb.ITable;
  readonly knowledgeBaseId: string;
  readonly knowledgeBaseArn: string;
  readonly dataSourceId: string;
  /** Leave undefined unless the account quota allows it (see config/environments.ts). */
  readonly reservedConcurrency?: number;
  readonly logRetention: logs.RetentionDays;
  readonly removalPolicy: RemovalPolicy;
}
