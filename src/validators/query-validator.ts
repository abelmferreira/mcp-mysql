import { lex, significant, type Token } from './sql-lexer.js';

/**
 * Result of query validation
 */
export interface ValidationResult {
  valid: boolean;
  reason?: string;
  queryType?: string;
}

export interface ValidateOptions {
  /**
   * Accept `@name` user-variable tokens, because they are `@param`
   * placeholders that compileQuery() will replace with literals. Only used to
   * pre-check a template; the final SQL is always validated without it.
   */
  allowParameters?: boolean;
}

/**
 * Reserved keywords that are blocked anywhere in a READONLY statement (they are
 * matched on real SQL tokens only, i.e. not inside string literals, quoted
 * identifiers or comments). Being reserved, they cannot be used as bare column
 * names, so blocking them costs nothing; `t.delete` (qualified) is still allowed.
 *
 * Statement-only keywords that are NOT reserved (HANDLER, RESET, FLUSH, KILL,
 * EXECUTE, PREPARE, SHUTDOWN, INSTALL, PURGE, TRUNCATE, ...) are not listed:
 * they can only start a statement, and a statement must start with one of
 * ALLOWED_START_KEYWORDS. That keeps `SELECT reset, handler FROM t` and the
 * TRUNCATE() function usable.
 */
const BLOCKED_KEYWORDS = new Set([
  // DML / DDL that can appear after WITH or EXPLAIN, or as locking clauses
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'RENAME',
  // Privileges
  'GRANT',
  'REVOKE',
  // Routines
  'CALL',
  // Data movement and files
  'INTO', // SELECT ... INTO OUTFILE/DUMPFILE/@var, TABLE ... INTO
  'OUTFILE',
  'DUMPFILE',
  'LOAD',
  // Locks (SET is not listed: a statement cannot start with it, and CHARACTER SET is legitimate)
  'LOCK',
  'UNLOCK',
]);

/**
 * Functions with side effects, file access, session state that would outlive
 * the query, or that can hang a connection. Matched as a call (name + "(").
 * A blocklist cannot know user-defined functions (UDFs) or stored functions:
 * the database GRANT is the real barrier, see README.
 */
const BLOCKED_FUNCTIONS = new Set([
  'LOAD_FILE',
  'SLEEP',
  'BENCHMARK',
  // User-level locks (survive ROLLBACK)
  'GET_LOCK',
  'RELEASE_LOCK',
  'RELEASE_ALL_LOCKS',
  // MySQL locking service
  'SERVICE_GET_READ_LOCKS',
  'SERVICE_GET_WRITE_LOCKS',
  'SERVICE_RELEASE_LOCKS',
  // Replication waits (can block for a long time)
  'MASTER_POS_WAIT',
  'SOURCE_POS_WAIT',
  'MASTER_GTID_WAIT',
  'WAIT_FOR_EXECUTED_GTID_SET',
  'WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS',
  // MariaDB sequences (state change, not transactional)
  'NEXTVAL',
  'SETVAL',
  // Well-known command execution UDFs (lib_mysqludf_sys); not exhaustive
  'SYS_EXEC',
  'SYS_EVAL',
]);

/** Function name prefixes of administrative component functions (MySQL 8) */
const BLOCKED_FUNCTION_PREFIXES = ['GROUP_REPLICATION_', 'ASYNCHRONOUS_CONNECTION_FAILOVER_'];

/**
 * Identifiers of objects that hold credentials. Best effort only: the GRANT is
 * the real barrier (do not grant SELECT on the mysql schema).
 */
const SENSITIVE_IDENTIFIERS = new Set(['AUTHENTICATION_STRING', 'GLOBAL_PRIV', 'SLAVE_MASTER_INFO']);

/**
 * Keywords that are allowed to start a query in READONLY mode
 */
const ALLOWED_START_KEYWORDS = new Set(['SELECT', 'WITH', 'EXPLAIN', 'DESCRIBE', 'DESC', 'SHOW', 'TABLE', 'VALUES']);

/** Keywords allowed right after one or more opening parentheses: (SELECT ...) UNION (SELECT ...) */
const ALLOWED_PAREN_START = new Set(['SELECT', 'WITH', 'TABLE', 'VALUES']);

/** Optional modifiers between SHOW and the object it lists */
const SHOW_MODIFIERS = new Set(['FULL', 'EXTENDED', 'GLOBAL', 'SESSION', 'LOCAL']);

/** Read-only SHOW statements that are allowed (the words after the modifiers) */
const SHOW_ALLOWED = new Set([
  'TABLES',
  'COLUMNS',
  'FIELDS',
  'INDEX',
  'INDEXES',
  'KEYS',
  'STATUS',
  'VARIABLES',
  'DATABASES',
  'SCHEMAS',
  'TABLE STATUS',
  'CREATE TABLE',
  'CREATE VIEW',
]);

