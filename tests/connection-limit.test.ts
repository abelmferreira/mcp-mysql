/**
 * Connection limit (POOL_MAX, max_user_connections) against a fake server
 * that speaks the MySQL protocol, with the real mysql2 pool and the real
 * db/connection.ts. READONLY mode: one connection per query, closed after it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mysql from 'mysql2/promise';
import { startFakeMysql, type FakeServer } from './helpers/fake-mysql-server.js';

const MAX_USER_CONNECTIONS = 5;
const EXTERNAL = 1; // another client of the same account holds one session

const fake = await startFakeMysql({
  maxUserConnections: MAX_USER_CONNECTIONS,
  external: EXTERNAL,
  quitTeardownMs: 50,
  abortTeardownMs: 100,
  queryDelayMs: 20,
  respond: (sql) => (/FROM big/.test(sql) ? Array.from({ length: 500 }, (_, i) => ({ n: String(i) })) : undefined),
});

process.env.READONLY = 'true';
process.env.SQL_SERVER = '127.0.0.1';
process.env.SQL_PORT = String(fake.port);
process.env.POOL_MAX = '3';
process.env.QUERY_TIMEOUT = '5000';
process.env.LOG_LEVEL = 'error';

const { executeQuery } = await import('../src/db/execute.js');
const { closePool } = await import('../src/db/connection.js');
const { getConnectionSlots } = await import('../src/db/connection-slots.js');
const { ConnectionLimitError, getErrorMessage } = await import('../src/utils/errors.js');

/** Wait until the fake server only counts the external sessions */
async function settled(server: FakeServer): Promise<void> {
  for (let i = 0; i < 200 && (server.counted() !== EXTERNAL || getConnectionSlots().inUse > 0); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  await executeQuery('SELECT 2'); // creates the pool
});

afterAll(async () => {
  await closePool();
  await fake.close();
});

beforeEach(async () => {
  fake.setExternal(EXTERNAL);
  await settled(fake);
});

describe('POOL_MAX bounds the connections seen by the server', () => {
  it('8 simultaneous queries, POOL_MAX=3, max_user_connections=5 (1 taken): all complete, none refused', async () => {
    const refusedBefore = fake.refused();
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => executeQuery(`SELECT ${i + 10} AS v`)));
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(fake.refused()).toBe(refusedBefore);
    expect(fake.peak()).toBeLessThanOrEqual(EXTERNAL + 3);
    expect(getConnectionSlots().peak).toBeLessThanOrEqual(3);
  });

  it('also when results are truncated (socket dropped, the server notices later)', async () => {
    const refusedBefore = fake.refused();
    const results = await Promise.all(Array.from({ length: 8 }, () => executeQuery('SELECT n FROM big', {}, 2)));
    expect(results.every((r) => r.truncated && r.rows.length === 2)).toBe(true);
    expect(fake.refused()).toBe(refusedBefore);
    expect(fake.peak()).toBeLessThanOrEqual(EXTERNAL + 3);
  });

  it('control: the mysql2 pool alone (connectionLimit=3, end() per query) goes over the limit', async () => {
    // Same server and limit, without the slots of db/connection-slots.ts:
    // the pool forgets a connection at end() and opens the next one while the
    // server still counts the old one.
    const raw = mysql.createPool({
      host: '127.0.0.1',
      port: fake.port,
      user: 'reader',
      password: 'x',
      connectionLimit: 3,
      gracefulEnd: true,
    });
    const refusedBefore = fake.refused();
    const run = async (i: number) => {
      const conn = await raw.getConnection();
      try {
        await conn.query(`SELECT ${i} AS v`);
      } finally {
        await conn.end();
      }
    };
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => run(i)));
    await raw.end().catch(() => undefined);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fake.refused()).toBeGreaterThan(refusedBefore);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0].reason).toMatchObject({ errno: 1226 });
  });
});

describe('connection limit reached by other clients (1226)', () => {
  it('retries with back-off and succeeds once a session is freed', async () => {
    fake.setExternal(MAX_USER_CONNECTIONS); // the other clients take every session
    const refusedBefore = fake.refused();
    setTimeout(() => fake.setExternal(MAX_USER_CONNECTIONS - 1), 350);
    const result = await executeQuery('SELECT 42 AS v');
    expect(result.rowCount).toBe(1);
    expect(fake.refused()).toBeGreaterThan(refusedBefore);
  });

  it('gives up after 4 attempts with a clear message, without the account name', async () => {
    fake.setExternal(MAX_USER_CONNECTIONS);
    const refusedBefore = fake.refused();
    const started = Date.now();
    const error = await executeQuery('SELECT 43 AS v').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionLimitError);
    expect(fake.refused() - refusedBefore).toBe(4);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400); // 200 + 400 + 800 ms
    const message = getErrorMessage(error);
    expect(message).toMatch(/max_user_connections = 5/);
    expect(message).toMatch(/1226 ER_USER_LIMIT_REACHED/);
    expect(message).toMatch(/lower POOL_MAX \(currently 3\)/);
    expect(message).not.toContain('reader');
    expect(message).not.toContain('127.0.0.1');
    expect(getConnectionSlots().inUse).toBe(0);
  });
});
