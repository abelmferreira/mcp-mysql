import { describe, it, expect } from 'vitest';
import { compileQuery, toSqlLiteral } from '../src/db/execute.js';

// compileQuery() now returns the FINAL SQL text, with the values rendered as
// literals by this server (it used to return "?" + a values array that the
// driver interpolated with a different lexer, see tests/param-binding.test.ts).
describe('compileQuery', () => {
  it('binds @params as literals, every occurrence', () => {
    expect(compileQuery('SELECT * FROM t WHERE a = @a AND b = @b AND c = @a', { a: 1, b: 'x' })).toBe(
      "SELECT * FROM t WHERE a = 1 AND b = 'x' AND c = 1"
    );
  });

  it('leaves e-mails and other @ inside strings alone', () => {
    expect(compileQuery("SELECT * FROM users WHERE email = 'someone@example.com' AND id = @id", { id: 7 })).toBe(
      "SELECT * FROM users WHERE email = 'someone@example.com' AND id = 7"
    );
  });

  it('leaves system variables (@@) and quoted identifiers alone', () => {
    expect(compileQuery('SELECT @@max_statement_time, `a@b` FROM t WHERE x = @x', { x: 1 })).toBe(
      'SELECT @@max_statement_time, `a@b` FROM t WHERE x = 1'
    );
  });

  it('throws when a parameter is missing', () => {
    expect(() => compileQuery('SELECT @nope', {})).toThrow(/nope/);
  });
});

describe('toSqlLiteral', () => {
  it('renders every supported type', () => {
    expect(toSqlLiteral(null)).toBe('NULL');
    expect(toSqlLiteral(true)).toBe('TRUE');
    expect(toSqlLiteral(false)).toBe('FALSE');
    expect(toSqlLiteral(42)).toBe('42');
    expect(toSqlLiteral(-1.5)).toBe('(-1.5)');
    expect(toSqlLiteral("it's \\ \"q\" \0 \n \r \t \x1a \b")).toBe(
      "'it\\'s \\\\ \\\"q\\\" \\0 \\n \\r \\t \\Z \\b'"
    );
  });

  it('refuses NaN / Infinity (they would be emitted as bare identifiers)', () => {
    expect(() => toSqlLiteral(NaN)).toThrow(/finite/);
    expect(() => toSqlLiteral(Infinity)).toThrow(/finite/);
  });
});
