import { executeQuery } from '../db/index.js';
import { statisticsSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import { optional, withWarnings } from './helpers.js';
import type { ToolResponse } from '../types.js';

const SYSTEM_SCHEMAS = "'information_schema','performance_schema','mysql','sys'";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Tool: analyze_statistics
 * Report table statistics freshness. MySQL recalculates index statistics via
 * ANALYZE TABLE; this surfaces last-update time and row counts so stale tables
 * can be re-analyzed. The statistics timestamps come from
 * mysql.innodb_table_stats, which needs a privilege the account may not have:
 * without it the table list is still returned, with a warning.
 */
export async function analyzeStatistics(args: unknown): Promise<ToolResponse> {
  try {
    const { table } = statisticsSchema.parse(args);
    const warnings: string[] = [];

    let tablesQuery = `
      SELECT
        t.TABLE_SCHEMA AS \`schema\`,
        t.TABLE_NAME AS \`table\`,
        t.ENGINE AS \`engine\`,
        t.TABLE_ROWS AS \`totalRows\`,
        t.UPDATE_TIME AS \`lastDataUpdate\`,
        CONCAT('ANALYZE TABLE \`', t.TABLE_SCHEMA, '\`.\`', t.TABLE_NAME, '\`') AS \`updateDDL\`
      FROM information_schema.TABLES t
      WHERE t.TABLE_TYPE = 'BASE TABLE'
        AND t.TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS})
    `;
    let statsQuery = `
      SELECT
        st.database_name AS \`schema\`,
        st.table_name AS \`table\`,
        st.last_update AS \`lastStatsUpdate\`
      FROM mysql.innodb_table_stats st
      WHERE st.database_name NOT IN (${SYSTEM_SCHEMAS})
    `;

    const params: Record<string, string> = {};
    if (table) {
      tablesQuery += ` AND t.TABLE_NAME = @table`;
      statsQuery += ` AND st.table_name = @table`;
      params.table = table;
    }
    tablesQuery += ` ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME`;

    const result = await executeQuery(tablesQuery, params, 500);
    const stats = await optional(warnings, 'Statistics timestamps (mysql.innodb_table_stats)', () =>
      executeQuery(statsQuery, params, 5000)
    );

    const lastUpdate = new Map<string, unknown>();
    for (const row of stats?.rows ?? []) {
      const r = row as { schema: string; table: string; lastStatsUpdate: unknown };
      lastUpdate.set(`${r.schema}\u0000${r.table}`, r.lastStatsUpdate);
    }

    const summary = { old: 0, ok: 0, unknown: 0 };
    const now = Date.now();
    const statistics = result.rows.map((row) => {
      const r = row as { schema: string; table: string };
      const raw = lastUpdate.get(`${r.schema}\u0000${r.table}`);
      const date = raw instanceof Date ? raw : raw != null ? new Date(String(raw)) : null;
      const valid = date !== null && !Number.isNaN(date.getTime());
      const statsAgeDays = valid ? Math.floor((now - date!.getTime()) / DAY_MS) : null;
      let status: string;
      if (statsAgeDays === null) {
        status = stats ? 'UNKNOWN - No InnoDB stats row' : 'UNKNOWN - Statistics not readable';
        summary.unknown++;
      } else if (statsAgeDays > 30) {
        status = 'OLD - Consider ANALYZE TABLE';
        summary.old++;
      } else {
        status = 'OK';
        summary.ok++;
      }
      return { ...row, lastStatsUpdate: valid ? date : null, statsAgeDays, status };
    });

    // Oldest statistics first (unknown first, as before)
    statistics.sort((a, b) => (a.statsAgeDays === null ? -1 : b.statsAgeDays === null ? 1 : b.statsAgeDays - a.statsAgeDays));

    return formatSuccess(
      withWarnings(
        {
          statistics,
          count: result.rowCount,
          summary,
          note: 'MySQL/InnoDB updates statistics automatically, but bulk changes can leave them stale. Run ANALYZE TABLE on tables flagged OLD to refresh the optimizer statistics. Reading mysql.innodb_table_stats requires SELECT on that table.',
        },
        warnings
      )
    );
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for analyze_statistics
 */
export const analyzeStatisticsDefinition = {
  name: 'analyze_statistics',
  description:
    'Report table statistics freshness (InnoDB) and identify tables that should be re-analyzed with ANALYZE TABLE.',
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
