/**
 * Tiny MySQL-protocol server (mysql2 server mode) used by the connection limit
 * tests. It counts the sessions of the account like a real server does for
 * max_user_connections:
 *  - a session counts from the end of the handshake;
 *  - after COM_QUIT it stops counting `quitTeardownMs` later, and only then
 *    is the socket closed (a real server ends the session first, then closes);
 *  - when the client drops the socket, it stops counting `abortTeardownMs`
 *    later (a real server only notices on its next read/write);
 *  - beyond `maxUserConnections` the handshake fails with 1226.
 * `external` sessions stand for other clients of the same account.
 */
import net from 'node:net';
import mysql from 'mysql2';

export interface FakeServerOptions {
  maxUserConnections: number;
  external?: number;
  quitTeardownMs?: number;
  abortTeardownMs?: number;
  /** Delay before answering a user query (makes queries overlap) */
  queryDelayMs?: number | ((sql: string) => number);
  version?: string;
  /** Rows for a user query (default: one row { x: '1' }) */
  respond?: (sql: string) => Record<string, string | null>[] | undefined;
  /** Answer a user query with an error */
  failWith?: (sql: string) => { errno: number; message: string } | undefined;
  /** Refuse with this errno instead of 1226 (e.g. 1040) */
  limitErrno?: number;
}

export interface FakeServer {
  port: number;
  /** Sessions counted now (including the external ones) */
  counted(): number;
  /** Highest count seen */
  peak(): number;
  /** Handshakes refused with the limit error */
  refused(): number;
  /** User queries received */
  queries(): string[];
  setExternal(n: number): void;
  close(): Promise<void>;
}

const COLUMN_BASE = {
  catalog: 'def',
  schema: '',
  table: '',
  orgTable: '',
  characterSet: 33,
  columnLength: 1024,
  columnType: 253, // VAR_STRING
  flags: 0,
  decimals: 0,
};

/**
 * mysql2's server mode does not reset the packet sequence per command and
 * prints "got packets out of order" with console.error; drop that noise.
 */
let consoleFiltered = false;
function filterSequenceWarnings(): void {
  if (consoleFiltered) return;
  consoleFiltered = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('Warning: got packets out of order')) return;
    original(...args);
  };
}

export function startFakeMysql(options: FakeServerOptions): Promise<FakeServer> {
  filterSequenceWarnings();
  const version = options.version ?? '10.11.6-MariaDB';
  const quitTeardownMs = options.quitTeardownMs ?? 50;
  const abortTeardownMs = options.abortTeardownMs ?? 50;
  let external = options.external ?? 0;
  let ours = 0;
  let peak = external;
  let refused = 0;
  let nextId = 100;
  const queries: string[] = [];
  const sockets = new Set<net.Socket>();

  const counted = () => external + ours;

  // mysql2 typings do not cover server mode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server: any = (mysql as any).createServer();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const writeRows = (conn: any, rows: Record<string, string | null>[]) => {
    const names = rows.length > 0 ? Object.keys(rows[0]) : ['x'];
    conn.writeColumns(names.map((name) => ({ ...COLUMN_BASE, name, orgName: name })));
    for (const row of rows) conn.writeTextRow(names.map((n) => row[n]));
    conn.writeEof();
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.on('connection', (conn: any) => {
    let counting = false;
    const stream = conn.stream as net.Socket;
    sockets.add(stream);
    const stopCounting = (delay: number, then?: () => void) => {
      if (!counting) {
        then?.();
        return;
      }
      counting = false;
      setTimeout(() => {
        ours--;
        then?.();
      }, delay);
    };

    conn.on('error', () => undefined);
    stream.on('error', () => undefined);
    stream.on('close', () => {
      sockets.delete(stream);
      stopCounting(abortTeardownMs);
    });

    conn.serverHandshake({
      protocolVersion: 10,
      serverVersion: version,
      connectionId: nextId++,
      statusFlags: 2,
      characterSet: 33,
      capabilityFlags: 0xffffff,
      authCallback: (_params: unknown, cb: (err: Error | null, mysqlError?: { message: string; code: number }) => void) => {
        if (counted() >= options.maxUserConnections) {
          refused++;
          const errno = options.limitErrno ?? 1226;
          cb(null, {
            code: errno,
            message:
              errno === 1226
                ? `User 'reader' has exceeded the 'max_user_connections' resource (current value: ${options.maxUserConnections})`
                : 'Too many connections',
          });
          return;
        }
        ours++;
        counting = true;
        peak = Math.max(peak, counted());
        cb(null);
      },
    });

    const answer = (sql: string) => {
      if (/^(SET|START|ROLLBACK|KILL)\b/i.test(sql)) {
        conn.writeOk();
        return;
      }
      if (/@@SESSION\.sql_mode AS sqlMode, @@version/.test(sql)) {
        writeRows(conn, [{ sqlMode: 'STRICT_TRANS_TABLES', version }]);
        return;
      }
      if (/@@performance_schema AS performanceSchema/.test(sql)) {
        writeRows(conn, [{ version, performanceSchema: '0' }]);
        return;
      }
      if (sql === 'SELECT 1') {
        writeRows(conn, [{ '1': '1' }]);
        return;
      }
      queries.push(sql);
      if (/^(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
        conn.writeOk({ affectedRows: 1, insertId: 0 });
        return;
      }
      const failure = options.failWith?.(sql);
      const rows = options.respond?.(sql) ?? [{ x: '1' }];
      const send = () => {
        if (stream.destroyed) return;
        if (failure) conn.writeError({ code: failure.errno, message: failure.message });
        else writeRows(conn, rows);
      };
      const delay = typeof options.queryDelayMs === 'function' ? options.queryDelayMs(sql) : (options.queryDelayMs ?? 0);
      if (delay > 0) setTimeout(send, delay);
      else send();
    };

    conn.on('query', answer);
    // mysql2 server mode routes "SET ..." to stmt_prepare
    conn.on('stmt_prepare', answer);
    conn.on('quit', () => stopCounting(quitTeardownMs, () => stream.end()));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server._server as net.Server).address() as net.AddressInfo;
      resolve({
        port: port.port,
        counted,
        peak: () => peak,
        refused: () => refused,
        queries: () => [...queries],
        setExternal: (n: number) => {
          external = n;
          peak = Math.max(peak, counted());
        },
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            (server._server as net.Server).close(() => done());
          }),
      });
    });
  });
}
