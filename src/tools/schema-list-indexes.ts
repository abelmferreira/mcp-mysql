import { executeQuery, getServerInfo, PERFORMANCE_SCHEMA_OFF_WARNING } from '../db/index.js';
import { listIndexesSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import { optional, withWarnings } from './helpers.js';
import type { ToolResponse } from '../types.js';

const SYSTEM_SCHEMAS = "'information_schema','performance_schema','mysql','sys'";

/**
 * Tool: schema_list_indexes
 * List indexes (information_schema) with usage statistics from
 * performance_schema when it is enabled and readable.
 */
export async function schemaListIndexes(args: unknown): Promise<ToolResponse> {
  try {
    const { table, schema } = listIndexesSchema.parse(args);
    const warnings: string[] = [];

    let query = `
      SELECT
        s.TABLE_SCHEMA AS \`schema\`,
        s.TABLE_NAME AS \`table\`,
        s.INDEX_NAME AS \`indexName\`,
        s.INDEX_TYPE AS \`type\`,
        (MIN(s.NON_UNIQUE) = 0) AS \`isUnique\`,
        (s.INDEX_NAME = 'PRIMARY') AS \`isPrimaryKey\`,
        GROUP_CONCAT(s.COLUMN_NAME ORDER BY s.SEQ_IN_INDEX SEPARATOR ', ') AS \`columns\`,
        t.TABLE_ROWS AS \`rowCount\`
      FROM information_schema.STATISTICS s
      LEFT JOIN information_schema.TABLES t
        ON t.TABLE_SCHEMA = s.TABLE_SCHEMA AND t.TABLE_NAME = s.TABLE_NAME
      WHERE 1=1
    `;
    let usageQuery = `
      SELECT
        u.OBJECT_SCHEMA AS \`schema\`,
        u.OBJECT_NAME AS \`table\`,
        u.INDEX_NAME AS \`indexName\`,
        u.COUNT_READ AS \`reads\`,
        u.COUNT_WRITE AS \`writes\`,
        u.COUNT_FETCH AS \`fetches\`
      FROM performance_schema.table_io_waits_summary_by_index_usage u
      WHERE u.INDEX_NAME IS NOT NULL
    `;

    const params: Record<string, string> = {};

    if (table) {
      query += ` AND s.TABLE_NAME = @table`;
      usageQuery += ` AND u.OBJECT_NAME = @table`;
      params.table = table;
    }

    if (schema) {
      query += ` AND s.TABLE_SCHEMA = @schema`;
      usageQuery += ` AND u.OBJECT_SCHEMA = @schema`;
      params.schema = schema;
    } else {
      query += ` AND s.TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS})`;
      usageQuery += ` AND u.OBJECT_SCHEMA NOT IN (${SYSTEM_SCHEMAS})`;
    }

    query += `
      GROUP BY s.TABLE_SCHEMA, s.TABLE_NAME, s.INDEX_NAME, s.INDEX_TYPE, t.TABLE_ROWS
      ORDER BY s.TABLE_SCHEMA, s.TABLE_NAME, s.INDEX_NAME
    `;

    const result = await executeQuery(query, params, 1000);

    // Usage counters are optional: performance_schema may be OFF (MariaDB
    // default) or not readable by this account.
    const usage = new Map<string, { reads: unknown; writes: unknown; fetches: unknown }>();
    const server = await getServerInfo();
    if (!server.performanceSchema) {
      warnings.push(`Usage counters: ${PERFORMANCE_SCHEMA_OFF_WARNING}`);
    } else {
      const usageResult = await optional(warnings, 'Usage counters (performance_schema)', () =>
        executeQuery(usageQuery, params, 5000)
      );
      for (const row of usageResult?.rows ?? []) {
        const r = row as { schema: string; table: string; indexName: string; reads: unknown; writes: unknown; fetches: unknown };
        usage.set(`${r.schema}\u0000${r.table}\u0000${r.indexName}`, { reads: r.reads, writes: r.writes, fetches: r.fetches });
      }
    }

    const indexes = result.rows.map((row) => {
      const r = row as { schema: string; table: string; indexName: string };
      const u = usage.get(`${r.schema}\u0000${r.table}\u0000${r.indexName}`);
      return { ...row, reads: u?.reads ?? null, writes: u?.writes ?? null, fetches: u?.fetches ?? null };
    });

    return formatSuccess(
      withWarnings(
        {
          indexes,
          count: result.rowCount,
          note: 'Usage counters (reads/writes/fetches) come from performance_schema and reflect activity since the last server restart (null when unavailable).',
        },
        warnings
      )
    );
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for schema_list_indexes
 */
export const schemaListIndexesDefinition = {
  name: 'schema_list_indexes',
  description:
    'List indexes in the database with usage statistics (reads, writes, fetches) from performance_schema.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      table: {
        type: 'string',
        description: 'Filter by table name',
      },
      schema: {
        type: 'string',
        description: 'Filter by schema/database name',
      },
    },
  },
};
