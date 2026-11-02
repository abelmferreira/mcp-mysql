import { executeWrite, buildDeleteQuery } from '../db/index.js';
import { sqlDeleteSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import { config } from '../config.js';
import { ReadOnlyViolationError } from '../utils/errors.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: sql_delete
 * Delete rows from a table (READONLY=false only)
 */
export async function sqlDelete(args: unknown): Promise<ToolResponse> {
  try {
    // Check READONLY mode first
    if (config.READONLY) {
      throw new ReadOnlyViolationError('DELETE');
    }

    const { table, schema, where, params } = sqlDeleteSchema.parse(args);

    const { query, params: allParams } = buildDeleteQuery(schema, table, where, params);

    const result = await executeWrite(query, allParams);

    return formatSuccess({
      success: true,
      table: `${schema}.${table}`,
      affectedRows: result.affectedRows,
      duration: `${result.duration}ms`,
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for sql_delete
 */
export const sqlDeleteDefinition = {
  name: 'sql_delete',
  description:
    'Delete rows from a table. Only available when READONLY=false. WHERE clause is required for safety. Use @param syntax for parameters.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      table: {
        type: 'string',
        description: 'Table name to delete from',
      },
      schema: {
        type: 'string',
        description: 'Schema/database name (defaults to the connected database)',
      },
      where: {
        type: 'string',
        description: 'WHERE clause (required for safety). Example: "Id = @id"',
      },
      params: {
        type: 'object',
        description: 'Named parameters for WHERE clause (without @). Example: { "id": 123 }',
        additionalProperties: true,
        default: {},
      },
    },
    required: ['table', 'where'],
  },
};
