import { executeQuery, getServerInfo } from '../db/index.js';
import { normalizeColumnDefaults } from './helpers.js';
import { describeTableSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: schema_describe_table
 * Get detailed information about a table's structure
 */
export async function schemaDescribeTable(args: unknown): Promise<ToolResponse> {
  try {
    const { table, schema } = describeTableSchema.parse(args);

    // Get columns with detailed info
    const columnsQuery = `
      SELECT
        c.COLUMN_NAME AS \`name\`,
        c.DATA_TYPE AS \`dataType\`,
        c.COLUMN_TYPE AS \`columnType\`,
        c.CHARACTER_MAXIMUM_LENGTH AS \`maxLength\`,
        c.NUMERIC_PRECISION AS \`precision\`,
        c.NUMERIC_SCALE AS \`scale\`,
        (c.IS_NULLABLE = 'YES') AS \`isNullable\`,
        c.COLUMN_DEFAULT AS \`defaultValue\`,
        c.COLUMN_KEY AS \`columnKey\`,
        c.EXTRA AS \`extra\`,
        c.COLUMN_COMMENT AS \`description\`
      FROM information_schema.COLUMNS c
      WHERE c.TABLE_NAME = @table
        AND c.TABLE_SCHEMA = @schema
      ORDER BY c.ORDINAL_POSITION
    `;

    // Get primary key columns
    const pkQuery = `
      SELECT
        s.COLUMN_NAME AS \`column\`
      FROM information_schema.STATISTICS s
      WHERE s.TABLE_NAME = @table
        AND s.TABLE_SCHEMA = @schema
        AND s.INDEX_NAME = 'PRIMARY'
      ORDER BY s.SEQ_IN_INDEX
    `;

    // Get foreign keys
    const fkQuery = `
      SELECT
        k.CONSTRAINT_NAME AS \`name\`,
        k.COLUMN_NAME AS \`column\`,
        k.REFERENCED_TABLE_SCHEMA AS \`referencedSchema\`,
        k.REFERENCED_TABLE_NAME AS \`referencedTable\`,
        k.REFERENCED_COLUMN_NAME AS \`referencedColumn\`
      FROM information_schema.KEY_COLUMN_USAGE k
      WHERE k.TABLE_NAME = @table
        AND k.TABLE_SCHEMA = @schema
        AND k.REFERENCED_TABLE_NAME IS NOT NULL
    `;

    // Get indexes
    const indexQuery = `
      SELECT
        s.INDEX_NAME AS \`name\`,
        s.INDEX_TYPE AS \`type\`,
        (MIN(s.NON_UNIQUE) = 0) AS \`isUnique\`,
        (s.INDEX_NAME = 'PRIMARY') AS \`isPrimaryKey\`,
        GROUP_CONCAT(s.COLUMN_NAME ORDER BY s.SEQ_IN_INDEX SEPARATOR ', ') AS \`columns\`
      FROM information_schema.STATISTICS s
      WHERE s.TABLE_NAME = @table
        AND s.TABLE_SCHEMA = @schema
      GROUP BY s.INDEX_NAME, s.INDEX_TYPE
    `;

    // Get table stats
    const statsQuery = `
      SELECT
        t.TABLE_ROWS AS \`rowCount\`,
        t.ENGINE AS \`engine\`,
        ROUND((COALESCE(t.DATA_LENGTH, 0) + COALESCE(t.INDEX_LENGTH, 0)) / 1024 / 1024, 2) AS \`sizeMB\`,
        t.CREATE_TIME AS \`createdAt\`,
        t.UPDATE_TIME AS \`updatedAt\`,
        t.TABLE_COMMENT AS \`comment\`
      FROM information_schema.TABLES t
      WHERE t.TABLE_NAME = @table
        AND t.TABLE_SCHEMA = @schema
    `;

    const params = { table, schema };

    // One after the other: each query needs its own connection, and a burst of
    // five could exceed a low max_user_connections; small metadata queries
    // gain little from running in parallel.
    const serverInfo = await getServerInfo();
    const columns = await executeQuery(columnsQuery, params, 500);
    const pk = await executeQuery(pkQuery, params, 50);
    const fk = await executeQuery(fkQuery, params, 100);
    const indexes = await executeQuery(indexQuery, params, 100);
    const stats = await executeQuery(statsQuery, params, 1);

    return formatSuccess({
      schema,
      table,
      columns: normalizeColumnDefaults(columns.rows, serverInfo),
      primaryKey: pk.rows.map((r) => (r as { column: string }).column),
      foreignKeys: fk.rows,
      indexes: indexes.rows,
      stats: stats.rows[0] || null,
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for schema_describe_table
 */
export const schemaDescribeTableDefinition = {
  name: 'schema_describe_table',
  description:
    'Get detailed information about a table including columns, primary key, foreign keys, indexes, and statistics.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      table: {
        type: 'string',
        description: 'Table name to describe',
      },
      schema: {
        type: 'string',
        description: 'Schema/database name (defaults to the connected database)',
      },
    },
    required: ['table'],
  },
};
