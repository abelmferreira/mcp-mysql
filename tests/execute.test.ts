/**
 * executeQuery / tools with a fake mysql2 pool (no database needed).
 *
 * Covers the security review items A4 (sql_mode), A5 (streaming + limits),
 * A6 (timeouts, fail closed), A7 (no session state survives a query),
 * A11 (analyze_query), C1, C2, C6, C7, C8 and the error redaction.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Small limits for this file (config is read when the modules are imported below)
process.env.QUERY_TIMEOUT = '1000';
process.env.MAX_RESULT_BYTES = '65536';
process.env.MAX_ROWS = '1000';

interface DbError extends Error {
  errno: number;
  code: string;
  sqlMessage: string;
}

function dbError(errno: number, code: string, sqlMessage: string): DbError {
  return Object.assign(new Error(sqlMessage), { errno, code, sqlMessage });
}

type Responder = (sql: string) => { rows?: number | Record<string, unknown>[]; row?: (i: number) => Record<string, unknown>; error?: Error; hang?: boolean } | undefined;

const state = {
  calls: [] as string[],
  poolQueries: [] as string[],
  released: 0,
  destroyed: 0,
  quit: 0,
  socketsDestroyed: 0,
  emitted: 0,
  sqlMode: 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION',
  sqlModeSticky: false,
  version: '8.0.36',
  performanceSchema: 1 as number,
  failSet: null as RegExp | null,
  responder: (() => undefined) as Responder,
};

function makeConn() {
  let destroyed = false;
  const conn = {
    threadId: 42,
    async query(sql: string): Promise<[unknown, unknown]> {
      state.calls.push(sql);
      if (/^SELECT @@SESSION\.sql_mode AS sqlMode, @@version/.test(sql)) {
        return [[{ sqlMode: state.sqlMode, version: state.version }], []];
      }
      if (/^SELECT @@SESSION\.sql_mode AS sqlMode$/.test(sql)) {
        return [[{ sqlMode: state.sqlMode }], []];
      }
      if (state.failSet && state.failSet.test(sql)) {
        throw dbError(1193, 'ER_UNKNOWN_SYSTEM_VARIABLE', `Unknown system variable in: ${sql.slice(0, 30)}`);
      }
      const m = /^SET SESSION sql_mode = '(.*)'$/.exec(sql);
      if (m) {
        if (!state.sqlModeSticky) state.sqlMode = m[1];
        return [{}, undefined];
      }
      if (/^(SET|START|ROLLBACK)/.test(sql)) return [{}, undefined];
      return [[], []];
    },
    connection: {
      query(sql: string): EventEmitter {
        state.calls.push(sql);
        const emitter = new EventEmitter();
        let answer = state.responder(sql);
        if (!answer && /@@performance_schema AS performanceSchema/.test(sql)) {
          answer = { rows: [{ version: state.version, performanceSchema: state.performanceSchema }] };
        }
        setImmediate(async () => {
          if (answer?.error) {
            emitter.emit('error', answer.error);
            return;
          }
          if (answer?.hang) return;
          emitter.emit('fields', [{ name: 'x', type: 253 }]);
          const rows = answer?.rows ?? [];
          const count = typeof rows === 'number' ? rows : rows.length;
          for (let i = 0; i < count; i++) {
            if (destroyed) return; // the socket is gone
            state.emitted++;
            emitter.emit('result', typeof rows === 'number' ? (answer?.row ?? ((n: number) => ({ n })))(i) : rows[i]);
            if (i % 100 === 99) await new Promise((r) => setImmediate(r));
          }
          emitter.emit('end');
        });
        return emitter;
      },
    },
    release() {
      state.released++;
    },
    destroy() {
      destroyed = true;
      state.destroyed++;
    },
    async end() {
      destroyed = true;
      state.quit++;
    },
  };
  Object.assign(conn.connection, {
    stream: {
      destroy() {
        state.socketsDestroyed++;
      },
    },
  });
  return conn;
}

vi.mock('../src/db/connection.js', () => ({
  getPool: async () => ({
    getConnection: async () => makeConn(),
    query: async (sql: string) => {
      state.poolQueries.push(sql);
      return [{}, undefined];
    },
  }),
  closePool: async () => undefined,
  isConnected: () => true,
  getPoolStats: () => ({}),
}));

const { executeQuery } = await import('../src/db/execute.js');
const { resetServerInfo } = await import('../src/db/server-info.js');
const { getErrorMessage, ReadOnlyViolationError } = await import('../src/utils/errors.js');
const tools = await import('../src/tools/index.js');

beforeEach(() => {
  state.calls = [];
  state.poolQueries = [];
  state.released = 0;
  state.destroyed = 0;
  state.quit = 0;
  state.socketsDestroyed = 0;
  state.emitted = 0;
  state.sqlMode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';
  state.sqlModeSticky = false;
  state.version = '8.0.36';
  state.performanceSchema = 1;
  state.failSet = null;
  state.responder = () => undefined;
  resetServerInfo();
});

const userCalls = () =>
  state.calls.filter((c) => !/^(SET|START|ROLLBACK)|^SELECT @@SESSION\.sql_mode/.test(c));

describe('session preparation (A4, A6)', () => {
  it('E1 order: read sql_mode/version -> statement timeout -> READ ONLY transaction -> query', async () => {
    await executeQuery('SELECT 1');
    expect(state.calls).toEqual([
      'SELECT @@SESSION.sql_mode AS sqlMode, @@version AS version',
      'SET SESSION max_execution_time = 1000',
      'START TRANSACTION READ ONLY',
      'SELECT 1',
    ]);
  });

  it('E1b MariaDB uses max_statement_time (seconds)', async () => {
    state.version = '10.11.6-MariaDB';
    await executeQuery('SELECT 1');
    expect(state.calls[1]).toBe('SET SESSION max_statement_time = 1.000');
  });

  it('E2 fails closed when no statement timeout can be set (READONLY)', async () => {
    state.failSet = /^SET SESSION max_/;
    await expect(executeQuery('SELECT 1')).rejects.toThrow(/statement timeout/);
    expect(state.calls).not.toContain('SELECT 1');
    expect(state.quit).toBe(1);
    expect(state.released).toBe(0);
  });

  it('E2b falls back to the other timeout variable', async () => {
    state.failSet = /^SET SESSION max_execution_time/;
    await executeQuery('SELECT 1');
    expect(state.calls).toContain('SET SESSION max_statement_time = 1.000');
    expect(state.calls).toContain('SELECT 1');
  });

  it('A4 removes NO_BACKSLASH_ESCAPES / ANSI_QUOTES / ANSI from the session sql_mode', async () => {
    state.sqlMode = 'REAL_AS_FLOAT,PIPES_AS_CONCAT,ANSI_QUOTES,IGNORE_SPACE,ONLY_FULL_GROUP_BY,ANSI,NO_BACKSLASH_ESCAPES';
    await executeQuery('SELECT 1');
    expect(state.calls).toContain("SET SESSION sql_mode = 'REAL_AS_FLOAT,PIPES_AS_CONCAT,IGNORE_SPACE,ONLY_FULL_GROUP_BY'");
    expect(state.calls).toContain('SELECT 1');
  });

  it('A4 refuses to run when the unsafe sql_mode cannot be removed', async () => {
    state.sqlMode = 'NO_BACKSLASH_ESCAPES';
    state.sqlModeSticky = true;
    await expect(executeQuery('SELECT 1')).rejects.toThrow(/NO_BACKSLASH_ESCAPES/);
    expect(state.calls).not.toContain('SELECT 1');
  });
});

describe('connection state (A7)', () => {
  it('READONLY connections are closed (COM_QUIT), never returned to the pool', async () => {
    await executeQuery('SELECT 1');
    await executeQuery('SELECT 2');
    expect(state.quit).toBe(2);
    expect(state.released).toBe(0);
    expect(state.socketsDestroyed).toBe(0);
  });

  it('also on query errors', async () => {
    state.responder = (sql) => (sql === 'SELECT 1' ? { error: dbError(1146, 'ER_NO_SUCH_TABLE', "Table 'x' doesn't exist") } : undefined);
    await expect(executeQuery('SELECT 1')).rejects.toThrow();
    expect(state.quit).toBe(1);
    expect(state.released).toBe(0);
  });
});

describe('streaming and limits (A5)', () => {
  it('stops reading after maxRows + 1 rows instead of buffering everything', async () => {
    state.responder = (sql) => (sql.startsWith('SELECT * FROM big') ? { rows: 200000 } : undefined);
    const r = await executeQuery('SELECT * FROM big', {}, 10);
    expect(r.rows).toHaveLength(10);
    expect(r.rowCount).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe('maxRows');
    expect(state.emitted).toBeLessThan(200);
    // the socket is dropped at once, the rest of the result is never read
    expect(state.destroyed).toBe(1);
    expect(state.socketsDestroyed).toBe(1);
  });

  it('is not truncated when the result fits', async () => {
    state.responder = (sql) => (sql.startsWith('SELECT * FROM small') ? { rows: 10 } : undefined);
    const r = await executeQuery('SELECT * FROM small', {}, 10);
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(false);
  });

  it('caps maxRows with MAX_ROWS', async () => {
    state.responder = (sql) => (sql.startsWith('SELECT * FROM big') ? { rows: 5000 } : undefined);
    const r = await executeQuery('SELECT * FROM big', {}, 5000);
    expect(r.rows).toHaveLength(1000);
    expect(r.truncated).toBe(true);
  });

  it('stops at the response size limit (MAX_RESULT_BYTES)', async () => {
    state.responder = (sql) =>
      sql.startsWith('SELECT REPEAT') ? { rows: 1000, row: () => ({ x: 'x'.repeat(10000) }) } : undefined;
    const r = await executeQuery("SELECT REPEAT('x', 10000) FROM big", {}, 1000);
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe('maxBytes');
    expect(r.rows.length).toBeLessThan(7);
    expect(state.emitted).toBeLessThan(150);
  });

  it('sql_execute reports truncation in the same response format', async () => {
    state.responder = (sql) => (sql.startsWith('SELECT * FROM big') ? { rows: 50 } : undefined);
    const res = await tools.sqlExecute({ query: 'SELECT * FROM big', maxRows: 5 });
    const body = JSON.parse(res.content[0].text);
    expect(body).toMatchObject({ rowCount: 5, truncated: true });
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['rows', 'rowCount', 'fields', 'duration', 'truncated']));
  });
});

describe('timeouts (A6, C8)', () => {
  it('client-side timeout: KILL QUERY on another connection, connection destroyed, TimeoutError', async () => {
    state.responder = (sql) => (sql.startsWith('SELECT * FROM slow') ? { hang: true } : undefined);
    await expect(executeQuery('SELECT * FROM slow')).rejects.toThrow(/timed out/);
    expect(state.poolQueries).toEqual(['KILL QUERY 42']);
    expect(state.destroyed).toBe(1);
    expect(state.socketsDestroyed).toBe(1);
  });

  it.each([
    [1969, 'ER_STATEMENT_TIMEOUT', 'Query execution was interrupted (max_statement_time exceeded)'],
    [3024, 'ER_QUERY_TIMEOUT', 'Query execution was interrupted, maximum statement execution time exceeded'],
    [1317, 'ER_QUERY_INTERRUPTED', 'Query execution was interrupted'],
  ])('server errno %i is reported as a timeout', async (errno, code, msg) => {
    state.responder = (sql) => (sql.startsWith('SELECT * FROM t') ? { error: dbError(errno, code, msg) } : undefined);
    await expect(executeQuery('SELECT * FROM t')).rejects.toThrow(/timed out after 1000ms/);
  });

  it('other errors keep their errno and are not reported as timeouts', async () => {
    state.responder = (sql) =>
      sql.startsWith('SELECT * FROM t') ? { error: dbError(1054, 'ER_BAD_FIELD_ERROR', "Unknown column 'timeout' in 'field list'") } : undefined;
    await expect(executeQuery('SELECT * FROM t')).rejects.toMatchObject({ errno: 1054 });
  });
});

describe('validation of the final SQL', () => {
  it('validates the template and the text actually sent', async () => {
    await executeQuery('SELECT * FROM t WHERE a = @a', { a: "x'y" });
    expect(userCalls()).toEqual(["SELECT * FROM t WHERE a = 'x\\'y'"]);
  });

  it('refuses user variables that are not parameters', async () => {
    await expect(executeQuery("SELECT @`x` := 'y'")).rejects.toThrow(/User variables/);
    expect(state.calls).toEqual([]);
  });
});

describe('errors returned to the client', () => {
  it('drop account names and IP addresses (by errno)', () => {
    const msg = getErrorMessage(
      dbError(1142, 'ER_TABLEACCESS_DENIED_ERROR', "SELECT command denied to user 'reader'@'192.0.2.10' for table 'user'")
    );
    expect(msg).toBe("MySQL error 1142 (ER_TABLEACCESS_DENIED_ERROR): SELECT command denied to user '***'@'***' for table 'user'");
    expect(getErrorMessage(new Error('connect ECONNREFUSED 192.0.2.10:3306'))).toBe('connect ECONNREFUSED <host>');
    expect(getErrorMessage(new Error('getaddrinfo ENOTFOUND db.internal.example'))).toBe('getaddrinfo ENOTFOUND <host>');
  });

  it('C1 ReadOnlyViolationError names the operation', async () => {
    expect(new ReadOnlyViolationError('DELETE').message).toBe(
      'Operation blocked in READONLY mode: DELETE is not allowed. Only read queries are permitted; set READONLY=false to enable the write tools.'
    );
    const res = await tools.sqlDelete({ table: 't', where: '1=1' });
    expect(res.content[0].text).toContain('DELETE is not allowed');
  });
});

describe('read tools in READONLY mode', () => {
  const cases: Array<[string, () => Promise<{ isError?: boolean; content: { text: string }[] }>]> = [
    ['schema_list_tables', () => tools.schemaListTables({})],
    ['schema_describe_table', () => tools.schemaDescribeTable({ table: 'users' })],
    ['schema_list_columns', () => tools.schemaListColumns({ pattern: '%id%' })],
    ['schema_list_procedures', () => tools.schemaListProcedures({})],
    ['schema_list_indexes', () => tools.schemaListIndexes({})],
    ['monitor_active_queries', () => tools.monitorActiveQueries({})],
    ['monitor_blocking', () => tools.monitorBlocking()],
    ['monitor_wait_stats', () => tools.monitorWaitStats({})],
    ['monitor_database_size', () => tools.monitorDatabaseSize()],
    ['monitor_connections', () => tools.monitorConnections()],
    ['monitor_performance_counters', () => tools.monitorPerformanceCounters({ category: 'buffer' })],
    ['analyze_query', () => tools.analyzeQuery({ query: 'SELECT * FROM users WHERE id = @id', params: { id: 1 } })],
    ['analyze_suggest_indexes', () => tools.analyzeSuggestIndexes({})],
    ['analyze_unused_indexes', () => tools.analyzeUnusedIndexes({})],
    ['analyze_duplicate_indexes', () => tools.analyzeDuplicateIndexes({})],
    ['analyze_fragmentation', () => tools.analyzeFragmentation({})],
    ['analyze_statistics', () => tools.analyzeStatistics({})],
  ];

  it.each(cases)('%s passes the validator and runs inside a READ ONLY transaction', async (_name, run) => {
    const res = await run();
    expect(res.isError, res.content[0].text).toBeFalsy();
    expect(userCalls().length).toBeGreaterThan(0);
    expect(state.calls).toContain('START TRANSACTION READ ONLY');
  });

  it('T1 analyze_query looks digests up with STATEMENT_DIGEST() of the bound query', async () => {
    await tools.analyzeQuery({ query: "SELECT * FROM t WHERE a = @a", params: { a: 'x' }, includeExecutionPlan: false });
    const c = state.calls.find((x) => /events_statements_summary_by_digest/.test(x));
    expect(c).toContain("STATEMENT_DIGEST('SELECT * FROM t WHERE a = \\'x\\'')");
  });

  it('T1b analyze_query on MariaDB explains why there are no digest statistics', async () => {
    state.version = '10.11.6-MariaDB';
    const res = await tools.analyzeQuery({ query: 'SELECT 1', includeExecutionPlan: false });
    expect(res.content[0].text).toMatch(/not available on MariaDB/);
    expect(state.calls.some((x) => /events_statements_summary_by_digest/.test(x))).toBe(false);
  });

  it.each([['FOR CONNECTION 42'], ['DELETE FROM t'], ['SHOW TABLES'], ['EXPLAIN SELECT 1']])(
    'T2 analyze_query validates the query on its own before prefixing EXPLAIN: %s',
    async (query) => {
      const res = await tools.analyzeQuery({ query });
      expect(res.isError).toBe(true);
      expect(state.calls.some((x) => x.startsWith('EXPLAIN'))).toBe(false);
    }
  );

  it('T3 write tools refuse at runtime when READONLY=true even if called directly', async () => {
    for (const fn of [tools.sqlInsert, tools.sqlUpdate, tools.sqlDelete]) {
      const res = await fn({ table: 't', data: { a: 1 }, where: '1=1' });
      expect(res.isError).toBe(true);
    }
    expect(state.calls.length).toBe(0);
    expect(tools.getToolDefinitions().map((d) => d.name)).not.toContain('sql_delete');
  });
});

describe('graceful degradation (C6, C7)', () => {
  const denied = (sql: string, pattern: RegExp, errno = 1142) =>
    pattern.test(sql) ? { error: dbError(errno, 'ER_TABLEACCESS_DENIED_ERROR', "SELECT command denied to user 'r'@'h'") } : undefined;

  it('analyze_statistics returns the tables with a warning when mysql.innodb_table_stats is not readable', async () => {
    state.responder = (sql) =>
      denied(sql, /mysql\.innodb_table_stats/) ??
      (/information_schema\.TABLES/.test(sql) ? { rows: [{ schema: 'app', table: 'users' }] } : undefined);
    const res = await tools.analyzeStatistics({});
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.statistics).toHaveLength(1);
    expect(body.statistics[0].status).toMatch(/UNKNOWN/);
    expect(body.warnings[0]).toMatch(/innodb_table_stats/);
    expect(res.content[0].text).not.toContain("'r'@'h'");
  });

  it('schema_list_indexes returns the indexes with a warning when performance_schema is not readable', async () => {
    state.responder = (sql) =>
      denied(sql, /performance_schema\.table_io_waits/) ??
      (/information_schema\.STATISTICS/.test(sql) ? { rows: [{ schema: 'app', table: 'users', indexName: 'PRIMARY' }] } : undefined);
    const res = await tools.schemaListIndexes({});
    const body = JSON.parse(res.content[0].text);
    expect(body.indexes[0]).toMatchObject({ indexName: 'PRIMARY', reads: null });
    expect(body.warnings[0]).toMatch(/Usage counters/);
  });

  it('schema_list_indexes does not query performance_schema when it is OFF', async () => {
    state.performanceSchema = 0;
    const res = await tools.schemaListIndexes({});
    expect(JSON.parse(res.content[0].text).warnings[0]).toMatch(/performance_schema is disabled/);
    expect(state.calls.some((x) => /table_io_waits/.test(x))).toBe(false);
  });

  it('monitor_blocking falls back to information_schema, then degrades to a warning', async () => {
    state.responder = (sql) => denied(sql, /sys\.innodb_lock_waits/, 1356) ?? denied(sql, /INNODB_LOCK_WAITS/, 1227);
    const res = await tools.monitorBlocking();
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.blocking).toEqual([]);
    expect(body.warnings).toHaveLength(2);
  });

  it('monitor_blocking computes head blockers from the fallback source', async () => {
    state.responder = (sql) =>
      denied(sql, /sys\.innodb_lock_waits/, 1146) ??
      (/INNODB_LOCK_WAITS/.test(sql)
        ? { rows: [{ blockedSessionId: 2, blockingSessionId: 1 }, { blockedSessionId: 3, blockingSessionId: 2 }] }
        : undefined);
    const body = JSON.parse((await tools.monitorBlocking()).content[0].text);
    expect(body.headBlockers).toEqual([1]);
    expect(body.source).toBe('information_schema.INNODB_LOCK_WAITS');
  });

  it('monitor_wait_stats warns instead of returning an empty list silently when performance_schema is OFF', async () => {
    state.performanceSchema = 0;
    const body = JSON.parse((await tools.monitorWaitStats({})).content[0].text);
    expect(body.waitStats).toEqual([]);
    expect(body.warnings[0]).toMatch(/performance_schema is disabled/);
  });

  it('monitor_performance_counters uses SHOW GLOBAL STATUS and honours the category', async () => {
    state.responder = (sql) =>
      sql.startsWith('SHOW GLOBAL STATUS')
        ? { rows: [{ Variable_name: 'Innodb_buffer_pool_read_requests', Value: '100' }, { Variable_name: 'Innodb_buffer_pool_reads', Value: '10' }] }
        : undefined;
    const body = JSON.parse((await tools.monitorPerformanceCounters({ category: 'buffer' })).content[0].text);
    const sql = state.calls.find((x) => x.startsWith('SHOW GLOBAL STATUS'))!;
    expect(sql).toContain("'Innodb_buffer_pool_reads'");
    expect(sql).not.toContain("'Com_select'");
    expect(body.bufferPoolHitRatio).toBe(90);
  });

  it('analyze_fragmentation applies minPageCount', async () => {
    await tools.analyzeFragmentation({ minPageCount: 500 });
    const sql = state.calls.find((x) => /information_schema\.TABLES/.test(x))!;
    expect(sql).toContain('/ @@innodb_page_size >= 500');
  });
});
