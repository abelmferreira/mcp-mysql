import { getErrorMessage, isOptionalFeatureError } from '../utils/errors.js';

/**
 * Run an optional part of a tool. When it fails because of a missing
 * privilege or a missing object (sys schema, performance_schema table, column
 * of another server version), a warning is recorded and `null` is returned,
 * so the tool can still answer with what it has. Other errors are rethrown.
 */
export async function optional<T>(warnings: string[], label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (isOptionalFeatureError(error)) {
      warnings.push(`${label} unavailable (missing privilege or object): ${getErrorMessage(error)}`);
      return null;
    }
    throw error;
  }
}

/** Add `warnings` to a response object only when there is any */
export function withWarnings<T extends object>(data: T, warnings: string[]): T & { warnings?: string[] } {
  return warnings.length > 0 ? { ...data, warnings } : data;
}

/**
 * Does information_schema.COLUMNS.COLUMN_DEFAULT hold SQL expressions on this
 * server? MariaDB 10.2.7+ reports `NULL` (the word) for "DEFAULT NULL", quotes
 * string literals ('abc') and keeps expressions bare (current_timestamp()).
 * MySQL and older MariaDB report a real NULL and unquoted literals.
 */
export function columnDefaultIsExpression(info: { version: string; isMariaDB: boolean }): boolean {
  if (!info.isMariaDB) return false;
  // @@version looks like "10.11.6-MariaDB-log" ("5.5.5-" only appears in the handshake)
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(info.version.replace(/^5\.5\.5-/, ''));
  if (!match) return true; // modern MariaDB is by far the likeliest
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major !== 10) return major > 10;
  if (minor !== 2) return minor > 2;
  return patch >= 7;
}

/**
 * Normalize the `defaultValue` of column rows (COLUMN_DEFAULT): on MariaDB
 * 10.2.7+ the bare word NULL means "no default / DEFAULT NULL" and becomes a
 * JSON null, as MySQL reports it. Everything else is kept as is (MariaDB
 * string defaults stay quoted, e.g. "'abc'", which tells them apart from
 * expressions such as "current_timestamp()"; a string default 'NULL' stays
 * "'NULL'").
 */
export function normalizeColumnDefaults<T extends Record<string, unknown>>(
  rows: T[],
  info: { version: string; isMariaDB: boolean },
  key = 'defaultValue'
): T[] {
  if (!columnDefaultIsExpression(info)) return rows;
  return rows.map((row) => {
    const value = row[key];
    return typeof value === 'string' && value.toUpperCase() === 'NULL' ? { ...row, [key]: null } : row;
  });
}
