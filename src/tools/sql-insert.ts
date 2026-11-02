import { executeWrite, buildInsertQuery } from '../db/index.js';
import { sqlInsertSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import { config } from '../config.js';
import { ReadOnlyViolationError } from '../utils/errors.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: sql_insert
 * Insert a row into a table (READONLY=false only)
 */
export async function sqlInsert(args: unknown): Promise<ToolResponse> {
  try {
    // Check READONLY mode first
    if (config.READONLY) {
      throw new ReadOnlyViolationError('INSERT');
    }

    const { table, schema, data } = sqlInsertSchema.parse(args);

    if (Object.keys(data).length === 0) {
      return formatError(new Error('Data object cannot be empty'));
    }

    const { query, params } = buildInsertQuery(schema, table, data);

    const result = await executeWrite(query, params);

    return formatSuccess({
      success: true,
      table: `${schema}.${table}`,
      affectedRows: result.affectedRows,
      insertId: result.insertId,
      duration: `${result.duration}ms`,
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for sql_insert
 */
export const sqlInsertDefinition = {
  name: 'sql_insert',
  description:
    'Insert a row into a table. Only available when READONLY=false. Data is automatically parameterized for safety.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      table: {
        type: 'string',
        description: 'Table name to insert into',
      },
      schema: {
        type: 'string',
        description: 'Schema/database name (defaults to the connected database)',
      },
      data: {
        type: 'object',
        description: 'Data to insert as key-value pairs (column: value)',
        additionalProperties: true,
      },
    },
    required: ['table', 'data'],
  },
};
