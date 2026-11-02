import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { FieldPacket, ResultSetHeader } from 'mysql2/promise';
import { getPool } from './connection.js';
import { prepareSession, type SessionConnection } from './session.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { lex } from '../validators/sql-lexer.js';
import { validateQuery } from '../validators/query-validator.js';
import {
  QueryValidationError,
  ReadOnlyViolationError,
  TimeoutError,
  InvalidOperationError,
  MissingParameterError,
  getErrorMessage,
  isTimeoutError,
} from '../utils/errors.js';
import type { QueryResult, SqlParamValue } from '../types.js';

/**
 * Map MySQL protocol field type codes to readable names.
 */
const MYSQL_TYPE_NAMES: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINYINT',
  2: 'SMALLINT',
  3: 'INT',
  4: 'FLOAT',
  5: 'DOUBLE',
  6: 'NULL',
  7: 'TIMESTAMP',
  8: 'BIGINT',
  9: 'MEDIUMINT',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  15: 'VARCHAR',
  16: 'BIT',
  245: 'JSON',
  246: 'DECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINYBLOB',
  250: 'MEDIUMBLOB',
  251: 'LONGBLOB',
  252: 'BLOB',
  253: 'VARCHAR',
  254: 'CHAR',
  255: 'GEOMETRY',
};

/** Extra time given to the server-side timeout before the client gives up */
const CLIENT_TIMEOUT_GRACE_MS = 1000;
/** Upper bound for the KILL QUERY issued after a client-side timeout */
const KILL_TIMEOUT_MS = 2000;

const STRING_ESCAPES: Record<string, string> = {
  '\0': '\\0',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
  '\x1a': '\\Z',
  '"': '\\"',
  "'": "\\'",
  '\\': '\\\\',
};

/**
 * Render a parameter value as a SQL literal.
 * Strings use backslash escapes, which is correct because the session sql_mode
 * never contains NO_BACKSLASH_ESCAPES / ANSI_QUOTES (see db/session.ts).
 */
export function toSqlLiteral(value: SqlParamValue | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidOperationError('Numeric parameters must be finite numbers');
    }
    // Parentheses keep "-1" from forming "--" with a preceding minus sign
    return value < 0 ? `(${String(value)})` : String(value);
  }
  if (typeof value === 'string') {
    return `'${value.replace(/[\0\b\t\n\r\x1a"'\\]/g, (c) => STRING_ESCAPES[c])}'`;
  }
  throw new InvalidOperationError(`Unsupported parameter type: ${typeof value}`);
}

/**
 * Replace @param placeholders by SQL literals and return the final SQL text.
 *
 * The SQL is built here, with the same lexer as the query validator (so a
 * placeholder inside a string, quoted identifier or ANY comment is left alone),
 * and is then sent as is: there is no client-side interpolation by the
 * driver, whose own lexer differs from the server's. The validator then
 * checks this final text, i.e. exactly what the server receives.
 *
 * `@@system_variables` are untouched. Raw "?" placeholders are refused.
 */
export function compileQuery(query: string, params: Record<string, SqlParamValue>): string {
  const { tokens, error } = lex(query);
  if (error) {
    throw new QueryValidationError(error);
  }

  const missing: string[] = [];
  let out = '';
  for (const token of tokens) {
    if (token.type === 'punct' && token.text === '?') {
      throw new InvalidOperationError(
        'Positional "?" placeholders are not supported; use @name placeholders and the "params" argument'
      );
    }
    if (token.type === 'uservar' && !token.quoted && token.name) {
      if (Object.prototype.hasOwnProperty.call(params, token.name)) {
        // "x@p" must not become x'..' (a hex literal): keep the literal a separate token
        if (/[A-Za-z0-9_$]$/.test(out)) out += ' ';
        out += toSqlLiteral(params[token.name]);
        continue;
      }
      missing.push(token.name);
    }
    out += token.text;
  }

  if (missing.length > 0) {
    throw new MissingParameterError(missing[0]);
  }
  return out;
}

/**
 * Short fingerprint of a query for logs (the query text itself is not logged)
 */
export function queryFingerprint(query: string): { queryHash: string; queryLength: number } {
  return {
    queryHash: createHash('sha256').update(query).digest('hex').slice(0, 12),
    queryLength: query.length,
  };
}

/**
 * Rough size of a row in bytes (used to cap the response size)
 */
