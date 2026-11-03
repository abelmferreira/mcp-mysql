/**
 * Unit tests: FIFO connection slots, retry on connection limit errors,
 * ConnectionLimitError message, column default normalization.
 */
import { describe, it, expect } from 'vitest';

const { ConnectionSlots, connectWithRetry, CONNECTION_RETRY_DELAYS_MS, CONNECTION_RETRY_JITTER_MS } = await import(
  '../src/db/connection-slots.js'
);
const { ConnectionLimitError, getErrorMessage, isConnectionLimitError } = await import('../src/utils/errors.js');
const { columnDefaultIsExpression, normalizeColumnDefaults } = await import('../src/tools/helpers.js');
const { config } = await import('../src/config.js');

function dbError(errno: number, code: string, sqlMessage: string) {
  return Object.assign(new Error(sqlMessage), { errno, code, sqlMessage });
}
const userLimit = () =>
  dbError(1226, 'ER_USER_LIMIT_REACHED', "User 'reader' has exceeded the 'max_user_connections' resource (current value: 5)");
const tooMany = () => dbError(1040, 'ER_CON_COUNT_ERROR', 'Too many connections');

describe('ConnectionSlots', () => {
  it('never hands out more than max, and serves waiters first come first served', async () => {
    const slots = new ConnectionSlots(2);
    const a = await slots.acquire();
    const b = await slots.acquire();
    const order: string[] = [];
    const c = slots.acquire().then((s) => (order.push('c'), s));
    const d = slots.acquire().then((s) => (order.push('d'), s));
    await Promise.resolve();
    expect(slots.inUse).toBe(2);
    expect(slots.queued).toBe(2);
    a!.release();
    a!.release(); // idempotent: frees one slot only
    const sc = await c;
    expect(order).toEqual(['c']);
    expect(slots.inUse).toBe(2);
    b!.release();
    await d;
    expect(order).toEqual(['c', 'd']);
    sc!.release();
    (await d)!.release();
    expect(slots.inUse).toBe(0);
    expect(slots.peak).toBe(2);
  });

  it('acquire(timeout) resolves null when no slot frees in time, and leaves the queue', async () => {
    const slots = new ConnectionSlots(1);
    const a = await slots.acquire();
    expect(await slots.acquire(20)).toBeNull();
    expect(slots.queued).toBe(0);
    a!.release();
    expect(slots.inUse).toBe(0);
  });

  it('rejects a non positive size', () => {
    expect(() => new ConnectionSlots(0)).toThrow();
  });
});

describe('connectWithRetry', () => {
  const noSleep = async () => undefined;

  it('retries 1226 and 1040 with 200/400/800 ms (+ jitter) and returns once connected', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await connectWithRetry(
      async () => {
        calls++;
        if (calls === 1) throw userLimit();
        if (calls === 2) throw tooMany();
        if (calls === 3) throw userLimit();
        return 'conn';
      },
      Date.now() + 60_000,
      async (ms) => void delays.push(ms)
    );
    expect(result).toBe('conn');
    expect(calls).toBe(4);
    delays.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(CONNECTION_RETRY_DELAYS_MS[i]);
      expect(ms).toBeLessThan(CONNECTION_RETRY_DELAYS_MS[i] + CONNECTION_RETRY_JITTER_MS);
    });
  });

  it('gives up after 4 attempts with a ConnectionLimitError', async () => {
    let calls = 0;
    const error = await connectWithRetry(
      async () => {
        calls++;
        throw userLimit();
      },
      Date.now() + 60_000,
      noSleep
    ).catch((e: unknown) => e);
    expect(calls).toBe(4);
    expect(error).toBeInstanceOf(ConnectionLimitError);
    expect(error).toMatchObject({ errno: 1226, attempts: 4, code: 'CONNECTION_LIMIT' });
  });

  it('stops early when the next back-off would pass the deadline (QUERY_TIMEOUT)', async () => {
    let calls = 0;
    const error = await connectWithRetry(
      async () => {
        calls++;
        throw tooMany();
      },
      Date.now() + 150,
      noSleep
    ).catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(error).toMatchObject({ errno: 1040, attempts: 1 });
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    const denied = dbError(1045, 'ER_ACCESS_DENIED_ERROR', "Access denied for user 'reader'@'host'");
    await expect(
      connectWithRetry(
        async () => {
          calls++;
          throw denied;
        },
        Date.now() + 60_000,
        noSleep
      )
    ).rejects.toBe(denied);
    expect(calls).toBe(1);
  });
});

