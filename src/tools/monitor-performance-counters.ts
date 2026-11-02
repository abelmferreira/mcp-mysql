import { executeQuery } from '../db/index.js';
import { perfCountersSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

/** Counters always returned */
const GENERAL = ['Uptime', 'Threads_connected', 'Threads_running', 'Connections', 'Aborted_connects', 'Max_used_connections'];

/** Counters per category (names missing on a given server/version are simply absent) */
export const COUNTER_CATEGORIES: Record<'buffer' | 'sql' | 'locks' | 'memory', string[]> = {
  buffer: [
    'Innodb_buffer_pool_read_requests',
    'Innodb_buffer_pool_reads',
    'Innodb_buffer_pool_pages_total',
    'Innodb_buffer_pool_pages_free',
    'Innodb_buffer_pool_pages_dirty',
    'Innodb_buffer_pool_wait_free',
  ],
  sql: [
    'Queries',
    'Questions',
    'Slow_queries',
    'Com_select',
    'Com_insert',
    'Com_update',
    'Com_delete',
    'Select_scan',
    'Select_full_join',
    'Sort_merge_passes',
    'Created_tmp_tables',
    'Created_tmp_disk_tables',
    'Innodb_rows_read',
    'Innodb_rows_inserted',
    'Innodb_rows_updated',
    'Innodb_rows_deleted',
  ],
  locks: [
    'Table_locks_waited',
    'Table_locks_immediate',
    'Innodb_row_lock_waits',
    'Innodb_row_lock_time',
    'Innodb_row_lock_time_avg',
    'Innodb_row_lock_current_waits',
  ],
  memory: [
    'Memory_used',
    'Innodb_buffer_pool_bytes_data',
    'Innodb_buffer_pool_bytes_dirty',
    'Open_tables',
    'Opened_tables',
    'Open_files',
    'Threads_cached',
  ],
};

/**
 * Status variable names for a category
 */
export function countersFor(category: 'buffer' | 'sql' | 'locks' | 'memory' | 'all'): string[] {
  const lists = category === 'all' ? Object.values(COUNTER_CATEGORIES) : [COUNTER_CATEGORIES[category]];
  return [...new Set([...GENERAL, ...lists.flat()])];
}

/**
 * Tool: monitor_performance_counters
 * Monitor performance metrics with SHOW GLOBAL STATUS, which works on MySQL and
 * MariaDB whether performance_schema is enabled or not, without extra privileges.
 */
export async function monitorPerformanceCounters(args: unknown): Promise<ToolResponse> {
  try {
    const { category } = perfCountersSchema.parse(args);
    const names = countersFor(category);

    // Names come from the constant lists above, never from the caller
    const query = `SHOW GLOBAL STATUS WHERE Variable_name IN (${names.map((n) => `'${n}'`).join(', ')})`;
    const result = await executeQuery(query, {}, 200);

    const metrics: Record<string, number | string> = {};
    for (const row of result.rows) {
      const r = row as Record<string, unknown>;
      const name = String(r['Variable_name'] ?? r['VARIABLE_NAME'] ?? '');
      const raw = r['Value'] ?? r['VARIABLE_VALUE'];
      if (!name) continue;
      const num = Number(raw);
      metrics[name] = raw !== null && raw !== '' && Number.isFinite(num) ? num : String(raw);
    }

    const readRequests = Number(metrics['Innodb_buffer_pool_read_requests'] ?? 0);
    const diskReads = Number(metrics['Innodb_buffer_pool_reads'] ?? 0);
    const bufferPoolHitRatio =
      readRequests > 0 ? Math.round((1 - diskReads / readRequests) * 10000) / 100 : null;

    return formatSuccess({
      category,
      metrics,
      ...(category === 'buffer' || category === 'all' ? { bufferPoolHitRatio } : {}),
      totalCounters: Object.keys(metrics).length,
      note: 'Metrics come from SHOW GLOBAL STATUS (cumulative since server start). Buffer pool hit ratio is shown as a percentage.',
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for monitor_performance_counters
 */
export const monitorPerformanceCountersDefinition = {
  name: 'monitor_performance_counters',
  description:
    'Monitor MySQL/MariaDB performance metrics (connections, throughput, locks, memory, InnoDB buffer pool hit ratio) from global status.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      category: {
        type: 'string',
        enum: ['buffer', 'sql', 'locks', 'memory', 'all'],
        default: 'all',
        description: 'Metric category: buffer, sql, locks, memory, or all (general connection counters are always included)',
      },
    },
  },
};