const ALLOWED_SHOW_TEXT =
  'SHOW [FULL] TABLES, SHOW [FULL] COLUMNS, SHOW INDEX, SHOW TABLE STATUS, SHOW CREATE TABLE/VIEW, ' +
  'SHOW [GLOBAL|SESSION] STATUS/VARIABLES, SHOW DATABASES';

/** Word token view used by the checks */
interface Word {
  upper: string;
  /** Index in the significant token list */
  index: number;
  /** `x.word` - an identifier for the server even when it is a keyword */
  qualified: boolean;
}

/** Locale independent upper case (the lexer only lets ASCII through outside literals) */
const asciiUpper = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));

const isPunct = (t: Token | undefined, text: string) => t !== undefined && t.type === 'punct' && t.text === text;

/**
 * Is `all[i]` (a word) read as an identifier by the server because it directly
 * follows "<identifier>."? The server lexer reads the word right after a "."
 * as an identifier, never as a keyword, when there is no whitespace between
 * them. We only rely on it when what precedes the dot is clearly an
 * identifier too (a `quoted identifier`, or a word that does not start with a
 * digit and is not itself after a non-identifier dot): in `1.INTO` the server
 * sees the number "1." followed by the INTO keyword.
 */
function isQualified(all: Token[], i: number, memo: Map<number, boolean>): boolean {
  const cached = memo.get(i);
  if (cached !== undefined) return cached;
  let result = false;
  const dot = all[i - 1];
  const before = all[i - 2];
  if (isPunct(dot, '.') && dot.end === all[i].start && before && before.end === dot.start) {
    if (before.type === 'qident') {
      result = true;
    } else if (before.type === 'word' && !/^[0-9]/.test(before.text)) {
      const prevDot = all[i - 3];
      const afterDot = isPunct(prevDot, '.') && prevDot.end === before.start;
      result = !afterDot || isQualified(all, i - 2, memo);
    }
  }
  memo.set(i, result);
  return result;
}

const fail = (reason: string, queryType = 'BLOCKED_PATTERN'): ValidationResult => ({
  valid: false,
  reason,
  queryType,
});

/** Upper-cased identifier name of a word or `quoted identifier` token, else null */
function identifierName(t: Token | undefined): string | null {
  if (!t) return null;
  if (t.type === 'word') return asciiUpper(t.text);
  if (t.type === 'qident') return asciiUpper(t.text.slice(1, -1).replace(/``/g, '`'));
  return null;
}

/**
 * Validate a query for READONLY mode.
 *
 * This is one layer of defence; the others are the server itself (queries
 * run inside START TRANSACTION READ ONLY with a statement timeout, see
 * db/execute.ts) and the database account, which should only hold SELECT.
 *
 * @param query The SQL text to validate (executeQuery validates the final text sent to the server)
 * @returns Validation result with valid flag and optional reason
 */
