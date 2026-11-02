import { executeQuery } from '../db/index.js';
import { fragmentationSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

const SYSTEM_SCHEMAS = "'information_schema','performance_schema','mysql','sys'";

/**
 * Tool: analyze_fragmentation
 * Estimate table fragmentation from InnoDB DATA_FREE (free space inside the tablespace).
 */
export async function analyzeFragmentation(args: unknown): Promise<ToolResponse> {
  try {
    const { table, minFragmentation, minPageCount } = fragmentationSchema.parse(args);

    let query = `
      SELECT
        TABLE_SCHEMA AS \`schema\`,
        TABLE_NAME AS \`table\`,
        ENGINE AS \`engine\`,
        TABLE_ROWS AS \`rowCount\`,
        ROUND(COALESCE(DATA_LENGTH, 0) / 1024 / 1024, 2) AS \`dataSizeMB\`,
        ROUND(COALESCE(INDEX_LENGTH, 0) / 1024 / 1024, 2) AS \`indexSizeMB\`,
        ROUND(COALESCE(DATA_FREE, 0) / 1024 / 1024, 2) AS \`freeSizeMB\`,
        CASE
          WHEN (COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) + COALESCE(DATA_FREE, 0)) = 0 THEN 0
          ELSE ROUND(
            100.0 * COALESCE(DATA_FREE, 0)
            / (COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) + COALESCE(DATA_FREE, 0)),
            2
          )
        END AS \`fragmentationPercent\`,
        CONCAT('OPTIMIZE TABLE \`', TABLE_SCHEMA, '\`.\`', TABLE_NAME, '\`') AS \`optimizeDDL\`
      FROM information_schema.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
        AND ENGINE IS NOT NULL
        AND TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS})
        AND (COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) / @@innodb_page_size >= @minPageCount
    `;

    const params: Record<string, string | number> = { minFragmentation, minPageCount };

    if (table) {
      query += ` AND TABLE_NAME = @table`;
      params.table = table;
    }

    query += `
      HAVING fragmentationPercent >= @minFragmentation
      ORDER BY fragmentationPercent DESC
    `;

    const result = await executeQuery(query, params, 200);

    // Categorize by fragmentation level
    const summary = { high: 0, medium: 0, low: 0 };
    const fragmentation = result.rows.map((row) => {
      const r = row as { fragmentationPercent: number };
      const pct = Number(r.fragmentationPercent) || 0;
      let recommendation = 'OK';
      if (pct >= 30) {
        summary.high++;
        recommendation = 'HIGH - Run OPTIMIZE TABLE to reclaim space';
      } else if (pct >= 10) {
        summary.medium++;
        recommendation = 'MEDIUM - Consider OPTIMIZE TABLE during a maintenance window';
      } else {
        summary.low++;
      }
      return { ...r, recommendation };
    });

    return formatSuccess({
      fragmentation,
      count: result.rowCount,
      summary,
      note: 'Fragmentation is estimated from InnoDB DATA_FREE. OPTIMIZE TABLE rebuilds the table and reclaims free space (it locks the table during the rebuild on older versions).',
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for analyze_fragmentation
 */
export const analyzeFragmentationDefinition = {
  name: 'analyze_fragmentation',
  description:
    'Estimate table fragmentation from InnoDB free space and recommend OPTIMIZE TABLE where needed.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      table: {
        type: 'string',
        description: 'Filter for a specific table',
      },
      minFragmentation: {
        type: 'number',
        default: 10,
        minimum: 0,
        maximum: 100,
        description: 'Minimum fragmentation percentage (default: 10)',
      },
      minPageCount: {
        type: 'number',
        default: 0,
        minimum: 0,
        description: 'Minimum table size in InnoDB pages (data + indexes / innodb_page_size; default: 0 = no minimum)',
      },
    },
  },
};
