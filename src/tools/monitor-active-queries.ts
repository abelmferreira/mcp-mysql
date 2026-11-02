import { executeQuery } from '../db/index.js';
import { activeQueriesSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: monitor_active_queries
 * Monitor currently running queries via information_schema.PROCESSLIST
 */
export async function monitorActiveQueries(args: unknown): Promise<ToolResponse> {
  try {
    const { minDurationMs, includeSystemQueries } = activeQueriesSchema.parse(args);

    const query = `
      SELECT
        p.ID AS \`sessionId\`,
        p.STATE AS \`status\`,
        p.COMMAND AS \`command\`,
        p.TIME * 1000 AS \`elapsedTimeMs\`,
        p.USER AS \`loginName\`,
        p.HOST AS \`clientAddress\`,
        p.DB AS \`database\`,
        p.INFO AS \`fullQuery\`
      FROM information_schema.PROCESSLIST p
      WHERE p.ID <> CONNECTION_ID()
        AND p.COMMAND <> 'Sleep'
        AND p.INFO IS NOT NULL
        AND (p.TIME * 1000) >= @minDurationMs
        ${includeSystemQueries ? '' : "AND p.USER NOT IN ('event_scheduler', 'system user')"}
      ORDER BY p.TIME DESC
    `;

    const result = await executeQuery(query, { minDurationMs }, 100);

    // Truncate long queries
    const queries = result.rows.map((row) => {
      const queryRow = row as { fullQuery?: string };
      if (queryRow.fullQuery && queryRow.fullQuery.length > 2000) {
        queryRow.fullQuery = queryRow.fullQuery.substring(0, 2000) + '... [truncated]';
      }
      return queryRow;
    });

    return formatSuccess({
      activeQueries: queries,
      count: result.rowCount,
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for monitor_active_queries
 */
export const monitorActiveQueriesDefinition = {
  name: 'monitor_active_queries',
  description:
    'Monitor currently running queries with elapsed time, user, host, and database information.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      minDurationMs: {
        type: 'number',
        default: 0,
        description: 'Filter queries with minimum duration in milliseconds',
      },
      includeSystemQueries: {
        type: 'boolean',
        default: false,
        description: 'Include system queries (default: false)',
      },
    },
  },
};
