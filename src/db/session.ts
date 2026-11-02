import { logger } from '../utils/logger.js';
import { UnsafeSessionError, getErrorMessage } from '../utils/errors.js';

/**
 * sql_mode flags that change how the server lexes string literals, which the
 * query validator and the literal escaping both rely on:
 *  - NO_BACKSLASH_ESCAPES: "\" is no longer an escape character, so 'a\' ends the string;
 *  - ANSI_QUOTES: "..." becomes an identifier instead of a string.
 * The combination modes below include ANSI_QUOTES (and setting them again would
 * bring it back), so they are removed as well.
 */
export const UNSAFE_SQL_MODE_FLAGS = [
  'NO_BACKSLASH_ESCAPES',
  'ANSI_QUOTES',
  'ANSI',
  'ORACLE',
  'DB2',
  'MSSQL',
  'POSTGRESQL',
  'MAXDB',
];

/**
 * Minimal connection surface used here (a mysql2/promise connection)
 */
export interface SessionConnection {
  query(sql: string): Promise<[unknown, unknown]>;
}

/**
 * Remove the unsafe flags from a sql_mode value
 */
export function safeSqlMode(mode: string): { mode: string; removed: string[] } {
  const flags = mode
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');
  const removed = flags.filter((f) => UNSAFE_SQL_MODE_FLAGS.includes(f.toUpperCase()));
  const kept = flags.filter((f) => !UNSAFE_SQL_MODE_FLAGS.includes(f.toUpperCase()));
  return { mode: kept.join(','), removed };
}

function firstRow(result: [unknown, unknown]): Record<string, unknown> {
  const rows = result[0];
  if (Array.isArray(rows) && rows.length > 0 && rows[0] && typeof rows[0] === 'object') {
    return rows[0] as Record<string, unknown>;
  }
  return {};
}

export interface PrepareOptions {
  /** READONLY mode: failing to set the statement timeout aborts the query */
  readonly: boolean;
  /** Statement timeout in milliseconds */
  timeoutMs: number;
}

/**
 * Put a freshly obtained connection in a safe state before running a query:
 *
 * 1. sql_mode must not contain NO_BACKSLASH_ESCAPES / ANSI_QUOTES (or a mode
 *    implying it). They are removed from the SESSION sql_mode (no privilege
 *    needed); if that does not stick, the query is refused.
 * 2. A server-side statement timeout: MariaDB `max_statement_time` (seconds),
 *    MySQL `max_execution_time` (ms, SELECT only). In READONLY mode a query
 *    never runs without one (fail closed).
 */
export async function prepareSession(conn: SessionConnection, options: PrepareOptions): Promise<{ isMariaDB: boolean }> {
  const info = firstRow(await conn.query('SELECT @@SESSION.sql_mode AS sqlMode, @@version AS version'));
  const sqlMode = String(info.sqlMode ?? '');
  const isMariaDB = /mariadb/i.test(String(info.version ?? ''));

  const { mode, removed } = safeSqlMode(sqlMode);
  if (removed.length > 0) {
    if (!/^[A-Za-z0-9_,]*$/.test(mode)) {
      throw new UnsafeSessionError(`Unexpected sql_mode value; refusing to run the query (unsafe flags: ${removed.join(', ')})`);
    }
    try {
      await conn.query(`SET SESSION sql_mode = '${mode}'`);
    } catch (error) {
      throw new UnsafeSessionError(
        `The session sql_mode contains ${removed.join(', ')}, which breaks the query validator, ` +
          `and it could not be changed: ${getErrorMessage(error)}`
      );
    }
    const check = safeSqlMode(String(firstRow(await conn.query('SELECT @@SESSION.sql_mode AS sqlMode')).sqlMode ?? ''));
    if (check.removed.length > 0) {
      throw new UnsafeSessionError(
        `The session sql_mode still contains ${check.removed.join(', ')} after resetting it; refusing to run the query`
      );
    }
    logger.debug('Unsafe sql_mode flags removed from the session', { removed });
  }

  const seconds = (options.timeoutMs / 1000).toFixed(3);
  const statements = isMariaDB
    ? [`SET SESSION max_statement_time = ${seconds}`, `SET SESSION max_execution_time = ${options.timeoutMs}`]
    : [`SET SESSION max_execution_time = ${options.timeoutMs}`, `SET SESSION max_statement_time = ${seconds}`];

  const errors: string[] = [];
  for (const statement of statements) {
    try {
      await conn.query(statement);
      return { isMariaDB };
    } catch (error) {
      errors.push(getErrorMessage(error));
    }
  }

  if (options.readonly) {
    throw new UnsafeSessionError(
      'Could not set a server-side statement timeout (max_statement_time / max_execution_time); ' +
        `refusing to run the query in READONLY mode. ${errors.join(' | ')}`
    );
  }
  logger.warn('Could not set a server-side statement timeout', { errors });
  return { isMariaDB };
}
