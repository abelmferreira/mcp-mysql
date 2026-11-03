import { executeQuery } from '../db/index.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: monitor_database_size
 * Monitor database size and table usage
 */
export async function monitorDatabaseSize(): Promise<ToolResponse> {
  try {
    // Current database size summary
    const sizeQuery = `
      SELECT
        DATABASE() AS \`database\`,
        ROUND(SUM(COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) / 1024 / 1024, 2) AS \`totalSizeMB\`,
        ROUND(SUM(COALESCE(DATA_LENGTH, 0)) / 1024 / 1024, 2) AS \`dataSizeMB\`,
        ROUND(SUM(COALESCE(INDEX_LENGTH, 0)) / 1024 / 1024, 2) AS \`indexSizeMB\`,
        ROUND(SUM(COALESCE(DATA_FREE, 0)) / 1024 / 1024, 2) AS \`freeSizeMB\`
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
    `;

    // Size per database
    const databasesQuery = `
      SELECT
        TABLE_SCHEMA AS \`database\`,
        ROUND(SUM(COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) / 1024 / 1024, 2) AS \`sizeMB\`,
        COUNT(*) AS \`tableCount\`
      FROM information_schema.TABLES
      GROUP BY TABLE_SCHEMA
      ORDER BY SUM(COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) DESC
    `;

    // Largest tables in current database
    const tablesQuery = `
      SELECT
        TABLE_SCHEMA AS \`schema\`,
        TABLE_NAME AS \`table\`,
        TABLE_ROWS AS \`rowCount\`,
        ROUND((COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) / 1024 / 1024, 2) AS \`totalSizeMB\`,
        ROUND(COALESCE(DATA_LENGTH, 0) / 1024 / 1024, 2) AS \`dataSizeMB\`,
        ROUND(COALESCE(INDEX_LENGTH, 0) / 1024 / 1024, 2) AS \`indexSizeMB\`,
        ROUND(COALESCE(DATA_FREE, 0) / 1024 / 1024, 2) AS \`freeSizeMB\`
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY (COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) DESC
      LIMIT 20
    `;

    // One after the other: each query needs its own connection (see POOL_MAX)
    const size = await executeQuery(sizeQuery, {}, 1);
    const databases = await executeQuery(databasesQuery, {}, 100);
    const tables = await executeQuery(tablesQuery, {}, 20);

    return formatSuccess({
      summary: size.rows[0],
      databases: databases.rows,
      largestTables: tables.rows,
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for monitor_database_size
 */
export const monitorDatabaseSizeDefinition = {
  name: 'monitor_database_size',
  description:
    'Monitor database size including data/index usage, size per database, and largest tables.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};
