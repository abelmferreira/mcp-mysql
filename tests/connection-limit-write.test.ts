/**
 * Connection limit in normal mode (READONLY=false): connections go back to
 * the pool and stay open (idle), errors close them with COM_QUIT. The server
 * must never see more than POOL_MAX of them.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { startFakeMysql } from './helpers/fake-mysql-server.js';

const fake = await startFakeMysql({
  maxUserConnections: 4,
  external: 1,
  quitTeardownMs: 50,
  abortTeardownMs: 50,
  queryDelayMs: 15,
  failWith: (sql) => (/FROM missing/.test(sql) ? { errno: 1146, message: "Table 'app.missing' doesn't exist" } : undefined),
});

process.env.READONLY = 'false';
process.env.SQL_SERVER = '127.0.0.1';
process.env.SQL_PORT = String(fake.port);
process.env.POOL_MAX = '3';
process.env.QUERY_TIMEOUT = '5000';
process.env.LOG_LEVEL = 'error';

const { executeQuery, executeWrite } = await import('../src/db/execute.js');
const { closePool } = await import('../src/db/connection.js');

afterAll(async () => {
  await closePool();
  await fake.close();
});

describe('READONLY=false', () => {
  it('reads and writes at once stay within POOL_MAX (idle pooled connections included)', async () => {
    const work = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? executeQuery(`SELECT ${i} AS v`) : executeWrite(`UPDATE t SET a = ${i} WHERE id = 1`)
    );
    const results = await Promise.allSettled(work);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(fake.refused()).toBe(0);
    expect(fake.peak()).toBeLessThanOrEqual(1 + 3);
  });

  it('failed statements close their connection (COM_QUIT); the slot waits for the close', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => executeQuery(i % 2 === 0 ? 'SELECT * FROM missing' : `SELECT ${i} AS v`))
    );
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(6);
    for (const r of rejected) expect(r.reason).toMatchObject({ errno: 1146 });
    expect(fake.refused()).toBe(0);
    expect(fake.peak()).toBeLessThanOrEqual(1 + 3);
  });
});
