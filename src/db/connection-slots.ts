import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ConnectionLimitError, getErrno, isConnectionLimitError } from '../utils/errors.js';

/**
 * A permit to have one connection open on the database server.
 * `release()` is idempotent.
 */
export interface Slot {
  release(): void;
}

interface Waiter {
  grant: (slot: Slot | null) => void;
  timer?: NodeJS.Timeout;
}

/**
 * FIFO counting semaphore that bounds the number of connections this process
 * has open on the server (POOL_MAX).
 *
 * The mysql2 pool alone is not enough: it forgets a connection as soon as
 * end()/destroy() is called, before the server has closed the session, and
 * then opens a new one at once. For a moment the server counts both, which is
 * what trips a low max_user_connections. A slot is therefore held from before
 * the connection is opened until the server is known (or assumed, see
 * execute.ts) to have dropped it.
 */
export class ConnectionSlots {
  private active = 0;
  private highWater = 0;
  private readonly waiters: Waiter[] = [];

  constructor(public readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error('ConnectionSlots: max must be a positive integer');
    }
  }

  /** Slots currently held */
  get inUse(): number {
    return this.active;
  }

  /** Callers waiting for a slot */
  get queued(): number {
    return this.waiters.length;
  }

  /** Highest number of slots held at the same time (diagnostics, tests) */
  get peak(): number {
    return this.highWater;
  }

  /**
   * Wait for a slot, first come first served.
   * @param timeoutMs give up after this long (resolves null); no limit when omitted
   */
  acquire(timeoutMs?: number): Promise<Slot | null> {
    if (this.active < this.max && this.waiters.length === 0) {
      this.active++;
      this.highWater = Math.max(this.highWater, this.active);
      return Promise.resolve(this.makeSlot());
    }
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const waiter: Waiter = { grant: resolve };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(null);
        }, timeoutMs);
        waiter.timer.unref?.();
      }
      this.waiters.push(waiter);
    });
  }

  private makeSlot(): Slot {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.handOver();
      },
    };
  }

  /** A slot was released: give it to the oldest waiter, or free it */
  private handOver(): void {
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant(this.makeSlot());
      return;
    }
    this.active--;
  }
}

let slots: ConnectionSlots | null = null;

/** The process-wide connection slots (POOL_MAX) */
export function getConnectionSlots(): ConnectionSlots {
  if (!slots) {
    slots = new ConnectionSlots(config.POOL_MAX);
  }
  return slots;
}

/** Replace the process-wide slots (tests) */
export function resetConnectionSlots(max: number = config.POOL_MAX): ConnectionSlots {
  slots = new ConnectionSlots(max);
  return slots;
}

/** Back-off before each new attempt after a "too many connections" error */
export const CONNECTION_RETRY_DELAYS_MS = [200, 400, 800];
/** Random extra delay added to each back-off */
export const CONNECTION_RETRY_JITTER_MS = 100;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Open a connection, retrying a few times with a short back-off when the
 * server refuses it because a connection limit is reached (1226
 * ER_USER_LIMIT_REACHED: max_user_connections; 1040 ER_CON_COUNT_ERROR:
 * max_connections). These errors happen during the handshake, before any
 * statement runs, so retrying is always safe.
 *
 * Gives up with a ConnectionLimitError when the attempts are exhausted or the
 * next back-off would end after `deadline` (epoch ms).
 */
export async function connectWithRetry<T>(
  connect: () => Promise<T>,
  deadline: number,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect();
    } catch (error) {
      if (!isConnectionLimitError(error)) {
        throw error;
      }
      const base = CONNECTION_RETRY_DELAYS_MS[attempt - 1];
      const delay = base === undefined ? undefined : base + Math.floor(Math.random() * CONNECTION_RETRY_JITTER_MS);
      if (delay === undefined || Date.now() + delay > deadline) {
        throw ConnectionLimitError.from(error, attempt, config.POOL_MAX);
      }
      logger.warn('Database refused a connection (connection limit reached); retrying', {
        errno: getErrno(error),
        attempt,
        delayMs: delay,
      });
      await sleep(delay);
    }
  }
}
