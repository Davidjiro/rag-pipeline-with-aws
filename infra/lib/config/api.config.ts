/**
 * api.config.ts  -  VALUES for the API layer. Live references (table, bucket, ids, ARNs) are added by ApiStack.
 */
import { ApiFunctionProps } from '../props/api-props';
import { EnvironmentConfig, resourceName } from './environments';
import { DOCS_PREFIX } from './knowledge.config';
import { PATHS } from './paths';

export function apiConfig(
  env: EnvironmentConfig,
): Pick<
  ApiFunctionProps,
  'name' | 'sourceDir' | 'docsPrefix' | 'limits' | 'reservedConcurrency' | 'logRetention' | 'removalPolicy'
> {
  return {
    name: resourceName(env, 'api'),
    sourceDir: PATHS.apiDir,
    docsPrefix: DOCS_PREFIX,
    limits: env.limits,
    reservedConcurrency: env.reservedConcurrency.api,
    logRetention: env.logRetention,
    removalPolicy: env.removalPolicy,
  };
}
