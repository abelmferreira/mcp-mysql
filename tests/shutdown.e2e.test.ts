import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2';
import { Server, utils, type Connection as SshConnection } from 'ssh2';

/*
 * End-to-end: the COMPILED server (build/index.js) runs as a child process and
 * reaches a fake MySQL server through its built-in SSH tunnel, both served
 * in-process by this test. When the child's stdin closes (or it gets SIGHUP)
 * it must exit 0 and drop the SSH session and the database connections.
 *
 * Needs `npm run build` first (the Docker `test` stage builds before testing);
 * skipped when build/index.js does not exist.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'build', 'index.js');

const hostKey = utils.generateKeyPairSync('ed25519').private;
const clientKey = utils.generateKeyPairSync('ed25519').private;
const clientPub = utils.parseKey(clientKey);
if (clientPub instanceof Error) throw clientPub;

function fingerprintOf(pem: string): string {
  const key = utils.parseKey(pem);
  if (key instanceof Error) throw key;
  return `SHA256:${createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
}

/** Fake MySQL: accepts any login and answers every query with OK */
function startFakeMysql(): Promise<{ port: number; open: () => number; close: () => Promise<void> }> {
  const server = mysql.createServer();
  const sockets = new Set<unknown>();
  server.on('connection', (conn) => {
    sockets.add(conn);
    conn.stream.on('close', () => sockets.delete(conn));
    conn.on('error', () => undefined);
    conn.serverHandshake({
      protocolVersion: 10,
      serverVersion: '8.0.0-fake',
      connectionId: 1,
      statusFlags: 2,
      characterSet: 33,
      capabilityFlags: 0xf7ff,
    });
    conn.on('query', () => conn.writeOk());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server as unknown as { _server: net.Server })._server.address() as net.AddressInfo;
      resolve({
        port: port.port,
        open: () => sockets.size,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** SSH server allowing only key auth and direct-tcpip forwarding */
function startSshServer(): Promise<{ port: number; connected: () => number; close: () => Promise<void> }> {
  const clients = new Set<SshConnection>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey' && ctx.key.data.equals(clientPub.getPublicSSH())) return ctx.accept();
      return ctx.reject();
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, _reject, info) => {
        const channel = accept();
        const target = net.connect(info.destPort, info.destIP);
        channel.pipe(target).pipe(channel);
        target.on('error', () => channel.close());
        channel.on('close', () => target.destroy());
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        connected: () => clients.size,
        close: () =>
          new Promise((r) => {
            clients.forEach((c) => c.end());
            server.close(() => r());
          }),
      })
    );
  });
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startChild(): Promise<{
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: () => string;
  ssh: Awaited<ReturnType<typeof startSshServer>>;
  db: Awaited<ReturnType<typeof startFakeMysql>>;
}> {
  const db = await startFakeMysql();
  cleanups.push(db.close);
  const ssh = await startSshServer();
  cleanups.push(ssh.close);

  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-mysql-e2e-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const keyPath = path.join(dir, 'id_ed25519');
  writeFileSync(keyPath, clientKey, { mode: 0o600 });

  const child = spawn(process.execPath, [entry], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      READONLY: 'true',
      LOG_LEVEL: 'info',
      SQL_SERVER: '127.0.0.1',
      SQL_PORT: String(db.port),
      SQL_DATABASE: 'test',
      SQL_USER: 'test',
      SQL_PASSWORD: 'test',
      SSH_HOST: '127.0.0.1',
      SSH_PORT: String(ssh.port),
      SSH_USER: 'tunnel',
      SSH_KEY_PATH: keyPath,
      SSH_HOST_FINGERPRINT: fingerprintOf(hostKey),
    },
  });
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += d.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  );

  const running = await waitFor(() => stderr.includes('MCP server running'), 30000);
  if (!running) throw new Error(`server did not start:\n${stderr}`);
  return { child, exited, stderr: () => stderr, ssh, db };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([promise, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

describe.skipIf(!existsSync(entry))('compiled server shutdown (e2e, fake SSH + MySQL)', () => {
  it('answers initialize and exits 0, closing tunnel and connections, when stdin closes', async () => {
    const t = await startChild();
    expect(t.ssh.connected()).toBe(1);

    const reply = new Promise<string>((resolve) => t.child.stdout!.once('data', (d) => resolve(d.toString())));
    t.child.stdin!.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
      })}\n`
    );
    expect(JSON.parse(await reply)).toMatchObject({ id: 1, result: { serverInfo: { name: expect.any(String) } } });

    t.child.stdin!.end();

    expect(await withTimeout(t.exited, 15000)).toEqual({ code: 0, signal: null });
    expect(t.stderr()).toContain('stdin closed');
    expect(await waitFor(() => t.ssh.connected() === 0)).toBe(true);
    expect(await waitFor(() => t.db.open() === 0)).toBe(true);
  }, 60000);

  it('exits 0 on SIGHUP', async () => {
    const t = await startChild();
    t.child.kill('SIGHUP');
    expect(await withTimeout(t.exited, 15000)).toEqual({ code: 0, signal: null });
    expect(t.stderr()).toContain('SIGHUP');
    expect(await waitFor(() => t.ssh.connected() === 0)).toBe(true);
  }, 60000);
});
