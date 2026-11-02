import { executeQuery } from '../db/index.js';
import { duplicateIndexesSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import { optional, withWarnings } from './helpers.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: analyze_duplicate_indexes
 * Find redundant/duplicate indexes using sys.schema_redundant_indexes (MySQL 8+).
 */
export async function analyzeDuplicateIndexes(args: unknown): Promise<ToolResponse> {
  try {
    const { table } = duplicateIndexesSchema.parse(args);

    let query = `
      SELECT
        table_schema AS \`schema\`,
        table_name AS \`table\`,
        redundant_index_name AS \`redundantIndex\`,
        redundant_index_columns AS \`redundantColumns\`,
        dominant_index_name AS \`dominantIndex\`,
        dominant_index_columns AS \`dominantColumns\`,
        sql_drop_index AS \`dropDDL\`
      FROM sys.schema_redundant_indexes
      WHERE 1=1
    `;

    const params: Record<string, string> = {};

    if (table) {
      query += ` AND table_name = @table`;
      params.table = table;
    }

    query += ` ORDER BY table_schema, table_name, redundant_index_name`;

    const warnings: string[] = [];
    const result = await optional(warnings, 'sys.schema_redundant_indexes', () => executeQuery(query, params, 200));

    const duplicates = (result?.rows ?? []).map((row) => {
      const r = row as { redundantIndex: string; dominantIndex: string };
      return {
        ...r,
        recommendation: `Index "${r.redundantIndex}" is redundant to "${r.dominantIndex}". Consider dropping it (see dropDDL).`,
      };
    });

    return formatSuccess(
      withWarnings(
        {
          duplicateIndexes: duplicates,
          count: duplicates.length,
          note: 'Based on sys.schema_redundant_indexes (requires the sys schema). Redundant indexes waste space and slow down writes.',
        },
        warnings
      )
    );
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for analyze_duplicate_indexes
 */
export const analyzeDuplicateIndexesDefinition = {
  name: 'analyze_duplicate_indexes',
  description:
    'Find redundant or duplicate indexes (one index is a prefix of another) that could be removed.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      table: {
        type: 'string',
        description: 'Filter for a specific table',
      },
    },
  },
};
