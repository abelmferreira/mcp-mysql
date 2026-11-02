import { executeQuery } from '../db/index.js';
import { sqlExecuteSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: sql_execute
 * Execute SQL SELECT queries with parameters
 */
export async function sqlExecute(args: unknown): Promise<ToolResponse> {
  try {
    const { query, params, maxRows } = sqlExecuteSchema.parse(args);

    const result = await executeQuery(query, params, maxRows);

    return formatSuccess({
      rows: result.rows,
      rowCount: result.rowCount,
      fields: result.fields,
      duration: `${result.duration}ms`,
      truncated: result.truncated,
      ...(result.truncated
        ? {
            note:
              result.truncatedBy === 'maxBytes'
                ? 'Result cut at the response size limit (MAX_RESULT_BYTES). Select fewer/smaller columns or add LIMIT.'
                : `More rows are available: only the first ${result.rowCount} were returned (maxRows, capped by MAX_ROWS). Add LIMIT/filters or paginate.`,
          }
        : {}),
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for sql_execute
 */
export const sqlExecuteDefinition = {
  name: 'sql_execute',
  description:
    'Execute SQL queries with parameterized inputs. In READONLY mode only one read statement is allowed (SELECT, WITH, EXPLAIN/DESCRIBE, TABLE, VALUES or a read-only SHOW). Use @paramName placeholders with the params argument; user variables and "?" are not supported.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description:
          'SQL SELECT query with @param placeholders. Only SELECT queries allowed in READONLY mode.',
      },
      params: {
        type: 'object',
        description:
          'Named parameters to bind (without @). Example: { "userId": 123, "status": "active" }',
        additionalProperties: true,
        default: {},
      },
      maxRows: {
        type: 'number',
        description: 'Maximum rows to return (default: 100; capped by the MAX_ROWS setting, at most 5000)',
        default: 100,
        minimum: 1,
        maximum: 5000,
      },
    },
    required: ['query'],
  },
};
