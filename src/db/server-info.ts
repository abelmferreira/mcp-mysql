import { executeQuery } from './execute.js';

/**
 * Facts about the server that some tools depend on
 */
export interface ServerInfo {
  version: string;
  isMariaDB: boolean;
  /** @@performance_schema: OFF by default on MariaDB */
  performanceSchema: boolean;
}

let cached: Promise<ServerInfo> | null = null;

/**
 * Server version and performance_schema status (read once per process)
 */
export function getServerInfo(): Promise<ServerInfo> {
  if (!cached) {
    cached = load().catch((error) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

/**
 * Forget the cached server info (tests, reconnection to another server)
 */
export function resetServerInfo(): void {
  cached = null;
}

async function load(): Promise<ServerInfo> {
  const result = await executeQuery('SELECT @@version AS version, @@performance_schema AS performanceSchema', {}, 1);
  const row = (result.rows[0] ?? {}) as { version?: unknown; performanceSchema?: unknown };
  const version = String(row.version ?? '');
  const ps = row.performanceSchema;
  return {
    version,
    isMariaDB: /mariadb/i.test(version),
    performanceSchema: ps === 1 || ps === '1' || ps === true || String(ps).toUpperCase() === 'ON',
  };
}

/** Warning returned by the tools that need performance_schema when it is disabled */
export const PERFORMANCE_SCHEMA_OFF_WARNING =
  'performance_schema is disabled on this server (the default on MariaDB), so this information is not available. ' +
  'Enable it with performance_schema=ON in the server configuration (requires a restart).';
