/**
 * Minimal MySQL/MariaDB lexer shared by the query validator and the parameter
 * compiler, so both see exactly the same token boundaries.
 *
 * It mirrors the server lexer for the default sql_mode (backslash escapes in
 * '...' and "..." strings, "..." is a string and not an identifier). The
 * server connection enforces such a sql_mode before any query runs (see
 * db/session.ts), otherwise the lexing below would not match the server's.
 *
 * Everything the server could read differently is reported, not guessed:
 * unterminated literals/comments, executable comments, optimizer hints,
 * non-ASCII or control characters outside literals.
 */

export type TokenType =
  | 'word' // identifier or keyword, ASCII [A-Za-z0-9_$]+
  | 'qident' // `quoted identifier`
  | 'string' // '...' or "..."
  | 'sysvar' // @@name or @@scope.name
  | 'uservar' // @name, @'name', @"name", @`name`
  | 'punct' // any other single ASCII character
  | 'ws' // whitespace run
  | 'comment' // /* */, # or "-- " comment (harmless ones)
  | 'exec_comment' // /*! ... */ or /*M! ... */ (the server runs the content)
  | 'hint' // /*+ ... */ optimizer hint
  | 'invalid'; // a character that is not allowed outside literals

export interface Token {
  type: TokenType;
  /** Raw text of the token */
  text: string;
  start: number;
  end: number;
  /** uservar: the variable name (without @); `quoted` when written as @'x', @"x" or @`x` */
  name?: string;
  quoted?: boolean;
}

export interface LexResult {
  tokens: Token[];
  error?: string;
}

/** Whitespace for the server (ASCII ctype): space, \t, \n, \v, \f, \r */
const WS = /^[ \t\n\v\f\r]$/;
const WORD_CHAR = /^[A-Za-z0-9_$]$/;

/**
 * Does "--" followed by this character start a comment?
 * MySQL/MariaDB require an ASCII whitespace or control character (or the end of
 * the query). JavaScript's \s is NOT the same set: NBSP, U+2028, U+FEFF... are
 * not whitespace for the server, and DEL (0x7f) is a control character for it.
 */
export function endsDoubleDash(ch: string | undefined): boolean {
  return ch === undefined || /^[\x00-\x20\x7f]$/.test(ch);
}

/**
 * Split a query into tokens. Never throws; problems are reported in `error`
 * (the tokens collected so far are still returned).
 */
export function lex(query: string): LexResult {
  const tokens: Token[] = [];
  const n = query.length;
  let i = 0;

  const push = (type: TokenType, start: number, end: number, extra: Partial<Token> = {}) => {
    tokens.push({ type, text: query.slice(start, end), start, end, ...extra });
  };

  // A raw NUL can end a comment early in some server versions: never accept it.
  if (query.includes('\u0000')) {
    return { tokens, error: 'NUL characters are not allowed in the query (use CHAR(0) or a parameter)' };
  }

  while (i < n) {
    const ch = query[i];
    const next = query[i + 1];

    // Block comments, executable comments and optimizer hints
    if (ch === '/' && next === '*') {
      const end = query.indexOf('*/', i + 2);
      if (end === -1) {
        return { tokens, error: 'Unterminated block comment' };
      }
      const third = query[i + 2];
      let type: TokenType = 'comment';
      if (third === '!' || (third === 'M' && query[i + 3] === '!')) type = 'exec_comment';
      else if (third === '+') type = 'hint';
      push(type, i, end + 2);
      i = end + 2;
      continue;
    }

    // "#" comment and "-- " comment, both up to the end of the line ("\n" only)
    if (ch === '#' || (ch === '-' && next === '-' && endsDoubleDash(query[i + 2]))) {
      const nl = query.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      push('comment', i, end);
      i = end;
      continue;
    }

    // String literals and quoted identifiers
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = scanQuoted(query, i);
      if (end === -1) {
        return { tokens, error: 'Unterminated string or quoted identifier' };
      }
      push(ch === '`' ? 'qident' : 'string', i, end);
      i = end;
      continue;
    }

    // System variables (@@x, @@session.x) and user variables (@x, @'x', @`x`)
    if (ch === '@') {
      if (next === '@') {
        let j = i + 2;
        while (j < n && (WORD_CHAR.test(query[j]) || query[j] === '.')) j++;
        if (j === i + 2) {
          return { tokens, error: 'Malformed system variable reference' };
        }
        push('sysvar', i, j);
        i = j;
        continue;
      }
      if (next === "'" || next === '"' || next === '`') {
        const end = scanQuoted(query, i + 1);
        if (end === -1) {
          return { tokens, error: 'Unterminated string or quoted identifier' };
        }
        push('uservar', i, end, { name: query.slice(i + 2, end - 1), quoted: true });
        i = end;
        continue;
      }
      let j = i + 1;
      while (j < n && (WORD_CHAR.test(query[j]) || query[j] === '.')) j++;
      push('uservar', i, j, { name: query.slice(i + 1, j), quoted: false });
      i = j;
      continue;
    }

    if (WS.test(ch)) {
      let j = i + 1;
      while (j < n && WS.test(query[j])) j++;
      push('ws', i, j);
      i = j;
      continue;
    }

    if (WORD_CHAR.test(ch)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(query[j])) j++;
      push('word', i, j);
      i = j;
      continue;
    }

    // Non-ASCII and control characters outside literals: the server's notion of
    // identifier/whitespace characters differs from ours, so do not guess.
    const code = ch.charCodeAt(0);
    if (code > 0x7e || code < 0x20) {
      push('invalid', i, i + 1);
      i++;
      continue;
    }

    push('punct', i, i + 1);
    i++;
  }

  return { tokens };
}

/**
 * Scan a quoted literal starting at `start` (the opening quote).
 * Returns the index just after the closing quote, or -1 when unterminated.
 * Backslash escapes apply to '...' and "..." (default sql_mode), never to `...`.
 */
function scanQuoted(query: string, start: number): number {
  const quote = query[start];
  const n = query.length;
  let j = start + 1;
  while (j < n) {
    const c = query[j];
    if (c === '\\' && quote !== '`') {
      j += 2;
      continue;
    }
    if (c === quote) {
      if (query[j + 1] === quote) {
        j += 2; // doubled quote
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return -1;
}

/**
 * Tokens that carry SQL meaning (no whitespace, no harmless comments)
 */
export function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.type !== 'ws' && t.type !== 'comment');
}
