import { executeQuery, getServerInfo, PERFORMANCE_SCHEMA_OFF_WARNING } from '../db/index.js';
import { optional, withWarnings } from './helpers.js';
import { suggestIndexesSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: analyze_suggest_indexes
 * Suggest tables that may benefit from indexes, based on full table scans
 * reported by sys.schema_tables_with_full_table_scans (MySQL 8+).
 */
export async function analyzeSuggestIndexes(args: unknown): Promise<ToolResponse> {
  try {
    const { table, top } = suggestIndexesSchema.parse(args);
    const warnings: string[] = [];

    const server = await getServerInfo();
    if (!server.performanceSchema) {
      return formatSuccess(withWarnings({ suggestions: [], count: 0 }, [PERFORMANCE_SCHEMA_OFF_WARNING]));
    }

    let query = `
      SELECT
        object_schema AS \`schema\`,
        object_name AS \`table\`,
        rows_full_scanned AS \`rowsFullScanned\`,
        latency AS \`latency\`,
        CONCAT('Review WHERE/JOIN columns on \`', object_schema, '\`.\`', object_name,
               '\` and add a covering index') AS \`suggestion\`
      FROM sys.schema_tables_with_full_table_scans
      WHERE 1=1
    `;

    const params: Record<string, string | number> = { top };

    if (table) {
      query += ` AND object_name = @table`;
      params.table = table;
    }

    query += `
      ORDER BY rows_full_scanned DESC
      LIMIT @top
    `;

    const result = await optional(warnings, 'sys.schema_tables_with_full_table_scans', () =>
      executeQuery(query, params, top)
    );

    // Add priority recommendations
    const suggestions = (result?.rows ?? []).map((row) => {
      const suggestion = row as { rowsFullScanned: number };
      const measure = Number(suggestion.rowsFullScanned) || 0;
      return {
        ...suggestion,
        recommendation:
          measure > 1000000
            ? 'HIGH PRIORITY - Significant full-scan volume; indexing likely to help'
            : measure > 100000
              ? 'MEDIUM PRIORITY - Moderate full-scan volume'
              : 'LOW PRIORITY - Minor full-scan volume',
      };
    });

    return formatSuccess(
      withWarnings(
        {
          suggestions,
          count: suggestions.length,
          note: 'Based on sys.schema_tables_with_full_table_scans (requires performance_schema + sys schema). Use EXPLAIN on the offending queries to choose exact index columns. Always test indexes in a non-production environment first.',
        },
        warnings
      )
    );
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for analyze_suggest_indexes
 */
export const analyzeSuggestIndexesDefinition = {
  name: 'analyze_suggest_indexes',
  description:
    'Suggest tables that may need indexes based on full table scans tracked by performance_schema/sys.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      table: {
        type: 'string',
        description: 'Filter suggestions for a specific table',
      },
      top: {
        type: 'number',
        default: 20,
        minimum: 1,
        maximum: 50,
        description: 'Maximum number of suggestions (default: 20)',
      },
    },
  },
};
