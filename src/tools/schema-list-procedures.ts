import { executeQuery } from '../db/index.js';
import { listProceduresSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

const SYSTEM_SCHEMAS = "'information_schema','performance_schema','mysql','sys'";

/**
 * Tool: schema_list_procedures
 * List stored procedures and functions in the database
 */
export async function schemaListProcedures(args: unknown): Promise<ToolResponse> {
  try {
    const { schema, pattern } = listProceduresSchema.parse(args);

    let query = `
      SELECT
        r.ROUTINE_SCHEMA AS \`schema\`,
        r.ROUTINE_NAME AS \`name\`,
        r.ROUTINE_TYPE AS \`type\`,
        r.DATA_TYPE AS \`returnType\`,
        (
          SELECT COUNT(*)
          FROM information_schema.PARAMETERS p
          WHERE p.SPECIFIC_SCHEMA = r.ROUTINE_SCHEMA
            AND p.SPECIFIC_NAME = r.ROUTINE_NAME
            AND p.PARAMETER_MODE IS NOT NULL
        ) AS \`parameterCount\`,
        r.CREATED AS \`created\`,
        r.LAST_ALTERED AS \`lastAltered\`,
        r.ROUTINE_DEFINITION AS \`definition\`
      FROM information_schema.ROUTINES r
      WHERE r.ROUTINE_SCHEMA NOT IN (${SYSTEM_SCHEMAS})
    `;

    const params: Record<string, string> = {};

    if (schema) {
      query += ` AND r.ROUTINE_SCHEMA = @schema`;
      params.schema = schema;
    }

    if (pattern) {
      query += ` AND r.ROUTINE_NAME LIKE @pattern`;
      params.pattern = pattern;
    }

    query += ` ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME`;

    const result = await executeQuery(query, params, 500);

    // Truncate definition to avoid huge responses
    const procedures = result.rows.map((row) => {
      const proc = row as { definition?: string };
      if (proc.definition && proc.definition.length > 2000) {
        proc.definition = proc.definition.substring(0, 2000) + '... [truncated]';
      }
      return proc;
    });

    return formatSuccess({
      procedures,
      count: result.rowCount,
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for schema_list_procedures
 */
export const schemaListProceduresDefinition = {
  name: 'schema_list_procedures',
  description:
    'List stored procedures and functions in the database with optional filtering by schema and name pattern.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      schema: {
        type: 'string',
        description: 'Filter by schema/database name (e.g., "mydb")',
      },
      pattern: {
        type: 'string',
        description: 'LIKE pattern for procedure name',
      },
    },
  },
};
