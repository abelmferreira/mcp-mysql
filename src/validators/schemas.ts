import { z } from 'zod';
import { config } from '../config.js';

/**
 * SQL parameter value - supports common SQL types
 */
export const sqlParamValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * SQL parameters object
 */
export const sqlParamsSchema = z
  .record(z.string(), sqlParamValueSchema)
  .default({})
  .describe('Named parameters to bind (without @). Example: { "userId": 123, "status": "active" }');

/**
 * Pagination schema for list operations
 */
export const paginationSchema = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .max(5000)
    .default(100)
    .describe('Maximum rows to return (default: 100, max: 5000)'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Number of rows to skip for pagination (default: 0)'),
});

/**
 * Table filter schema for schema operations
 */
export const tableFilterSchema = z.object({
  schema: z
    .string()
    .optional()
    .describe('Filter by schema name (e.g., "mydb")'),
  table: z
    .string()
    .optional()
    .describe('Filter by table name'),
  pattern: z
    .string()
    .optional()
    .describe('LIKE pattern for filtering (e.g., "%user%")'),
});

/**
 * Schema for sql_execute tool
 */
export const sqlExecuteSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'SQL SELECT query with @param placeholders. Only SELECT queries allowed in READONLY mode.'
    ),
  params: sqlParamsSchema,
  maxRows: z
    .number()
    .int()
    .positive()
    .max(5000)
    .default(100)
    .describe('Maximum rows to return (default: 100; capped by MAX_ROWS, at most 5000)'),
});

/**
 * Schema for schema_list_tables tool
 */
export const listTablesSchema = z.object({
  schema: z
    .string()
    .optional()
    .describe('Filter by schema name (e.g., "mydb")'),
  type: z
    .enum(['TABLE', 'VIEW', 'ALL'])
    .default('ALL')
    .describe('Filter by object type: TABLE, VIEW, or ALL'),
  pattern: z
    .string()
    .optional()
    .describe('LIKE pattern for table name (e.g., "%user%")'),
});

/**
 * Schema for schema_describe_table tool
 */
export const describeTableSchema = z.object({
  table: z.string().min(1).describe('Table name to describe'),
  schema: z.string().default(config.SQL_DATABASE).describe('Database/schema name (defaults to the connected database)'),
});

/**
 * Schema for schema_list_columns tool
 */
export const listColumnsSchema = z.object({
  pattern: z
    .string()
    .optional()
    .describe('LIKE pattern for column name (e.g., "%id%")'),
  dataType: z
    .string()
    .optional()
    .describe('Filter by data type (e.g., "int", "varchar")'),
  table: z
    .string()
    .optional()
    .describe('Filter by table name'),
  schema: z
    .string()
    .optional()
    .describe('Filter by schema name'),
});

/**
 * Schema for schema_list_procedures tool
 */
export const listProceduresSchema = z.object({
  schema: z
    .string()
    .optional()
    .describe('Filter by schema name (e.g., "mydb")'),
  pattern: z
    .string()
    .optional()
    .describe('LIKE pattern for procedure name'),
});

/**
 * Schema for schema_list_indexes tool
 */
export const listIndexesSchema = z.object({
  table: z.string().optional().describe('Filter by table name'),
  schema: z.string().optional().describe('Filter by schema name'),
});

/**
 * Schema for monitor_active_queries tool
 */
export const activeQueriesSchema = z.object({
  minDurationMs: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Filter queries with minimum duration in milliseconds'),
  includeSystemQueries: z
    .boolean()
    .default(false)
    .describe('Include system queries (default: false)'),
});

/**
 * Schema for monitor_wait_stats tool
 */
export const waitStatsSchema = z.object({
  top: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(10)
    .describe('Number of wait types to return (default: 10)'),
  excludeIdle: z
    .boolean()
    .default(true)
    .describe('Exclude idle/benign waits (default: true)'),
});

/**
 * Schema for monitor_performance_counters tool
 */
export const perfCountersSchema = z.object({
  category: z
    .enum(['buffer', 'sql', 'locks', 'memory', 'all'])
    .default('all')
    .describe('Counter category: buffer, sql, locks, memory, or all'),
});

/**
 * Schema for analyze_query tool
 */
export const analyzeQuerySchema = z.object({
  query: z.string().min(1).describe('SQL query to analyze'),
  params: sqlParamsSchema,
  includeExecutionPlan: z
    .boolean()
    .default(true)
    .describe('Include execution plan details (default: true)'),
});

/**
 * Schema for suggest_indexes tool
 */
export const suggestIndexesSchema = z.object({
  table: z
    .string()
    .optional()
    .describe('Filter suggestions for a specific table'),
  top: z
    .number()
    .int()
    .positive()
    .max(50)
    .default(20)
    .describe('Maximum number of suggestions (default: 20)'),
});

/**
 * Schema for analyze_unused_indexes tool
 */
export const unusedIndexesSchema = z.object({
  table: z.string().optional().describe('Filter for a specific table'),
});

/**
 * Schema for analyze_duplicate_indexes tool
 */
export const duplicateIndexesSchema = z.object({
  table: z.string().optional().describe('Filter for a specific table'),
});

/**
 * Schema for analyze_index_fragmentation tool
 */
export const fragmentationSchema = z.object({
  table: z.string().optional().describe('Filter for a specific table'),
  minFragmentation: z
    .number()
    .min(0)
    .max(100)
    .default(10)
    .describe('Minimum fragmentation percentage (default: 10)'),
  minPageCount: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Minimum table size in InnoDB pages (default: 0 = no minimum)'),
});

/**
 * Schema for analyze_statistics tool
 */
export const statisticsSchema = z.object({
  table: z.string().optional().describe('Filter for a specific table'),
});

/**
 * Schema for sql_insert tool
 */
export const sqlInsertSchema = z.object({
  table: z.string().min(1).describe('Table name to insert into'),
  schema: z.string().default(config.SQL_DATABASE).describe('Database/schema name (defaults to the connected database)'),
  data: z
    .record(z.string(), sqlParamValueSchema)
    .describe('Data to insert as key-value pairs'),
});

/**
 * Schema for sql_update tool
 */
export const sqlUpdateSchema = z.object({
  table: z.string().min(1).describe('Table name to update'),
  schema: z.string().default(config.SQL_DATABASE).describe('Database/schema name (defaults to the connected database)'),
  data: z
    .record(z.string(), sqlParamValueSchema)
    .describe('Fields to update as key-value pairs'),
  where: z
    .string()
    .min(1)
    .describe('WHERE clause (required for safety). Example: "Id = @id"'),
  params: sqlParamsSchema,
});

/**
 * Schema for sql_delete tool
 */
export const sqlDeleteSchema = z.object({
  table: z.string().min(1).describe('Table name to delete from'),
  schema: z.string().default(config.SQL_DATABASE).describe('Database/schema name (defaults to the connected database)'),
  where: z
    .string()
    .min(1)
    .describe('WHERE clause (required for safety). Example: "Id = @id"'),
  params: sqlParamsSchema,
});
