import { accessSync, constants as fsConstants } from 'node:fs';
import { z } from 'zod';
import { EnvFileError, loadEnvFileFromEnv, resolveUserPath } from './env-file.js';

/**
 * Parsed connection URL components
 */
interface ParsedConnectionUrl {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

/**
 * Parse MySQL connection URL
 * Format: mysql://user:password@host:port/database?param=value
 *
 * Supported query parameters:
 * - ssl (true/false/disable)
 */
function parseConnectionUrl(url: string): ParsedConnectionUrl {
  // Handle mysql:// and mariadb:// protocols
  const normalizedUrl = url.replace(/^(mysql|mariadb):\/\//, 'http://');

  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    // Do not echo the URL: it contains the password
    throw new Error('Invalid connection URL format');
  }

  const server = parsed.hostname;
  if (!server) {
    throw new Error('Connection URL must include a server/host');
  }

  const port = parsed.port ? parseInt(parsed.port, 10) : 3306;
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port in connection URL: ${parsed.port}`);
  }

  // Database is the pathname without leading slash
  const database = parsed.pathname.replace(/^\//, '');
  if (!database) {
    throw new Error('Connection URL must include a database name');
  }

  const user = decodeURIComponent(parsed.username);
  if (!user) {
    throw new Error('Connection URL must include a username');
  }

  const password = decodeURIComponent(parsed.password);
  if (!password) {
    throw new Error('Connection URL must include a password');
  }

  // Parse query parameters
  const params = parsed.searchParams;

  // Handle ssl parameter (true/false/disable)
  let ssl = false; // default
  const sslParam = params.get('ssl');
  if (sslParam !== null) {
    ssl = sslParam.toLowerCase() !== 'false' && sslParam.toLowerCase() !== 'disable';
  }

  return {
    server,
    port,
    database,
    user,
    password,
    ssl,
  };
}

/**
 * Environment variables schema with validation
 * Supports two modes:
 * 1. Connection URL: Set SQL_CONNECTION_URL with full connection string
 * 2. Individual parameters: Set SQL_SERVER, SQL_DATABASE, SQL_USER, SQL_PASSWORD
 */
const envSchema = z.object({
  // MySQL Connection URL (Optional - alternative to individual params)
  SQL_CONNECTION_URL: z.string().optional(),

  // MySQL Connection (Required if URL not provided)
  SQL_SERVER: z.string().optional(),
  SQL_DATABASE: z.string().optional(),
  SQL_USER: z.string().optional(),
  SQL_PASSWORD: z.string().optional(),

  // MySQL Connection (Optional)
  SQL_PORT: z
    .string()
    .default('3306')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive().max(65535)),

  SQL_SSL: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),

  // PEM file with the CA that signed the server certificate (optional; the
  // system CA store is used otherwise). `~` is expanded.
  SQL_SSL_CA: z.string().optional(),

  // Certificate verification is ON by default. "false" disables it (not
  // recommended: it allows a man in the middle to read the traffic).
  SQL_SSL_REJECT_UNAUTHORIZED: z
    .string()
    .default('true')
    .refine((val) => ['true', 'false'].includes(val.toLowerCase()), {
      message: 'SQL_SSL_REJECT_UNAUTHORIZED must be "true" or "false"',
    })
    .transform((val) => val.toLowerCase() === 'true'),

  // Operation Mode (REQUIRED)
  READONLY: z
    .string({ error: 'READONLY is required: "true" (read-only, recommended) or "false" (full access).' })
    .min(1, 'READONLY environment variable is required. Set to "true" for read-only mode or "false" for full access.')
    .refine((val) => val === 'true' || val === 'false', {
      message: 'READONLY must be "true" or "false"',
    })
    .transform((val) => val === 'true'),

  // Performance Settings (Optional)
  QUERY_TIMEOUT: z
    .string()
    .default('30000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive().max(120000)),

  MAX_ROWS: z
    .string()
    .default('1000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive().max(5000)),

  // Upper bound of the response size of a single query (sum of the row values)
  MAX_RESULT_BYTES: z
    .string()
    .default('10485760')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(1024).max(104857600)),

  // POOL_MIN is no longer used (mysql2 has no minimum pool size); it is
  // accepted and ignored so existing configurations keep working.
  POOL_MAX: z
    .string()
    .default('10')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive().max(50)),

  // Logging (Optional)
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // SSH tunnel (Optional). Enabled when SSH_HOST is set; SQL_SERVER:SQL_PORT is then
  // the database address as seen from the SSH host.
  SSH_HOST: z.string().optional(),
  SSH_PORT: z
    .string()
    .default('22')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive().max(65535)),
  SSH_USER: z.string().optional(),
  SSH_KEY_PATH: z.string().optional(),
  SSH_KEY_PASSPHRASE: z.string().optional(),
  SSH_HOST_FINGERPRINT: z.string().optional(),
});


/**
 * Configuration problem. `details` are printed one per line on stderr; they
 * never contain secret values.
 */
export class ConfigError extends Error {
  constructor(public readonly details: string[]) {
    super(details.join('\n'));
    this.name = 'ConfigError';
  }
}

/**
 * SSH tunnel settings (null when the tunnel is disabled)
 */
export interface SshConfig {
  host: string;
  port: number;
  user: string;
  /** Absolute path of the private key (`~` and relative paths already resolved) */
  keyPath: string;
  keyPassphrase?: string;
  hostFingerprint: string;
}

/** One pinned fingerprint: SHA256 + 43 base64 characters (+ optional padding) */
export const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}=?$/;

/**
 * Check the format of SSH_HOST_FINGERPRINT (comma separated list).
 * @returns null when valid, otherwise a description of the problem
 */
export function invalidFingerprints(value: string): string | null {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (items.length === 0) {
    return 'no fingerprint given';
  }
  const bad = items.filter((item) => !FINGERPRINT_PATTERN.test(item.replace(/^sha256:/i, 'SHA256:')));
  if (bad.length > 0) {
    // Fingerprints are public: echoing them helps fixing typos
    return `invalid value(s): ${bad.map((item) => JSON.stringify(item)).join(', ')}`;
  }
  return null;
}

/**
 * Resolve and check SQL_SSL_CA (path of a PEM file)
 */
function resolveSslCa(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const caPath = resolveUserPath(value);
  try {
    accessSync(caPath, fsConstants.R_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new ConfigError([`  - SQL_SSL_CA: CA file "${caPath}" is not readable (${code}).`]);
  }
  return caPath;
}

/**
 * Resolve the SSH tunnel settings, throwing a ConfigError when incomplete
 */
function resolveSsh(env: z.infer<typeof envSchema>): SshConfig | null {
  if (!env.SSH_HOST) {
    return null;
  }

  const missing: string[] = [];
  if (!env.SSH_USER) missing.push('SSH_USER');
  if (!env.SSH_KEY_PATH) missing.push('SSH_KEY_PATH');
  if (!env.SSH_HOST_FINGERPRINT) missing.push('SSH_HOST_FINGERPRINT');

  if (missing.length > 0) {
    throw new ConfigError([
      '  SSH_HOST is set but these are missing:',
      ...missing.map((param) => `    - ${param}`),
      '  SSH_HOST_FINGERPRINT is mandatory (e.g. SHA256:xxxx, see ssh-keygen -lf).',
    ]);
  }

  const badFingerprints = invalidFingerprints(env.SSH_HOST_FINGERPRINT!);
  if (badFingerprints !== null) {
    throw new ConfigError([
      `  - SSH_HOST_FINGERPRINT: ${badFingerprints}`,
      '    Expected one or more comma separated SHA256:<43 base64 characters> values,',
      '    as printed by `ssh-keygen -lf <host key .pub>`.',
    ]);
  }

  // `~` is expanded and relative paths are resolved against the working
  // directory, which is whatever the MCP client uses: prefer absolute paths.
  const keyPath = resolveUserPath(env.SSH_KEY_PATH!);
  try {
    accessSync(keyPath, fsConstants.R_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new ConfigError([`  - SSH_KEY_PATH: private key "${keyPath}" is not readable (${code}).`]);
  }

  return {
    host: env.SSH_HOST,
    port: env.SSH_PORT,
    user: env.SSH_USER!,
    keyPath,
    keyPassphrase: env.SSH_KEY_PASSPHRASE || undefined,
    hostFingerprint: env.SSH_HOST_FINGERPRINT!,
  };
}

/**
 * Final validated configuration type with resolved connection details
 */
export interface Config {
  SQL_SERVER: string;
  SQL_DATABASE: string;
  SQL_USER: string;
  SQL_PASSWORD: string;
  SQL_PORT: number;
  SQL_SSL: boolean;
  /** Absolute path of the CA PEM file (`~` resolved), when set */
  SQL_SSL_CA?: string;
  SQL_SSL_REJECT_UNAUTHORIZED: boolean;
  READONLY: boolean;
  QUERY_TIMEOUT: number;
  MAX_ROWS: number;
  MAX_RESULT_BYTES: number;
  POOL_MAX: number;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  SSH: SshConfig | null;
}

/**
 * Validate a set of environment variables and build the configuration.
 * Supports both connection URL and individual parameters.
 *
 * @throws ConfigError with human readable details
 */
export function parseConfig(source: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`));
  }

  const env = result.data;

  const common = {
    READONLY: env.READONLY,
    QUERY_TIMEOUT: env.QUERY_TIMEOUT,
    MAX_ROWS: env.MAX_ROWS,
    MAX_RESULT_BYTES: env.MAX_RESULT_BYTES,
    POOL_MAX: env.POOL_MAX,
    LOG_LEVEL: env.LOG_LEVEL,
    SQL_SSL_CA: resolveSslCa(env.SQL_SSL_CA),
    SQL_SSL_REJECT_UNAUTHORIZED: env.SQL_SSL_REJECT_UNAUTHORIZED,
  };

  // Check if connection URL is provided
  if (env.SQL_CONNECTION_URL) {
    let parsed: ParsedConnectionUrl;
    try {
      parsed = parseConnectionUrl(env.SQL_CONNECTION_URL);
    } catch (error) {
      // Never echo the URL itself: it carries the password
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new ConfigError([
        `  - SQL_CONNECTION_URL: ${message}`,
        '',
        'Connection URL format:',
        '  mysql://user:password@host:port/database?ssl=true',
      ]);
    }
    return {
      SQL_SERVER: parsed.server,
      SQL_DATABASE: parsed.database,
      SQL_USER: parsed.user,
      SQL_PASSWORD: parsed.password,
      SQL_PORT: parsed.port,
      SQL_SSL: parsed.ssl,
      ...common,
      SSH: resolveSsh(env),
    };
  }

  // Validate individual parameters are provided
  const missingParams: string[] = [];
  if (!env.SQL_SERVER) missingParams.push('SQL_SERVER');
  if (!env.SQL_DATABASE) missingParams.push('SQL_DATABASE');
  if (!env.SQL_USER) missingParams.push('SQL_USER');
  if (!env.SQL_PASSWORD) missingParams.push('SQL_PASSWORD');

  if (missingParams.length > 0) {
    throw new ConfigError([
      '  Either SQL_CONNECTION_URL or individual connection parameters are required.',
      '',
      '  Missing parameters:',
      ...missingParams.map((param) => `    - ${param}`),
      '',
      'Option 1 - Use connection URL:',
      '  SQL_CONNECTION_URL=mysql://user:password@host:port/database',
      '',
      'Option 2 - Use individual parameters:',
      '  SQL_SERVER, SQL_DATABASE, SQL_USER, SQL_PASSWORD',
    ]);
  }

  return {
    SQL_SERVER: env.SQL_SERVER!,
    SQL_DATABASE: env.SQL_DATABASE!,
    SQL_USER: env.SQL_USER!,
    SQL_PASSWORD: env.SQL_PASSWORD!,
    SQL_PORT: env.SQL_PORT,
    SQL_SSL: env.SQL_SSL,
    ...common,
    SSH: resolveSsh(env),
  };
}

/**
 * Load ENV_FILE (if any) into process.env, then validate the configuration.
 * On error prints a clear message to stderr (stdout belongs to the MCP
 * protocol) and exits with status 1.
 */
function loadConfig(): Config {
  try {
    loadEnvFileFromEnv(process.env);
    return parseConfig(process.env);
  } catch (error) {
    console.error('[MCP] Configuration error:');
    if (error instanceof ConfigError) {
      for (const line of error.details) console.error(line);
    } else if (error instanceof EnvFileError) {
      console.error(`  - ${error.message}`);
    } else {
      console.error(`  - ${error instanceof Error ? error.message : String(error)}`);
    }
    console.error('');
    console.error('[MCP] Check the "env" block of your MCP client config, ENV_FILE or .env.');
    console.error('[MCP] See .env.example / README for the full list of variables.');
    process.exit(1);
  }
}

/**
 * Global configuration object
 */
export const config = loadConfig();