function estimateRowBytes(row: Record<string, unknown>): number {
  let total = 0;
  for (const [key, value] of Object.entries(row)) {
    total += key.length;
    if (value === null || value === undefined) total += 4;
    else if (typeof value === 'string') total += value.length;
    else if (Buffer.isBuffer(value)) total += value.length;
    else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') total += 8;
    else if (value instanceof Date) total += 24;
    else total += JSON.stringify(value)?.length ?? 8;
  }
  return total;
}

/**
 * Core (callback style) mysql2 connection: `query()` returns an event emitter
 * that emits 'fields', 'result' (one per row), 'error' and 'end'.
 */
interface CoreConnection {
  query(sql: string): EventEmitter;
}

/**
 * Promise connection taken from the pool (mysql2/promise PoolConnection)
 */
interface PooledConnection extends SessionConnection {
  connection: CoreConnection & { stream?: { destroy(): void } };
  threadId: number | null;
  release(): void;
  destroy(): void;
  /** COM_QUIT and removal from the pool (the pool is created with gracefulEnd) */
  end(): Promise<void>;
}

interface PoolLike {
  getConnection(): Promise<PooledConnection>;
  query(sql: string): Promise<unknown>;
}

interface StreamLimits {
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
}

interface StreamOutcome {
  rows: Record<string, unknown>[];
  fields: FieldPacket[];
  header?: ResultSetHeader;
  truncated: boolean;
  truncatedBy?: 'maxRows' | 'maxBytes';
}

/**
 * Run a query and collect its rows one by one, stopping as soon as the row or
 * byte limit is passed: the driver never buffers the whole result set.
 * The caller must destroy the connection when `truncated` is set or when the
 * promise rejects, since the result has not been fully read.
 */
function streamQuery(core: CoreConnection, sql: string, limits: StreamLimits): Promise<StreamOutcome> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, unknown>[] = [];
    let fields: FieldPacket[] | undefined;
    let header: ResultSetHeader | undefined;
    let bytes = 0;
    let settled = false;

    const finish = (outcome: StreamOutcome | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };

    const timer = setTimeout(
      () => finish(new TimeoutError(limits.timeoutMs)),
      limits.timeoutMs + CLIENT_TIMEOUT_GRACE_MS
    );

    const emitter = core.query(sql);
    emitter.on('fields', (f: FieldPacket[]) => {
      fields = f;
    });
    emitter.on('result', (row: unknown) => {
      if (settled) return;
      if (fields === undefined) {
        // No result set (OK packet of a statement that returns no rows)
        header = row as ResultSetHeader;
        return;
      }
      if (rows.length >= limits.maxRows) {
        finish({ rows, fields, truncated: true, truncatedBy: 'maxRows' });
        return;
      }
      const record = row as Record<string, unknown>;
      bytes += estimateRowBytes(record);
      if (bytes > limits.maxBytes) {
        finish({ rows, fields, truncated: true, truncatedBy: 'maxBytes' });
        return;
      }
      rows.push(record);
    });
    // Kept after settling too: an 'error' event without listener would throw
    emitter.on('error', (err: Error) => finish(err));
    emitter.on('end', () => finish({ rows, fields: fields ?? [], header, truncated: false }));
  });
}

/**
 * Best effort KILL QUERY of a server thread, on another pooled connection.
 * Users can always kill their own threads (no PROCESS/SUPER needed).
 */
