import { readFileSync } from 'node:fs';
import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ConnectionError, getErrorMessage } from '../utils/errors.js';
import { SshTunnel, loadPrivateKey } from './tunnel.js';

/**
 * Singleton connection pool (and the SSH tunnel it goes through, when enabled)
 */
let pool: Pool | null = null;
let poolPromise: Promise<Pool> | null = null;
let tunnel: SshTunnel | null = null;

/**
 * TLS options. The server certificate is verified by default (chain, and the
 * host name on direct connections); SQL_SSL_REJECT_UNAUTHORIZED=false turns
 * verification off. Through the SSH tunnel the driver connects to 127.0.0.1,
 * so only the chain can be verified, not the host name.
 */
export function buildSslOptions(viaTunnel: boolean): PoolOptions['ssl'] {
  if (!config.SQL_SSL) {
    return undefined;
  }
  const rejectUnauthorized = config.SQL_SSL_REJECT_UNAUTHORIZED;
  if (!rejectUnauthorized) {
    logger.warn(
      'SQL_SSL_REJECT_UNAUTHORIZED=false: the database certificate is NOT verified; the connection is open to man-in-the-middle attacks'
    );
  }
  return {
    rejectUnauthorized,
    verifyIdentity: rejectUnauthorized && !viaTunnel,
    ...(config.SQL_SSL_CA ? { ca: readFileSync(config.SQL_SSL_CA, 'utf8') } : {}),
  };
}

/**
 * MySQL pool configuration for a given host/port (the local tunnel end when SSH is enabled)
 */
function buildPoolOptions(host: string, port: number): PoolOptions {
  return {
    user: config.SQL_USER,
    password: config.SQL_PASSWORD,
    host,
    database: config.SQL_DATABASE,
    port,
    ssl: buildSslOptions(config.SSH !== null),
    waitForConnections: true,
    connectionLimit: config.POOL_MAX,
    queueLimit: 0,
    connectTimeout: config.QUERY_TIMEOUT,
    // Keep DECIMAL/BIGINT as strings unless safe; numbers are returned as numbers
    decimalNumbers: true,
    // Allow multiple statements is intentionally disabled for safety
    multipleStatements: false,
    // conn.end() closes a pooled connection with COM_QUIT (used after every
    // READONLY query, see db/execute.ts) instead of releasing it
    gracefulEnd: true,
  };
}

/**
 * Open the SSH tunnel when configured. Returns the host/port the pool must connect to.
 */
async function resolveEndpoint(): Promise<{ host: string; port: number }> {
  if (!config.SSH) {
    return { host: config.SQL_SERVER, port: config.SQL_PORT };
  }

  tunnel = new SshTunnel({
    host: config.SSH.host,
    port: config.SSH.port,
    username: config.SSH.user,
    privateKey: loadPrivateKey(config.SSH.keyPath, config.SSH.keyPassphrase),
    passphrase: config.SSH.keyPassphrase,
    hostFingerprint: config.SSH.hostFingerprint,
    dstHost: config.SQL_SERVER,
    dstPort: config.SQL_PORT,
  });

  const localPort = await tunnel.start();
  return { host: '127.0.0.1', port: localPort };
}

async function createPool(): Promise<Pool> {
  try {
    logger.info('Connecting to MySQL', {
      server: config.SQL_SERVER,
      database: config.SQL_DATABASE,
      port: config.SQL_PORT,
      viaSshTunnel: config.SSH !== null,
    });

    const endpoint = await resolveEndpoint();
    const created = mysql.createPool(buildPoolOptions(endpoint.host, endpoint.port));

    // Validate the connection works
    const conn = await created.getConnection();
    try {
      await conn.query('SELECT 1');
    } finally {
      conn.release();
    }

    logger.info('Connected to MySQL successfully');

    // Handle pool errors on the underlying (event-emitting) pool
    created.pool.on('error', (err: Error) => {
      logger.error('Connection pool error', { error: err.message });
    });

    pool = created;
    return created;
  } catch (error) {
    // Do not leave a half-open tunnel behind; the next call starts from scratch
    if (tunnel) {
      await tunnel.close().catch(() => undefined);
      tunnel = null;
    }
    const message = getErrorMessage(error);
    logger.error('Failed to connect to MySQL', { error: message });
    throw new ConnectionError(`Failed to connect to MySQL: ${message}`);
  }
}

/**
 * Get the connection pool (creates if not exists)
 */
export async function getPool(): Promise<Pool> {
  if (pool) {
    return pool;
  }
  if (!poolPromise) {
    poolPromise = createPool().finally(() => {
      poolPromise = null;
    });
  }
  return poolPromise;
}

/**
 * Close the connection pool and the SSH tunnel
 */
export async function closePool(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
      pool = null;
      logger.info('Connection pool closed');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error closing connection pool', { error: message });
    }
  }

  if (tunnel) {
    await tunnel.close().catch(() => undefined);
    tunnel = null;
  }
}

/**
 * Check if the pool is connected
 */
export function isConnected(): boolean {
  return pool !== null;
}

/**
 * Get pool statistics
 */
export function getPoolStats(): { max: number; connected: boolean } {
  return {
    max: config.POOL_MAX,
    connected: pool !== null,
  };
}
