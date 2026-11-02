import { executeQuery, compileQuery, getServerInfo, PERFORMANCE_SCHEMA_OFF_WARNING } from '../db/index.js';
import { analyzeQuerySchema } from '../validators/schemas.js';
import { validateQuery, getQueryType } from '../validators/query-validator.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import { QueryValidationError } from '../utils/errors.js';
import { optional } from './helpers.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: analyze_query
 * Analyze a query's execution plan (EXPLAIN FORMAT=JSON) and digest statistics.
 */
export async function analyzeQuery(args: unknown): Promise<ToolResponse> {
  try {
    const { query, params, includeExecutionPlan } = analyzeQuerySchema.parse(args);

    // The query is checked ON ITS OWN before "EXPLAIN FORMAT=JSON" is prefixed:
    // otherwise "FOR CONNECTION 42" would become a valid EXPLAIN statement.
    // This applies whatever the READONLY setting.
    const userSql = compileQuery(query, params);
    const check = validateQuery(userSql);
    if (!check.valid) {
      throw new QueryValidationError(check.reason || 'Query validation failed', check.queryType);
    }
    const type = getQueryType(userSql);
    if (type !== 'SELECT' && type !== 'CTE') {
      throw new QueryValidationError(`analyze_query only accepts SELECT or WITH queries. Found: ${type}`, type);
    }

    const results: {
      estimatedPlan?: unknown;
      statistics?: unknown;
      warnings?: string[];
    } = {};
    const warnings: string[] = [];

    if (includeExecutionPlan) {
      try {
        const planResult = await executeQuery(`EXPLAIN FORMAT=JSON ${query}`, params, 1);
        if (planResult.rows.length > 0) {
          const row = planResult.rows[0] as Record<string, unknown>;
          // The plan comes in a column named "EXPLAIN" as a JSON string
          const planRaw = row['EXPLAIN'] ?? Object.values(row)[0];
          results.estimatedPlan = parsePlanJson(planRaw);
        }
      } catch (planError) {
        warnings.push(
          `Could not get execution plan: ${planError instanceof Error ? planError.message : 'Unknown error'}`
        );
      }
    }

    // Digest statistics: performance_schema keeps one row per normalized
    // statement; MySQL 8.0.4+ computes the digest of a text with STATEMENT_DIGEST().
    const server = await getServerInfo();
    if (!server.performanceSchema) {
      warnings.push(`Digest statistics: ${PERFORMANCE_SCHEMA_OFF_WARNING}`);
    } else if (server.isMariaDB) {
      warnings.push('Digest statistics are not available on MariaDB (there is no STATEMENT_DIGEST() function).');
    } else {
      const statsQuery = `
        SELECT
          SCHEMA_NAME AS \`schema\`,
          COUNT_STAR AS \`executionCount\`,
          ROUND(SUM_TIMER_WAIT / 1000000000, 2) AS \`totalElapsedTimeMs\`,
          ROUND(AVG_TIMER_WAIT / 1000000000, 2) AS \`avgElapsedTimeMs\`,
          SUM_ROWS_SENT AS \`totalRowsSent\`,
          SUM_ROWS_EXAMINED AS \`totalRowsExamined\`,
          FIRST_SEEN AS \`firstSeen\`,
          LAST_SEEN AS \`lastSeen\`
        FROM performance_schema.events_statements_summary_by_digest
        WHERE DIGEST = STATEMENT_DIGEST(@statement)
        ORDER BY SUM_TIMER_WAIT DESC
        LIMIT 1
      `;
      const stats = await optional(warnings, 'Digest statistics', () =>
        executeQuery(statsQuery, { statement: userSql }, 1)
      );
      if (stats && stats.rows.length > 0) {
        results.statistics = stats.rows[0];
      } else if (stats) {
        warnings.push('No digest statistics found for this query (it may not have run since the last restart).');
      }
    }

    if (warnings.length > 0) {
      results.warnings = warnings;
    }

    return formatSuccess(results);
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Parse MySQL EXPLAIN FORMAT=JSON output to extract key information.
 */
function parsePlanJson(plan: unknown): Record<string, unknown> {
  let parsed: Record<string, unknown> | undefined;

  if (typeof plan === 'string') {
    try {
      parsed = JSON.parse(plan) as Record<string, unknown>;
    } catch {
      return { raw: plan };
    }
  } else if (plan && typeof plan === 'object') {
    parsed = plan as Record<string, unknown>;
  }

  const result: Record<string, unknown> = { raw: parsed ?? plan };

  const queryBlock = parsed?.['query_block'] as Record<string, unknown> | undefined;
  if (!queryBlock) {
    return result;
  }

  // MySQL: query_block.cost_info.query_cost; MariaDB 11+: query_block.cost
  const costInfo = queryBlock['cost_info'] as Record<string, unknown> | undefined;
  if (costInfo && costInfo['query_cost'] != null) {
    result.estimatedCost = Number(costInfo['query_cost']);
  } else if (typeof queryBlock['cost'] === 'number') {
    result.estimatedCost = queryBlock['cost'];
  }

  // First table of the plan: query_block.table, or the first nested_loop entry
  let table = queryBlock['table'] as Record<string, unknown> | undefined;
  const nested = queryBlock['nested_loop'];
  if (!table && Array.isArray(nested) && nested.length > 0) {
    table = (nested[0] as Record<string, unknown>)['table'] as Record<string, unknown> | undefined;
  }
  if (table) {
    if (typeof table['access_type'] === 'string') {
      result.accessType = table['access_type'];
      if (table['access_type'] === 'ALL') {
        result.potentialIssue = 'Full table scan (access_type = ALL) - consider adding an index';
      }
    }
    // MySQL: rows_examined_per_scan; MariaDB: rows
    const rows = table['rows_examined_per_scan'] ?? table['rows'];
    if (rows != null) {
      result.rowsExaminedPerScan = Number(rows);
    }
    if (table['key'] != null) {
      result.usedIndex = table['key'];
    }
  }

  return result;
}

/**
 * Tool definition for analyze_query
 */
export const analyzeQueryDefinition = {
  name: 'analyze_query',
  description:
    'Analyze a SELECT/WITH query: execution plan (EXPLAIN FORMAT=JSON) and, on MySQL 8 with performance_schema, digest statistics.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'SQL query to analyze',
      },
      params: {
        type: 'object',
        description: 'Named parameters for the query',
        additionalProperties: true,
        default: {},
      },
      includeExecutionPlan: {
        type: 'boolean',
        default: true,
        description: 'Include execution plan details (default: true)',
      },
    },
    required: ['query'],
  },
};