async function killQuery(pool: PoolLike, threadId: number | null): Promise<void> {
  if (typeof threadId !== 'number' || !Number.isInteger(threadId) || threadId <= 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query(`KILL QUERY ${threadId}`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('KILL QUERY timed out')), KILL_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn('Could not kill the timed out query', { threadId, error: getErrorMessage(error) });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How a connection is given back after a statement
 *  - release: back to the pool (write mode, session state is the caller's business)
 *  - quit: closed cleanly with COM_QUIT (READONLY: no session state survives)
 *  - abort: socket destroyed at once, while the server may still be sending
 *    rows or running the statement (truncated result, timeout)
 */
type Disposal = 'release' | 'quit' | 'abort';

function dispose(conn: PooledConnection, disposal: Disposal): void {
  if (disposal === 'release') {
    conn.release();
    return;
  }
  if (disposal === 'quit') {
    conn.end().catch(() => conn.destroy());
    return;
  }
  conn.destroy();
  // destroy() only half-closes the socket; drop it so that the rest of the
  // result set is not read (the server then aborts the statement on write)
  conn.connection.stream?.destroy();
}

/**
 * Run one statement on a dedicated pooled connection.
 *
 * READONLY: the session is made safe (sql_mode, statement timeout; fail
 * closed), START TRANSACTION READ ONLY, then the statement. The connection is
 * then always CLOSED instead of returned to the pool, so no session state
 * survives the query: user-level locks (GET_LOCK), user variables,
 * LAST_INSERT_ID(x), temporary tables... The cost is one new connection per
 * query (through the SSH tunnel: one new forwarded channel, same SSH session).
 */
async function runStatement(sql: string, maxRows: number, readonly: boolean): Promise<StreamOutcome> {
  const pool = (await getPool()) as unknown as PoolLike;
  const conn = await pool.getConnection();
  let disposal: Disposal = readonly ? 'quit' : 'release';
  let killThread: number | null = null;

  try {
    await prepareSession(conn, { readonly, timeoutMs: config.QUERY_TIMEOUT });
    if (readonly) {
      await conn.query('START TRANSACTION READ ONLY');
    }
    const outcome = await streamQuery(conn.connection, sql, {
      maxRows,
      maxBytes: config.MAX_RESULT_BYTES,
      timeoutMs: config.QUERY_TIMEOUT,
    });
    if (outcome.truncated) {
      // The rest of the result set is still on the wire
      disposal = 'abort';
    }
    return outcome;
  } catch (error) {
    if (error instanceof TimeoutError) {
      disposal = 'abort';
      killThread = conn.threadId;
    } else if (!readonly) {
      // Unknown state after an error: do not reuse it
      disposal = 'quit';
    }
    throw error;
  } finally {
    dispose(conn, disposal);
    if (killThread !== null) {
      await killQuery(pool, killThread);
    }
  }
}

/**
 * Execute a SQL query with parameters
 *
 * @param query SQL query with @param placeholders
 * @param params Named parameters (without @)
 * @param maxRows Maximum rows to return (capped by MAX_ROWS)
 * @returns Query result with rows and metadata
 */
export async function executeQuery(
  query: string,
  params: Record<string, SqlParamValue> = {},
  maxRows: number = 100
): Promise<QueryResult> {
  const startTime = Date.now();
  const limit = Math.max(1, Math.min(Math.floor(maxRows), config.MAX_ROWS));

  if (config.READONLY) {
    // The template first, for clearer messages (placeholders allowed)...
    const template = validateQuery(query, { allowParameters: true });
    if (!template.valid) {
      throw new QueryValidationError(template.reason || 'Query validation failed', template.queryType);
    }
  }

  const sql = compileQuery(query, params);

  if (config.READONLY) {
    // ...then the exact text that is sent to the server
    const final = validateQuery(sql);
    if (!final.valid) {
      throw new QueryValidationError(
        `${final.reason || 'Query validation failed'} (after binding the parameters)`,
        final.queryType
      );
    }
  }

  try {
    const outcome = await runStatement(sql, limit, config.READONLY);
    const duration = Date.now() - startTime;

    logger.debug('Query executed', {
      rowsReturned: outcome.rows.length,
      truncated: outcome.truncated,
      duration,
      readonly: config.READONLY,
    });

    const fields = outcome.fields.map((field) => ({
      name: field.name,
      type: MYSQL_TYPE_NAMES[field.type as number] ?? String(field.type ?? 'unknown'),
    }));

    return {
      rows: outcome.rows,
      rowCount: outcome.rows.length,
      fields,
      duration,
      truncated: outcome.truncated,
      ...(outcome.truncatedBy ? { truncatedBy: outcome.truncatedBy } : {}),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error('Query execution failed', {
      error: getErrorMessage(error),
      duration,
      ...queryFingerprint(query),
    });

    if (isTimeoutError(error)) {
      throw new TimeoutError(config.QUERY_TIMEOUT);
    }
    throw error;
  }
}

/**
 * Execute a write operation (INSERT, UPDATE, DELETE)
 * Only allowed when READONLY is false
 *
 * @param query SQL query
 * @param params Named parameters
 * @returns Number of affected rows and last insert id
 */
export async function executeWrite(
  query: string,
  params: Record<string, SqlParamValue> = {}
): Promise<{ affectedRows: number; insertId: number; duration: number }> {
  if (config.READONLY) {
    throw new ReadOnlyViolationError('WRITE');
  }

  const startTime = Date.now();
  const sql = compileQuery(query, params);

  try {
    const pool = (await getPool()) as unknown as PoolLike;
    const conn = await pool.getConnection();
    let result: unknown;
    try {
      await prepareSession(conn, { readonly: false, timeoutMs: config.QUERY_TIMEOUT });
      [result] = await conn.query(sql);
    } catch (error) {
      dispose(conn, 'quit');
      throw error;
    }
    dispose(conn, 'release');

    const duration = Date.now() - startTime;
    const header = result as ResultSetHeader;

    logger.info('Write operation executed', {
      affectedRows: header.affectedRows ?? 0,
      insertId: header.insertId ?? 0,
      duration,
    });

    return {
      affectedRows: header.affectedRows ?? 0,
      insertId: header.insertId ?? 0,
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error('Write operation failed', {
      error: getErrorMessage(error),
      duration,
      ...queryFingerprint(query),
    });

    throw error;
  }
}

/**
 * Execute a query that returns a single scalar value
 */
export async function executeScalar<T>(
  query: string,
  params: Record<string, SqlParamValue> = {}
): Promise<T | null> {
  const result = await executeQuery(query, params, 1);

  if (result.rows.length === 0) {
    return null;
  }

  const firstRow = result.rows[0] as Record<string, unknown>;
  const keys = Object.keys(firstRow);

  if (keys.length === 0) {
    return null;
  }

  return firstRow[keys[0]] as T;
}

/**
 * Quote an identifier (database, table, column) with backticks
 */
export function quoteIdentifier(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new InvalidOperationError('Invalid identifier: it must be a non-empty string without NUL characters');
  }
  return '`' + name.replace(/`/g, '``') + '`';
}

/** Placeholder prefixes used by the write builders (they cannot collide with WHERE params) */
const VALUE_PREFIX = '__val';
const SET_PREFIX = '__set';

function checkWhereParams(whereParams: Record<string, SqlParamValue>): void {
  for (const key of Object.keys(whereParams)) {
    if (key.startsWith(VALUE_PREFIX) || key.startsWith(SET_PREFIX)) {
      throw new InvalidOperationError(
        `Parameter names starting with "${VALUE_PREFIX}" or "${SET_PREFIX}" are reserved`
      );
    }
  }
}

/**
 * Build a parameterized INSERT query.
 * In MySQL, "schema" is the database name; identifiers are quoted with backticks.
 */
export function buildInsertQuery(
  schema: string,
  table: string,
  data: Record<string, SqlParamValue>
): { query: string; params: Record<string, SqlParamValue> } {
  const columns = Object.keys(data);
  const params: Record<string, SqlParamValue> = {};
  const placeholders = columns.map((col, i) => {
    params[`${VALUE_PREFIX}${i}`] = data[col];
    return `@${VALUE_PREFIX}${i}`;
  });

  const query = `
    INSERT INTO ${quoteIdentifier(schema)}.${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')})
    VALUES (${placeholders.join(', ')});
  `;

  return { query, params };
}

/**
 * Build a parameterized UPDATE query.
 * SET values use reserved placeholder names, so a WHERE parameter can never
 * replace a value of the SET clause.
 */
export function buildUpdateQuery(
  schema: string,
  table: string,
  data: Record<string, SqlParamValue>,
  whereClause: string,
  whereParams: Record<string, SqlParamValue>
): { query: string; params: Record<string, SqlParamValue> } {
  checkWhereParams(whereParams);
  const params: Record<string, SqlParamValue> = { ...whereParams };
  const setClause = Object.keys(data)
    .map((col, i) => {
      params[`${SET_PREFIX}${i}`] = data[col];
      return `${quoteIdentifier(col)} = @${SET_PREFIX}${i}`;
    })
    .join(', ');

  const query = `
    UPDATE ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
    SET ${setClause}
    WHERE ${whereClause};
  `;

  return { query, params };
}

/**
 * Build a parameterized DELETE query
 */
export function buildDeleteQuery(
  schema: string,
  table: string,
  whereClause: string,
  whereParams: Record<string, SqlParamValue>
): { query: string; params: Record<string, SqlParamValue> } {
  checkWhereParams(whereParams);
  const query = `
    DELETE FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
    WHERE ${whereClause};
  `;

  return { query, params: whereParams };
}
