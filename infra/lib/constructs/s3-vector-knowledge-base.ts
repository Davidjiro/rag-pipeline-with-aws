/**
 * s3-vector-knowledge-base.ts  -  a managed RAG pipeline: Bedrock Knowledge Base + Amazon S3 Vectors.
 *
 * WHAT THIS REPLACES
 *   A hand-built RAG pipeline needs a chunker, embedding calls, a vector database (for example Postgres with pgvector) and
 *   similarity SQL. Here AWS runs all of it: you provide documents and settings, and call `Retrieve`.
 *
 * INGESTION (indexing, once per document)
 *
 *   file in the docs bucket (S3)
 *        |  IngestKnowledgeBaseDocuments   (called by the Ingest Lambda, one document at a time)
 *        v
 *   parse  ->  chunk (fixed size, overlap)  ->  embed (Titan Text v2)  ->  write vectors + metadata
 *                                                                              |
 *                                                                              v
 *                                                          S3 Vectors index (inside a vector bucket)
 *
 * RETRIEVAL (every question)
 *
 *   question -> embed (same model) -> nearest-neighbour search WITH a metadata filter -> top-K chunks + source URIs
 *   API: `bedrock-agent-runtime:Retrieve`. It returns chunks, not an answer: the agent writes the answer itself.
 *
 * MULTI-TENANCY
 *   One shared Knowledge Base serves every project. Each chunk carries `project_id` and `owner_id` metadata (added at
 *   ingestion time by the Ingest Lambda) and every retrieval filters on them. The filter is built in code, never by the
 *   model. See ARCHITECTURE.md section 7.
 *
 * WHY S3 VECTORS
 *   + Serverless and pay-per-use: no cluster and no minimum monthly cost (OpenSearch Serverless and Aurora have one).
 *   + Native Bedrock Knowledge Base integration: no glue code.
 *   - Semantic search only. There is no hybrid (keyword + vector) search, which is out of scope for this project.
 *
 * KEY CONCEPTS / TRAPS
 *   1. Dimension and distance metric are FIXED when the index is created and must match the embedding model.
 *   2. Bedrock stores each chunk's text and metadata as vector metadata. S3 Vectors limits FILTERABLE metadata per vector,
 *      so the two Bedrock-managed keys below MUST be declared non-filterable, or ingestion fails on realistic chunks.
 *   3. The Knowledge Base ROLE is what Bedrock assumes during ingestion and retrieval. It needs bedrock:InvokeModel
 *      (embeddings), s3:GetObject (documents) and s3vectors:* (index). The agent never touches the index directly.
 *   4. The Knowledge Base must wait for its role policy, hence the explicit dependency below.
 *   5. Direct ingestion (`IngestKnowledgeBaseDocuments`) must not run at the same time as a sync job
 *      (`StartIngestionJob`). This project never starts sync jobs.
 */
import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import { Construct } from 'constructs';
import { S3VectorKnowledgeBaseProps } from '../props/knowledge-props';

export class S3VectorKnowledgeBase extends Construct {
  public readonly knowledgeBaseId: string;
  public readonly knowledgeBaseArn: string;
  public readonly dataSourceId: string;
  public readonly indexArn: string;

  constructor(scope: Construct, id: string, props: S3VectorKnowledgeBaseProps) {
    super(scope, id);
    const stack = Stack.of(this);

    // 1) THE VECTOR DATABASE: a vector bucket holding one vector index.
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {});
    vectorBucket.applyRemovalPolicy(props.removalPolicy);

    const index = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      dataType: 'float32',
      dimension: props.embeddingDimensions,
      distanceMetric: 'cosine', // cosine similarity is the usual choice for text embeddings
      metadataConfiguration: {
        // Trap 2. Our own keys (project_id, owner_id, doc_id, filename) stay filterable and are tiny.
        nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
      },
    });
    index.applyRemovalPolicy(props.removalPolicy);
    this.indexArn = index.attrIndexArn;

    // 2) THE ROLE BEDROCK ASSUMES to ingest and to query.
    const embeddingModelArn = `arn:aws:bedrock:${stack.region}::foundation-model/${props.embeddingModelId}`;
    const role = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        // Confused-deputy protection: only Knowledge Bases in THIS account may assume the role.
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${stack.region}:${stack.account}:knowledge-base/*` },
        },
      }),
    });
    const policy = new iam.Policy(this, 'KnowledgeBasePolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'EmbedWithTitan',
          actions: ['bedrock:InvokeModel'],
          resources: [embeddingModelArn],
        }),
        new iam.PolicyStatement({
          sid: 'ReadSourceDocuments',
          actions: ['s3:GetObject', 's3:ListBucket'],
          resources: [props.docsBucket.bucketArn, props.docsBucket.arnForObjects(`${props.docsPrefix}*`)],
          conditions: { StringEquals: { 'aws:ResourceAccount': stack.account } },
        }),
        new iam.PolicyStatement({
          sid: 'ReadWriteVectorIndex',
          actions: [
            's3vectors:GetIndex',
            's3vectors:PutVectors',
            's3vectors:GetVectors',
            's3vectors:ListVectors',
            's3vectors:QueryVectors',
            's3vectors:DeleteVectors',
          ],
          resources: [index.attrIndexArn],
        }),
      ],
    });
    role.attachInlinePolicy(policy);

    // 3) THE KNOWLEDGE BASE: embedding model + where vectors are stored.
    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: props.name,
      description: props.description,
      roleArn: role.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: {
              dimensions: props.embeddingDimensions,
              embeddingDataType: 'FLOAT32',
            },
          },
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: { indexArn: index.attrIndexArn },
      },
    });
    knowledgeBase.node.addDependency(policy); // trap 4
    this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId;
    this.knowledgeBaseArn = knowledgeBase.attrKnowledgeBaseArn;

    // 4) THE DATA SOURCE: where documents come from and how they are chunked.
    const dataSource = new bedrock.CfnDataSource(this, 'DataSource', {
      name: `${props.name}-docs`,
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      // DELETE removes a document's vectors when the document is deleted. RETAIN keeps them (prod).
      dataDeletionPolicy: props.removalPolicy === RemovalPolicy.DESTROY ? 'DELETE' : 'RETAIN',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: props.docsBucket.bucketArn,
          inclusionPrefixes: [props.docsPrefix],
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: {
            maxTokens: props.chunkMaxTokens,
            overlapPercentage: props.chunkOverlapPercentage,
          },
        },
      },
    });
    this.dataSourceId = dataSource.attrDataSourceId;
  }
}
