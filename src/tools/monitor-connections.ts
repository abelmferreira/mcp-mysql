import { executeQuery } from '../db/index.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: monitor_connections
 * Monitor active connections to the database via information_schema.PROCESSLIST
 */
export async function monitorConnections(): Promise<ToolResponse> {
  try {
    // Connection summary
    const summaryQuery = `
      SELECT
        COUNT(*) AS \`totalConnections\`,
        SUM(CASE WHEN COMMAND <> 'Sleep' THEN 1 ELSE 0 END) AS \`activeConnections\`,
        SUM(CASE WHEN COMMAND = 'Sleep' THEN 1 ELSE 0 END) AS \`sleepingConnections\`,
        COUNT(DISTINCT SUBSTRING_INDEX(HOST, ':', 1)) AS \`uniqueHosts\`,
        COUNT(DISTINCT USER) AS \`uniqueLogins\`,
        COUNT(DISTINCT DB) AS \`uniqueDatabases\`
      FROM information_schema.PROCESSLIST
    `;

    // Connections by login
    const byLoginQuery = `
      SELECT
        USER AS \`loginName\`,
        COUNT(*) AS \`connections\`,
        SUM(CASE WHEN COMMAND <> 'Sleep' THEN 1 ELSE 0 END) AS \`active\`,
        MAX(TIME) AS \`longestSeconds\`
      FROM information_schema.PROCESSLIST
      GROUP BY USER
      ORDER BY COUNT(*) DESC
    `;

    // Connections by host
    const byHostQuery = `
      SELECT
        COALESCE(SUBSTRING_INDEX(HOST, ':', 1), 'N/A') AS \`hostName\`,
        COUNT(*) AS \`connections\`,
        SUM(CASE WHEN COMMAND <> 'Sleep' THEN 1 ELSE 0 END) AS \`active\`,
        MAX(TIME) AS \`longestSeconds\`
      FROM information_schema.PROCESSLIST
      GROUP BY hostName
      ORDER BY COUNT(*) DESC
    `;

    // Connections by database
    const byDatabaseQuery = `
      SELECT
        COALESCE(DB, 'N/A') AS \`database\`,
        COUNT(*) AS \`connections\`,
        SUM(CASE WHEN COMMAND <> 'Sleep' THEN 1 ELSE 0 END) AS \`active\`,
        MAX(TIME) AS \`longestSeconds\`
      FROM information_schema.PROCESSLIST
      GROUP BY 1
      ORDER BY COUNT(*) DESC
    `;

    // Connection details
    const detailsQuery = `
      SELECT
        ID AS \`sessionId\`,
        USER AS \`loginName\`,
        HOST AS \`hostName\`,
        DB AS \`database\`,
        COMMAND AS \`command\`,
        STATE AS \`status\`,
        TIME AS \`timeSeconds\`
      FROM information_schema.PROCESSLIST
      ORDER BY TIME DESC
      LIMIT 50
    `;

    const [summary, byLogin, byHost, byDatabase, details] = await Promise.all([
      executeQuery(summaryQuery, {}, 1),
      executeQuery(byLoginQuery, {}, 50),
      executeQuery(byHostQuery, {}, 50),
      executeQuery(byDatabaseQuery, {}, 50),
      executeQuery(detailsQuery, {}, 50),
    ]);

    return formatSuccess({
      summary: summary.rows[0],
      byLogin: byLogin.rows,
      byHost: byHost.rows,
      byDatabase: byDatabase.rows,
      details: details.rows,
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for monitor_connections
 */
export const monitorConnectionsDefinition = {
  name: 'monitor_connections',
  description:
    'Monitor active connections to the database including summaries by login, host, and database.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};
