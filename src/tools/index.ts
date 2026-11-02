// Query Tools
export { sqlExecute, sqlExecuteDefinition } from './sql-execute.js';

// Schema Tools
export { schemaListTables, schemaListTablesDefinition } from './schema-list-tables.js';
export { schemaDescribeTable, schemaDescribeTableDefinition } from './schema-describe-table.js';
export { schemaListColumns, schemaListColumnsDefinition } from './schema-list-columns.js';
export { schemaListProcedures, schemaListProceduresDefinition } from './schema-list-procedures.js';
export { schemaListIndexes, schemaListIndexesDefinition } from './schema-list-indexes.js';

// Monitor Tools
export { monitorActiveQueries, monitorActiveQueriesDefinition } from './monitor-active-queries.js';
export { monitorBlocking, monitorBlockingDefinition } from './monitor-blocking.js';
export { monitorWaitStats, monitorWaitStatsDefinition } from './monitor-wait-stats.js';
export { monitorDatabaseSize, monitorDatabaseSizeDefinition } from './monitor-database-size.js';
export { monitorConnections, monitorConnectionsDefinition } from './monitor-connections.js';
export {
  monitorPerformanceCounters,
  monitorPerformanceCountersDefinition,
} from './monitor-performance-counters.js';

// Analysis Tools
export { analyzeQuery, analyzeQueryDefinition } from './analyze-query.js';
export { analyzeSuggestIndexes, analyzeSuggestIndexesDefinition } from './analyze-suggest-indexes.js';
export { analyzeUnusedIndexes, analyzeUnusedIndexesDefinition } from './analyze-unused-indexes.js';
export {
  analyzeDuplicateIndexes,
  analyzeDuplicateIndexesDefinition,
} from './analyze-duplicate-indexes.js';
export { analyzeFragmentation, analyzeFragmentationDefinition } from './analyze-fragmentation.js';
export { analyzeStatistics, analyzeStatisticsDefinition } from './analyze-statistics.js';

// Write Tools (READONLY=false only)
export { sqlInsert, sqlInsertDefinition } from './sql-insert.js';
export { sqlUpdate, sqlUpdateDefinition } from './sql-update.js';
export { sqlDelete, sqlDeleteDefinition } from './sql-delete.js';

// Tool Registry
import { config } from '../config.js';
import type { ToolResponse } from '../types.js';

// Import all tools
import { sqlExecute, sqlExecuteDefinition } from './sql-execute.js';
import { schemaListTables, schemaListTablesDefinition } from './schema-list-tables.js';
import { schemaDescribeTable, schemaDescribeTableDefinition } from './schema-describe-table.js';
import { schemaListColumns, schemaListColumnsDefinition } from './schema-list-columns.js';
import { schemaListProcedures, schemaListProceduresDefinition } from './schema-list-procedures.js';
import { schemaListIndexes, schemaListIndexesDefinition } from './schema-list-indexes.js';
import { monitorActiveQueries, monitorActiveQueriesDefinition } from './monitor-active-queries.js';
import { monitorBlocking, monitorBlockingDefinition } from './monitor-blocking.js';
import { monitorWaitStats, monitorWaitStatsDefinition } from './monitor-wait-stats.js';
import { monitorDatabaseSize, monitorDatabaseSizeDefinition } from './monitor-database-size.js';
import { monitorConnections, monitorConnectionsDefinition } from './monitor-connections.js';
import {
  monitorPerformanceCounters,
  monitorPerformanceCountersDefinition,
} from './monitor-performance-counters.js';
import { analyzeQuery, analyzeQueryDefinition } from './analyze-query.js';
import { analyzeSuggestIndexes, analyzeSuggestIndexesDefinition } from './analyze-suggest-indexes.js';
import { analyzeUnusedIndexes, analyzeUnusedIndexesDefinition } from './analyze-unused-indexes.js';
import {
  analyzeDuplicateIndexes,
  analyzeDuplicateIndexesDefinition,
} from './analyze-duplicate-indexes.js';
import { analyzeFragmentation, analyzeFragmentationDefinition } from './analyze-fragmentation.js';
import { analyzeStatistics, analyzeStatisticsDefinition } from './analyze-statistics.js';
import { sqlInsert, sqlInsertDefinition } from './sql-insert.js';
import { sqlUpdate, sqlUpdateDefinition } from './sql-update.js';
import { sqlDelete, sqlDeleteDefinition } from './sql-delete.js';

/**
 * Tool handler type
 */
type ToolHandler = (args: unknown) => Promise<ToolResponse>;

/**
 * Tool definition with handler
 */
interface Tool {
  definition: {
    name: string;
    description: string;
    inputSchema: unknown;
  };
  handler: ToolHandler;
  requiresWrite?: boolean;
}

/**
 * All available tools
 */
const allTools: Tool[] = [
  // Query tools
  { definition: sqlExecuteDefinition, handler: sqlExecute },

  // Schema tools
  { definition: schemaListTablesDefinition, handler: schemaListTables },
  { definition: schemaDescribeTableDefinition, handler: schemaDescribeTable },
  { definition: schemaListColumnsDefinition, handler: schemaListColumns },
  { definition: schemaListProceduresDefinition, handler: schemaListProcedures },
  { definition: schemaListIndexesDefinition, handler: schemaListIndexes },

  // Monitor tools
  { definition: monitorActiveQueriesDefinition, handler: monitorActiveQueries },
  { definition: monitorBlockingDefinition, handler: monitorBlocking },
  { definition: monitorWaitStatsDefinition, handler: monitorWaitStats },
  { definition: monitorDatabaseSizeDefinition, handler: monitorDatabaseSize },
  { definition: monitorConnectionsDefinition, handler: monitorConnections },
  { definition: monitorPerformanceCountersDefinition, handler: monitorPerformanceCounters },

  // Analysis tools
  { definition: analyzeQueryDefinition, handler: analyzeQuery },
  { definition: analyzeSuggestIndexesDefinition, handler: analyzeSuggestIndexes },
  { definition: analyzeUnusedIndexesDefinition, handler: analyzeUnusedIndexes },
  { definition: analyzeDuplicateIndexesDefinition, handler: analyzeDuplicateIndexes },
  { definition: analyzeFragmentationDefinition, handler: analyzeFragmentation },
  { definition: analyzeStatisticsDefinition, handler: analyzeStatistics },

  // Write tools (READONLY=false only)
  { definition: sqlInsertDefinition, handler: sqlInsert, requiresWrite: true },
  { definition: sqlUpdateDefinition, handler: sqlUpdate, requiresWrite: true },
  { definition: sqlDeleteDefinition, handler: sqlDelete, requiresWrite: true },
];

/**
 * Get all available tools based on READONLY mode
 */
export function getAvailableTools(): Tool[] {
  if (config.READONLY) {
    return allTools.filter((tool) => !tool.requiresWrite);
  }
  return allTools;
}

/**
 * Get tool definitions for MCP server
 */
export function getToolDefinitions(): Array<{
  name: string;
  description: string;
  inputSchema: unknown;
}> {
  return getAvailableTools().map((tool) => tool.definition);
}

/**
 * Get tool handler by name
 */
export function getToolHandler(name: string): ToolHandler | undefined {
  const tool = getAvailableTools().find((t) => t.definition.name === name);
  return tool?.handler;
}
