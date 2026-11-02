import { executeQuery } from '../db/index.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import { optional, withWarnings } from './helpers.js';
import type { ToolResponse } from '../types.js';

const MAX_QUERY_TEXT = 1000;

/**
 * MySQL 8 (and MariaDB 10.6+ with the sys schema): sys.innodb_lock_waits
 */
const SYS_QUERY = `
  SELECT
    w.waiting_pid AS \`blockedSessionId\`,
    w.waiting_query AS \`blockedQuery\`,
    w.wait_age_secs AS \`waitAgeSeconds\`,
    w.locked_table AS \`lockedTable\`,
    w.locked_index AS \`lockedIndex\`,
    w.locked_type AS \`lockType\`,
    w.blocking_pid AS \`blockingSessionId\`,
    w.blocking_query AS \`blockingQuery\`
  FROM sys.innodb_lock_waits w
  ORDER BY w.wait_age_secs DESC
`;

/**
 * MariaDB / MySQL 5.7: information_schema.INNODB_LOCK_WAITS + INNODB_TRX (needs PROCESS)
 */
const INFORMATION_SCHEMA_QUERY = `
  SELECT
    r.trx_mysql_thread_id AS \`blockedSessionId\`,
    r.trx_query AS \`blockedQuery\`,
    TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS \`waitAgeSeconds\`,
    l.lock_table AS \`lockedTable\`,
    l.lock_index AS \`lockedIndex\`,
    l.lock_type AS \`lockType\`,
    b.trx_mysql_thread_id AS \`blockingSessionId\`,
    b.trx_query AS \`blockingQuery\`
  FROM information_schema.INNODB_LOCK_WAITS w
  JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id
  JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id
  LEFT JOIN information_schema.INNODB_LOCKS l ON l.lock_id = w.requested_lock_id
  ORDER BY \`waitAgeSeconds\` DESC
`;

interface BlockingRow {
  blockedSessionId: number;
  blockingSessionId: number;
  blockedQuery?: string | null;
  blockingQuery?: string | null;
}

function truncateText(text: string | null | undefined): string | null | undefined {
  return text && text.length > MAX_QUERY_TEXT ? text.substring(0, MAX_QUERY_TEXT) + '... [truncated]' : text;
}

/**
 * Tool: monitor_blocking
 * Monitor blocking sessions and lock chains. Tries sys.innodb_lock_waits
 * first, then the information_schema InnoDB tables; when neither is readable
 * the tool answers with an empty list and warnings instead of failing.
 */
export async function monitorBlocking(): Promise<ToolResponse> {
  try {
    const warnings: string[] = [];
    let source = 'sys.innodb_lock_waits';
    let result = await optional(warnings, 'sys.innodb_lock_waits', () => executeQuery(SYS_QUERY, {}, 100));
    if (!result) {
      source = 'information_schema.INNODB_LOCK_WAITS';
      result = await optional(warnings, 'information_schema.INNODB_LOCK_WAITS', () =>
        executeQuery(INFORMATION_SCHEMA_QUERY, {}, 100)
      );
    }

    if (!result) {
      return formatSuccess(
        withWarnings(
          {
            blocking: [],
            headBlockers: [],
            count: 0,
            note: 'Lock wait information is not available with the privileges of this account (needs the sys schema, or PROCESS for the information_schema InnoDB tables).',
          },
          warnings
        )
      );
    }

    const blocking = result.rows.map((row) => {
      const info = row as unknown as BlockingRow;
      return { ...row, blockedQuery: truncateText(info.blockedQuery), blockingQuery: truncateText(info.blockingQuery) };
    });

    // Head blockers: sessions that block others but are not themselves blocked
    const blocked = new Set(blocking.map((r) => (r as unknown as BlockingRow).blockedSessionId));
    const headBlockers = [
      ...new Set(
        blocking
          .map((r) => (r as unknown as BlockingRow).blockingSessionId)
          .filter((id) => id != null && !blocked.has(id))
      ),
    ];

    return formatSuccess(
      withWarnings(
        {
          blocking,
          headBlockers,
          count: result.rowCount,
          source,
          note: 'Session ids can be used with KILL by a DBA; this tool never kills anything.',
        },
        // A failing first source followed by a working fallback is not worth a warning
        source === 'sys.innodb_lock_waits' ? warnings : []
      )
    );
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for monitor_blocking
 */
export const monitorBlockingDefinition = {
  name: 'monitor_blocking',
  description:
    'Monitor blocking sessions and InnoDB lock waits. Shows which sessions are blocking others and identifies head blockers.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};
