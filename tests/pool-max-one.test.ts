/**
 * POOL_MAX=1 against a fake server whose account allows a single connection
 * (max_user_connections=1): any overlap would be refused with 1226. Every
 * tool, including the ones that run several queries, must work, alone and
 * concurrently, without deadlock.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { startFakeMysql } from './helpers/fake-mysql-server.js';

const fake = await startFakeMysql({
  maxUserConnections: 1,
  quitTeardownMs: 30,
  abortTeardownMs: 30,
  queryDelayMs: (sql) => (/SLOW_TABLE/.test(sql) ? 5000 : 5),
  version: '10.11.6-MariaDB-log',
  respond: (sql) =>
    /COLUMN_DEFAULT AS `defaultValue`/.test(sql)
      ? [
          { name: 'id', defaultValue: null },
          { name: 'note', defaultValue: 'NULL' },
          { name: 'title', defaultValue: "'abc'" },
          { name: 'label', defaultValue: "'NULL'" },
          { name: 'created', defaultValue: 'current_timestamp()' },
        ]
      : undefined,
});

process.env.READONLY = 'true';
process.env.SQL_SERVER = '127.0.0.1';
process.env.SQL_PORT = String(fake.port);
process.env.POOL_MAX = '1';
process.env.QUERY_TIMEOUT = '1000';
process.env.LOG_LEVEL = 'error';

const { executeQuery } = await import('../src/db/execute.js');
const { closePool } = await import('../src/db/connection.js');
const { getConnectionSlots } = await import('../src/db/connection-slots.js');
const tools = await import('../src/tools/index.js');

afterAll(async () => {
  await closePool();
  await fake.close();
});

type Run = () => Promise<{ isError?: boolean; content: { text: string }[] }>;
const multiQueryTools: Array<[string, Run]> = [
  ['schema_describe_table', () => tools.schemaDescribeTable({ table: 'users' })],
  ['monitor_connections', () => tools.monitorConnections()],
  ['monitor_database_size', () => tools.monitorDatabaseSize()],
  ['schema_list_indexes', () => tools.schemaListIndexes({})],
  ['analyze_statistics', () => tools.analyzeStatistics({})],
  ['monitor_blocking', () => tools.monitorBlocking()],
];

describe('POOL_MAX=1', () => {
  it.each(multiQueryTools)('%s works with a single connection', async (_name, run) => {
    const res = await run();
    expect(res.isError, res.content[0].text).toBeFalsy();
    expect(fake.refused()).toBe(0);
  });

  it('all multi-query tools at once: queued, no deadlock, never more than one connection', async () => {
    const results = await Promise.all(multiQueryTools.map(([, run]) => run()));
    for (const res of results) expect(res.isError, res.content[0].text).toBeFalsy();
    expect(fake.refused()).toBe(0);
    expect(fake.peak()).toBe(1);
    expect(getConnectionSlots().peak).toBe(1);
  });

  it('schema_describe_table turns the MariaDB "NULL" default into null over the wire', async () => {
    const body = JSON.parse((await tools.schemaDescribeTable({ table: 'users' })).content[0].text);
    expect(body.columns.map((c: { defaultValue: unknown }) => c.defaultValue)).toEqual([
      null,
      null,
      "'abc'",
      "'NULL'",
      'current_timestamp()',
    ]);
  });

  it('a timed out query does not deadlock (no spare connection for KILL) and the next query runs', async () => {
    const started = Date.now();
    await expect(executeQuery('SELECT * FROM SLOW_TABLE')).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(4000);
    const next = await executeQuery('SELECT 1 + 1 AS v');
    expect(next.rowCount).toBe(1);
    expect(fake.refused()).toBe(0);
    expect(fake.peak()).toBe(1);
  });
});