export function validateQuery(query: string, options: ValidateOptions = {}): ValidationResult {
  const { tokens, error } = lex(query);
  if (error) {
    return fail(error);
  }

  for (const t of tokens) {
    if (t.type === 'exec_comment') {
      return fail('Executable comments (/*! ... */) are not allowed');
    }
    if (t.type === 'hint') {
      return fail('Optimizer hints (/*+ ... */) are not allowed (they can override the statement timeout)');
    }
    if (t.type === 'invalid') {
      return fail(
        'Non-ASCII or control characters are only allowed inside string literals, `quoted identifiers` or comments'
      );
    }
  }

  // Only one statement is allowed. A single trailing ";" is tolerated.
  let body = significant(tokens);
  if (isPunct(body[body.length - 1], ';')) {
    body = body.slice(0, -1);
  }
  if (body.length === 0) {
    return fail('Query is empty', 'EMPTY');
  }
  if (body.some((t) => isPunct(t, ';'))) {
    return fail('Multiple statements are not allowed');
  }

  const memo = new Map<number, boolean>();
  const words: Word[] = [];
  body.forEach((t, index) => {
    if (t.type === 'word') {
      words.push({ upper: asciiUpper(t.text), index, qualified: isQualified(body, index, memo) });
    }
  });

  // Statement start
  let first = 0;
  while (isPunct(body[first], '(')) first++;
  const startToken = body[first];
  const startWord = startToken?.type === 'word' ? asciiUpper(startToken.text) : '';
  const allowedStarts = first > 0 ? ALLOWED_PAREN_START : ALLOWED_START_KEYWORDS;
  if (!allowedStarts.has(startWord)) {
    const found = startWord || startToken?.text || '';
    return fail(
      'Query must start with SELECT, WITH (CTE), EXPLAIN/DESCRIBE, a read-only SHOW, TABLE or VALUES. ' +
        `Found: ${found}`,
      found || 'UNKNOWN'
    );
  }

  // Words that are fine in their position (CREATE in SHOW CREATE TABLE)
  const exempt = new Set<number>();
  if (startWord === 'SHOW') {
    const showWords = words.filter((w) => w.index > first);
    let k = 0;
    while (k < showWords.length && SHOW_MODIFIERS.has(showWords[k].upper)) k++;
    const one = showWords[k]?.upper ?? '';
    const two = showWords[k + 1] ? `${one} ${showWords[k + 1].upper}` : '';
    if (SHOW_ALLOWED.has(two)) {
      if (one === 'CREATE') exempt.add(showWords[k].index);
    } else if (!SHOW_ALLOWED.has(one)) {
      return fail(`Only these SHOW statements are allowed: ${ALLOWED_SHOW_TEXT}. Found: SHOW ${one}`.trim(), 'SHOW');
    }
  }

  for (const w of words) {
    if (w.qualified || exempt.has(w.index)) continue;
    if (BLOCKED_KEYWORDS.has(w.upper)) {
      return fail(`Keyword "${w.upper}" is not allowed in READONLY mode`, w.upper);
    }
  }

  // Function calls: name followed by "(" (comments/whitespace in between do not matter)
  for (const w of words) {
    if (w.qualified || !isPunct(body[w.index + 1], '(')) continue;
    if (BLOCKED_FUNCTIONS.has(w.upper) || BLOCKED_FUNCTION_PREFIXES.some((p) => w.upper.startsWith(p))) {
      return fail(`Function "${w.upper}" is not allowed in READONLY mode`, 'BLOCKED_FUNCTION');
    }
  }

  // Multi-word clauses
  const seq = words.filter((w) => !w.qualified).map((w) => w.upper);
  const hasSeq = (...parts: string[]) => seq.some((_, i) => parts.every((p, k) => seq[i + k] === p));
  if (hasSeq('FOR', 'SHARE')) {
    return fail('Locking clause "FOR SHARE" is not allowed in READONLY mode');
  }
  if (hasSeq('FOR', 'CONNECTION')) {
    return fail('"EXPLAIN ... FOR CONNECTION" is not allowed in READONLY mode');
  }
  if (hasSeq('NEXT', 'VALUE', 'FOR')) {
    return fail('"NEXT VALUE FOR" (sequences) is not allowed in READONLY mode', 'BLOCKED_FUNCTION');
  }

  // Credential tables / columns (best effort; the GRANT is the real barrier)
  for (let i = 0; i < body.length; i++) {
    const name = identifierName(body[i]);
    if (name === null) continue;
    if (SENSITIVE_IDENTIFIERS.has(name)) {
      return fail(`Access to "${name.toLowerCase()}" (credentials) is not allowed in READONLY mode`);
    }
    if (name === 'MYSQL' && isPunct(body[i + 1], '.') && identifierName(body[i + 2]) === 'USER') {
      return fail('Access to "mysql.user" (credentials) is not allowed in READONLY mode');
    }
  }

  // @@system variables are fine. User variables are not (they keep session
  // state, e.g. @x := ...); @param placeholders are only accepted while
  // pre-checking a template. Checked last, so that e.g. "INTO @x" reports INTO.
  for (const t of body) {
    if (t.type === 'uservar' && (!options.allowParameters || t.quoted || !t.name)) {
      return fail(
        `User variables are not allowed in READONLY mode (found "${t.text.slice(0, 64)}"). ` +
          'Use @name placeholders together with the "params" argument.'
      );
    }
    if (isPunct(t, '?')) {
      return fail('Positional "?" placeholders are not supported; use @name placeholders and "params"');
    }
  }

  const queryType =
    startWord === 'EXPLAIN' || startWord === 'DESCRIBE' || startWord === 'DESC'
      ? 'EXPLAIN'
      : startWord === 'WITH'
        ? 'CTE'
        : startWord;
  return { valid: true, queryType };
}

/**
 * First keyword of a query (skipping comments, whitespace and opening parentheses)
 */
function firstKeyword(query: string): string {
  const t = significant(lex(query).tokens).find((tok) => !isPunct(tok, '('));
  return t?.type === 'word' ? asciiUpper(t.text) : '';
}

/**
 * Check if a query is a write operation
 */
export function isWriteOperation(query: string): boolean {
  return ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE'].includes(firstKeyword(query));
}

/**
 * Get the type of SQL operation from a query
 */
export function getQueryType(query: string): string {
  const first = firstKeyword(query);
  if (!first) return 'EMPTY';
  if (first === 'WITH') return 'CTE';
  if (first === 'EXPLAIN' || first === 'DESCRIBE' || first === 'DESC') return 'EXPLAIN';
  return first;
}
