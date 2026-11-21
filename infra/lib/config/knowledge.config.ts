/**
 * knowledge.config.ts  -  VALUES for the document and RAG layer.
 *
 * The functions return props WITHOUT the live objects (the bucket, the table, the Knowledge Base ids), which the stack adds
 * because they only exist after other constructs are created. That is why the return types use `Omit<...>`.
 */
import { IngestFunctionProps, S3VectorKnowledgeBaseProps } from '../props/knowledge-props';
import { EnvironmentConfig, resourceName } from './environments';
import { PATHS } from './paths';

/**
 * Key prefix of every uploaded document: `projects/<project_id>/<doc_id>/<filename>`.
 * The ingest trigger, the Knowledge Base data source and the API's S3 permissions are all limited to it.
 */
export const DOCS_PREFIX = 'projects/';

export function knowledgeBaseConfig(env: EnvironmentConfig): Omit<S3VectorKnowledgeBaseProps, 'docsBucket'> {
  return {
    name: resourceName(env, 'kb'),
    description: 'Documents uploaded by users, searchable by meaning. Shared by all projects and filtered by metadata.',
    docsPrefix: DOCS_PREFIX,
    embeddingModelId: env.embeddingModelId,
    embeddingDimensions: env.embeddingDimensions,
    chunkMaxTokens: env.chunkMaxTokens,
    chunkOverlapPercentage: env.chunkOverlapPercentage,
    removalPolicy: env.removalPolicy,
  };
}

export function ingestConfig(
  env: EnvironmentConfig,
): Pick<IngestFunctionProps, 'name' | 'codeDir' | 'prefix' | 'reservedConcurrency' | 'logRetention' | 'removalPolicy'> {
  return {
    name: resourceName(env, 'ingest'),
    codeDir: PATHS.ingestDir,
    prefix: DOCS_PREFIX,
    reservedConcurrency: env.reservedConcurrency.ingest,
    logRetention: env.logRetention,
    removalPolicy: env.removalPolicy,
  };
}