describe('ConnectionLimitError', () => {
  it('1226: names the limit and suggests lowering POOL_MAX, without account or host', () => {
    const message = getErrorMessage(ConnectionLimitError.from(userLimit(), 4, 3));
    expect(message).toBe(
      'Could not open a database connection: the database account reached its connection limit ' +
        '(MySQL error 1226 ER_USER_LIMIT_REACHED, max_user_connections = 5); gave up after 4 attempt(s). ' +
        'The connections are in use by other clients (other sessions or applications using the same account or server). ' +
        'Try again later, or lower POOL_MAX (currently 3) so that this MCP server needs fewer simultaneous connections.'
    );
    expect(message).not.toContain('reader');
  });

  it('1040: names max_connections', () => {
    expect(getErrorMessage(ConnectionLimitError.from(tooMany(), 2, config.POOL_MAX))).toMatch(
      /server reached its connection limit \(MySQL error 1040 ER_CON_COUNT_ERROR, max_connections\); gave up after 2 attempt/
    );
  });

  it('is not retried again once raised', () => {
    expect(isConnectionLimitError(userLimit())).toBe(true);
    expect(isConnectionLimitError(ConnectionLimitError.from(userLimit(), 4, 3))).toBe(false);
  });
});

describe('defaults', () => {
  it('POOL_MAX is 3 and MAX_RESULT_BYTES is 1 MiB unless configured', async () => {
    const { parseConfig } = await import('../src/config.js');
    const parsed = parseConfig({ READONLY: 'true', SQL_SERVER: 'h', SQL_DATABASE: 'd', SQL_USER: 'u', SQL_PASSWORD: 'p' });
    expect(parsed.POOL_MAX).toBe(3);
    expect(parsed.MAX_RESULT_BYTES).toBe(1048576);
  });
});

describe('column defaults (information_schema.COLUMNS.COLUMN_DEFAULT)', () => {
  const rows = () => [
    { name: 'id', defaultValue: null },
    { name: 'note', defaultValue: 'NULL' },
    { name: 'title', defaultValue: "'abc'" },
    { name: 'label', defaultValue: "'NULL'" },
    { name: 'created', defaultValue: 'current_timestamp()' },
    { name: 'n', defaultValue: '0' },
  ];

  it('MariaDB 10.2.7+: the word NULL becomes null, quoted literals and expressions are kept', () => {
    const out = normalizeColumnDefaults(rows(), { version: '10.11.6-MariaDB-log', isMariaDB: true });
    expect(out.map((r) => r.defaultValue)).toEqual([null, null, "'abc'", "'NULL'", 'current_timestamp()', '0']);
  });

  it('MySQL: untouched (NULL is a real null there, and "NULL" a string default)', () => {
    const mysqlRows = [
      { name: 'id', defaultValue: null },
      { name: 'label', defaultValue: 'NULL' },
      { name: 'title', defaultValue: 'abc' },
    ];
    const out = normalizeColumnDefaults(mysqlRows, { version: '8.0.36', isMariaDB: false });
    expect(out.map((r) => r.defaultValue)).toEqual([null, 'NULL', 'abc']);
  });

  it.each([
    ['10.2.6-MariaDB', false],
    ['10.2.7-MariaDB', true],
    ['10.1.48-MariaDB', false],
    ['5.5.5-10.6.12-MariaDB', true],
    ['11.4.2-MariaDB', true],
    ['5.5.68-MariaDB', false],
  ])('MariaDB %s quotes defaults: %s', (version, expected) => {
    expect(columnDefaultIsExpression({ version, isMariaDB: true })).toBe(expected);
  });
});
