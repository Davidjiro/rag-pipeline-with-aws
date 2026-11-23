/**
 * paths.ts  -  where the application code lives, relative to this repository.
 *
 * CDK packages these folders as ASSETS at deploy time:
 *   - Docker folders (api, agent) are built as arm64 images and pushed to the bootstrap ECR repository.
 *   - The ingest folder is zipped and uploaded to the bootstrap S3 bucket.
 *   - The web folder is copied into the web bucket by a deployment custom resource.
 * At synth time CDK only hashes these folders. It does not need Docker, and it does not build anything.
 */
import * as fs from 'fs';
import * as path from 'path';

/** The repository root (this file is <repo>/infra/lib/config/paths.ts). */
const REPO_ROOT = path.resolve(__dirname, '../../..');

export const PATHS = {
  /** FastAPI app on Lambda (container image with the Lambda Web Adapter). */
  apiDir: path.join(REPO_ROOT, 'backend', 'api'),
  /** Lambda that starts Knowledge Base ingestion when a file lands in S3. */
  ingestDir: path.join(REPO_ROOT, 'backend', 'ingest'),
  /** Chat agent container for AgentCore Runtime. */
  agentDir: path.join(REPO_ROOT, 'agent'),
  /** Built single-page app (`npm run build` in web/; infra's `npm run deploy` runs it). Not committed. */
  webDistDir: path.join(REPO_ROOT, 'web', 'dist'),
  /** A one-page stand-in, published when there is no build, so synth and the tests work on a fresh clone. */
  webPlaceholderDir: path.join(REPO_ROOT, 'web', 'placeholder'),
} as const;

/** The folder to publish: the build if it exists, otherwise the placeholder (the web stack then warns at synth). */
export function webAppDir(
  distDir: string = PATHS.webDistDir,
  placeholderDir: string = PATHS.webPlaceholderDir,
): { dir: string; isPlaceholder: boolean } {
  const built = fs.existsSync(path.join(distDir, 'index.html'));
  return built ? { dir: distDir, isPlaceholder: false } : { dir: placeholderDir, isPlaceholder: true };
}
