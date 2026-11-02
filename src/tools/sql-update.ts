import { executeWrite, buildUpdateQuery } from '../db/index.js';
import { sqlUpdateSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import { config } from '../config.js';
import { ReadOnlyViolationError } from '../utils/errors.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: sql_update
 * Update rows in a table (READONLY=false only)
 */
export async function sqlUpdate(args: unknown): Promise<ToolResponse> {
  try {
    // Check READONLY mode first
    if (config.READONLY) {
      throw new ReadOnlyViolationError('UPDATE');
    }

    const { table, schema, data, where, params } = sqlUpdateSchema.parse(args);

    if (Object.keys(data).length === 0) {
      return formatError(new Error('Data object cannot be empty'));
    }

    const { query, params: allParams } = buildUpdateQuery(schema, table, data, where, params);

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
 * Tool definition for sql_update
 */
export const sqlUpdateDefinition = {
  name: 'sql_update',
  description:
    'Update rows in a table. Only available when READONLY=false. WHERE clause is required for safety. Use @param syntax for parameters.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      table: {
        type: 'string',
        description: 'Table name to update',
      },
      schema: {
        type: 'string',
        description: 'Schema/database name (defaults to the connected database)',
      },
      data: {
        type: 'object',
        description: 'Fields to update as key-value pairs (column: newValue)',
        additionalProperties: true,
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
    required: ['table', 'data', 'where'],
  },
};
