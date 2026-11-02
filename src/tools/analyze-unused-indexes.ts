import { executeQuery, getServerInfo, quoteIdentifier, PERFORMANCE_SCHEMA_OFF_WARNING } from '../db/index.js';
import { optional, withWarnings } from './helpers.js';
import { unusedIndexesSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: analyze_unused_indexes
 * Find indexes that have not been used since the last server restart,
 * based on sys.schema_unused_indexes (MySQL 8+).
 */
export async function analyzeUnusedIndexes(args: unknown): Promise<ToolResponse> {
  try {
    const { table } = unusedIndexesSchema.parse(args);
    const warnings: string[] = [];

    const server = await getServerInfo();
    if (!server.performanceSchema) {
      return formatSuccess(withWarnings({ unusedIndexes: [], count: 0 }, [PERFORMANCE_SCHEMA_OFF_WARNING]));
    }

    let query = `
      SELECT
        u.object_schema AS \`schema\`,
        u.object_name AS \`table\`,
        u.index_name AS \`indexName\`,
        GROUP_CONCAT(s.COLUMN_NAME ORDER BY s.SEQ_IN_INDEX SEPARATOR ', ') AS \`columns\`
      FROM sys.schema_unused_indexes u
      LEFT JOIN information_schema.STATISTICS s
        ON s.TABLE_SCHEMA = u.object_schema
        AND s.TABLE_NAME = u.object_name
        AND s.INDEX_NAME = u.index_name
      WHERE 1=1
    `;

    const params: Record<string, string | number> = {};

    if (table) {
      query += ` AND u.object_name = @table`;
      params.table = table;
    }

    query += `
      GROUP BY u.object_schema, u.object_name, u.index_name
      ORDER BY u.object_schema, u.object_name, u.index_name
    `;

    const result = await optional(warnings, 'sys.schema_unused_indexes', () => executeQuery(query, params, 200));

    // Build the drop DDL in JS to avoid the READONLY validator flagging the
    // literal "DROP" keyword inside the SQL text.
    const unusedIndexes = (result?.rows ?? []).map((row) => {
      const r = row as { schema: string; table: string; indexName: string };
      return {
        ...r,
        dropDDL: `DROP INDEX ${quoteIdentifier(r.indexName)} ON ${quoteIdentifier(r.schema)}.${quoteIdentifier(r.table)}`,
      };
    });

    return formatSuccess(
      withWarnings(
        {
          unusedIndexes,
          count: unusedIndexes.length,
          note: 'Based on sys.schema_unused_indexes (requires performance_schema + sys schema). "Unused" means no reads since the last server restart - verify over a representative time window before dropping. Primary keys are excluded.',
        },
        warnings
      )
    );
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for analyze_unused_indexes
 */
export const analyzeUnusedIndexesDefinition = {
  name: 'analyze_unused_indexes',
  description:
    'Find indexes that have not been used since the last server restart and could be dropped to save space and improve write performance.',
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
