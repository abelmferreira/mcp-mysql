import { executeQuery, getServerInfo, PERFORMANCE_SCHEMA_OFF_WARNING } from '../db/index.js';
import { waitStatsSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import { optional, withWarnings } from './helpers.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: monitor_wait_stats
 * Monitor wait statistics from performance_schema (events_waits_summary_global_by_event_name).
 * Timer values are in picoseconds; converted to milliseconds (1 ms = 1e9 ps).
 */
export async function monitorWaitStats(args: unknown): Promise<ToolResponse> {
  try {
    const { top, excludeIdle } = waitStatsSchema.parse(args);
    const warnings: string[] = [];

    const server = await getServerInfo();
    if (!server.performanceSchema) {
      return formatSuccess(
        withWarnings({ waitStats: [], count: 0, excludedIdleWaits: excludeIdle }, [PERFORMANCE_SCHEMA_OFF_WARNING])
      );
    }

    let query = `
      SELECT
        EVENT_NAME AS \`waitType\`,
        COUNT_STAR AS \`waitingTasksCount\`,
        ROUND(SUM_TIMER_WAIT / 1000000000, 2) AS \`totalWaitTimeMs\`,
        ROUND(MAX_TIMER_WAIT / 1000000000, 2) AS \`maxWaitTimeMs\`,
        ROUND(AVG_TIMER_WAIT / 1000000000, 2) AS \`avgWaitTimeMs\`,
        CASE WHEN SUM(SUM_TIMER_WAIT) OVER () = 0 THEN 0
          ELSE ROUND(100.0 * SUM_TIMER_WAIT / SUM(SUM_TIMER_WAIT) OVER (), 2)
        END AS \`percentTotal\`
      FROM performance_schema.events_waits_summary_global_by_event_name
      WHERE COUNT_STAR > 0
    `;

    if (excludeIdle) {
      query += ` AND EVENT_NAME <> 'idle'`;
    }

    query += `
      ORDER BY SUM_TIMER_WAIT DESC
      LIMIT @top
    `;

    const result = await optional(warnings, 'Wait statistics (performance_schema)', () =>
      executeQuery(query, { top }, top)
    );
    const rows = result?.rows ?? [];

    if (result && rows.length === 0) {
      warnings.push('No wait events recorded: the wait instruments/consumers may be disabled in performance_schema.setup_instruments.');
    }

    return formatSuccess(
      withWarnings(
        {
          waitStats: rows,
          count: rows.length,
          excludedIdleWaits: excludeIdle,
          note: 'Values are cumulative since the last server restart (or last truncate).',
        },
        warnings
      )
    );
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for monitor_wait_stats
 */
export const monitorWaitStatsDefinition = {
  name: 'monitor_wait_stats',
  description:
    'Monitor wait statistics to identify performance bottlenecks. Shows wait types, counts, and times from performance_schema (returns a warning when it is disabled).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      top: {
        type: 'number',
        default: 10,
        minimum: 1,
        maximum: 100,
        description: 'Number of wait types to return (default: 10)',
      },
      excludeIdle: {
        type: 'boolean',
        default: true,
        description: 'Exclude idle/benign waits (default: true)',
      },
    },
  },
};
