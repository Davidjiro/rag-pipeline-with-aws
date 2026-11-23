/**
 * Runtime configuration, read from `/config.json` at start-up.
 *
 * CDK writes that file next to the app at deploy time (infra/lib/constructs/web-distribution.ts), so one build runs
 * in every environment. Nothing in it is secret: the user pool id and client id are public by design.
 */

export interface AppConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  apiBasePath: string;
  /** Upload limits, checked in the browser before asking for an upload. The API enforces them again. */
  maxFileMb: number;
  allowedExtensions: string[];
}

const DEFAULT_EXTENSIONS = ['pdf', 'txt', 'md', 'html', 'docx', 'csv'];

export function parseConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== 'object') throw new Error('config.json is not an object');
  const c = raw as Record<string, unknown>;
  const text = (key: string): string => {
    const value = c[key];
    if (typeof value !== 'string' || !value) throw new Error(`config.json is missing "${key}"`);
    return value;
  };
  const extensions = Array.isArray(c.allowedExtensions)
    ? c.allowedExtensions.filter((e): e is string => typeof e === 'string').map((e) => e.toLowerCase())
    : DEFAULT_EXTENSIONS;
  return {
    region: text('region'),
    userPoolId: text('userPoolId'),
    userPoolClientId: text('userPoolClientId'),
    apiBasePath: typeof c.apiBasePath === 'string' ? c.apiBasePath.replace(/\/$/, '') : '/api',
    maxFileMb: typeof c.maxFileMb === 'number' && c.maxFileMb > 0 ? c.maxFileMb : 20,
    allowedExtensions: extensions.length ? extensions : DEFAULT_EXTENSIONS,
  };
}

export async function loadConfig(): Promise<AppConfig> {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`config.json returned HTTP ${response.status}`);
  return parseConfig(await response.json());
}
