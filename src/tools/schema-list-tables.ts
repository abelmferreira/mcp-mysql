import { executeQuery } from '../db/index.js';
import { listTablesSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

const SYSTEM_SCHEMAS = "'information_schema','performance_schema','mysql','sys'";

/**
 * Tool: schema_list_tables
 * List tables and views in the database
 */
export async function schemaListTables(args: unknown): Promise<ToolResponse> {
  try {
    const { schema, type, pattern } = listTablesSchema.parse(args);

    const params: Record<string, string> = {};

    let query = `
      SELECT
        t.TABLE_SCHEMA AS \`schema\`,
        t.TABLE_NAME AS \`name\`,
        CASE t.TABLE_TYPE
          WHEN 'BASE TABLE' THEN 'TABLE'
          WHEN 'VIEW' THEN 'VIEW'
          ELSE t.TABLE_TYPE
        END AS \`type\`,
        t.TABLE_ROWS AS \`rowCount\`,
        ROUND((COALESCE(t.DATA_LENGTH, 0) + COALESCE(t.INDEX_LENGTH, 0)) / 1024 / 1024, 2) AS \`sizeMB\`,
        t.ENGINE AS \`engine\`
      FROM information_schema.TABLES t
      WHERE t.TABLE_TYPE IN ('BASE TABLE', 'VIEW')
    `;

    if (schema) {
      query += ` AND t.TABLE_SCHEMA = @schema`;
      params.schema = schema;
    } else {
      query += ` AND t.TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS})`;
    }

    if (pattern) {
      query += ` AND t.TABLE_NAME LIKE @pattern`;
      params.pattern = pattern;
    }

    if (type === 'TABLE') {
      query += ` AND t.TABLE_TYPE = 'BASE TABLE'`;
    } else if (type === 'VIEW') {
      query += ` AND t.TABLE_TYPE = 'VIEW'`;
    }

    query += ` ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME`;

    const result = await executeQuery(query, params, 1000);

    return formatSuccess({
      tables: result.rows,
      count: result.rowCount,
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for schema_list_tables
 */
export const schemaListTablesDefinition = {
  name: 'schema_list_tables',
  description:
    'List all tables and views in the database with optional filtering by schema (database), type, and name pattern.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      schema: {
        type: 'string',
        description: 'Filter by schema/database name (e.g., "mydb")',
      },
      type: {
        type: 'string',
        enum: ['TABLE', 'VIEW', 'ALL'],
        default: 'ALL',
        description: 'Filter by object type: TABLE, VIEW, or ALL',
      },
      pattern: {
        type: 'string',
        description: 'LIKE pattern for table name (e.g., "%user%")',
      },
    },
  },
};
