import { executeQuery, getServerInfo } from '../db/index.js';
import { normalizeColumnDefaults } from './helpers.js';
import { listColumnsSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

const SYSTEM_SCHEMAS = "'information_schema','performance_schema','mysql','sys'";

/**
 * Tool: schema_list_columns
 * Search for columns across all tables
 */
export async function schemaListColumns(args: unknown): Promise<ToolResponse> {
  try {
    const { pattern, dataType, table, schema } = listColumnsSchema.parse(args);

    let query = `
      SELECT
        c.TABLE_SCHEMA AS \`schema\`,
        c.TABLE_NAME AS \`table\`,
        c.COLUMN_NAME AS \`column\`,
        c.DATA_TYPE AS \`dataType\`,
        c.COLUMN_TYPE AS \`columnType\`,
        c.CHARACTER_MAXIMUM_LENGTH AS \`maxLength\`,
        c.NUMERIC_PRECISION AS \`precision\`,
        c.NUMERIC_SCALE AS \`scale\`,
        (c.IS_NULLABLE = 'YES') AS \`isNullable\`,
        c.COLUMN_KEY AS \`columnKey\`,
        c.COLUMN_DEFAULT AS \`defaultValue\`,
        c.EXTRA AS \`extra\`,
        c.COLUMN_COMMENT AS \`description\`
      FROM information_schema.COLUMNS c
      WHERE 1=1
    `;

    const params: Record<string, string> = {};

    if (pattern) {
      query += ` AND c.COLUMN_NAME LIKE @pattern`;
      params.pattern = pattern;
    }

    if (dataType) {
      query += ` AND c.DATA_TYPE = @dataType`;
      params.dataType = dataType;
    }

    if (table) {
      query += ` AND c.TABLE_NAME = @table`;
      params.table = table;
    }

    if (schema) {
      query += ` AND c.TABLE_SCHEMA = @schema`;
      params.schema = schema;
    } else {
      query += ` AND c.TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS})`;
    }

    query += ` ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`;

    const serverInfo = await getServerInfo();
    const result = await executeQuery(query, params, 1000);

    return formatSuccess({
      columns: normalizeColumnDefaults(result.rows, serverInfo),
      count: result.rowCount,
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for schema_list_columns
 */
export const schemaListColumnsDefinition = {
  name: 'schema_list_columns',
  description:
    'Search for columns across all tables with optional filtering by name pattern, data type, table, and schema.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      pattern: {
        type: 'string',
        description: 'LIKE pattern for column name (e.g., "%id%")',
      },
      dataType: {
        type: 'string',
        description: 'Filter by data type (e.g., "int", "varchar")',
      },
      table: {
        type: 'string',
        description: 'Filter by table name',
      },
      schema: {
        type: 'string',
        description: 'Filter by schema/database name',
      },
    },
  },
};
