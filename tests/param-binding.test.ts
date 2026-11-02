/**
 * Parameter smuggling (security review A1/C3).
 *
 * Before: the validator checked the TEMPLATE, compileQuery() turned @p into
 * "?", and mysql2 interpolated the values client-side with a lexer that does
 * not know "..." strings, "#" comments or "/*+" comments. A "?" that the
 * server saw inside a string could be replaced, and the value then closed the
 * string and ran as SQL.
 *
 * Now: compileQuery() renders the values itself, with the validator's lexer,
 * and the final text is what is validated and sent (no driver interpolation).
 * Each case checks that the payload stays inside ONE string literal of the
 * final SQL, and that the driver does not rewrite the text it is given.
 */
import { describe, it, expect } from 'vitest';
import mysql from 'mysql2';
import { validateQuery } from '../src/validators/query-validator.js';
import { lex } from '../src/validators/sql-lexer.js';
import { compileQuery } from '../src/db/execute.js';

const PAYLOAD = ' AS a, LOAD_FILE(0x2f6574632f706173737764) AS pwned #';

function pipeline(template: string, params: Record<string, string | number>) {
  const finalSql = compileQuery(template, params);
  const strings = lex(finalSql).tokens.filter((t) => t.type === 'string').map((t) => t.text);
  return {
    templateValid: validateQuery(template, { allowParameters: true }).valid,
    finalSql,
    finalValid: validateQuery(finalSql).valid,
    strings,
    // executeQuery sends the text without values: the driver must leave it untouched
    driverSql: mysql.format(finalSql, []),
  };
}

describe('parameter binding cannot break out of string literals', () => {
  it('P1 double-quoted string before a "?" inside a string', () => {
    const r = pipeline(`SELECT " ' " AS x, ' ? ' AS y, @p AS z`, { p: PAYLOAD });
    expect(r.templateValid).toBe(true);
    expect(r.finalSql).toBe(`SELECT " ' " AS x, ' ? ' AS y, ' AS a, LOAD_FILE(0x2f6574632f706173737764) AS pwned #' AS z`);
    expect(r.strings.some((s) => s.includes('LOAD_FILE'))).toBe(true);
    expect(r.finalValid).toBe(true); // valid because LOAD_FILE is only data
    expect(r.driverSql).toBe(r.finalSql);
  });

  it('P2 "#" comment hiding a quote', () => {
    const r = pipeline(`SELECT 1 # '\n, ' @p ' AS y`, { p: PAYLOAD });
    // @p sits inside a string: it is not a placeholder and is left alone
    expect(r.finalSql).toBe(`SELECT 1 # '\n, ' @p ' AS y`);
    expect(r.driverSql).toBe(r.finalSql);
  });

  it('P3 "/*+" comment hiding a quote (and optimizer hints are refused anyway)', () => {
    const r = pipeline(`SELECT /*+ ' */ ' @p ' AS y`, { p: PAYLOAD });
    expect(r.finalSql).toBe(`SELECT /*+ ' */ ' @p ' AS y`);
    expect(r.templateValid).toBe(false);
  });

  it('P4 GET_LOCK smuggled in a value stays data', () => {
    const r = pipeline(`SELECT " ' " AS x, ' ? ' AS y, @p AS z`, {
      p: ' AS a, GET_LOCK(0x6a6f625f6c6f636b, 0) AS l #',
    });
    expect(r.strings.some((s) => s.includes('GET_LOCK'))).toBe(true);
    expect(r.driverSql).toBe(r.finalSql);
  });

  it('P5 placeholders inside comments are not bound (no shifted values)', () => {
    const sql = compileQuery('SELECT @a AS a -- @b\n, @c AS c /* @b */ # @b\n', { a: 1, b: 2, c: 3 });
    expect(sql).toBe('SELECT 1 AS a -- @b\n, 3 AS c /* @b */ # @b\n');
  });

  it('P6 quotes and backslashes in values are escaped for the enforced sql_mode', () => {
    const r = pipeline('SELECT @p AS a', { p: "x' AS a, LOAD_FILE(0x2f) AS b -- " });
    expect(r.finalSql).toBe("SELECT 'x\\' AS a, LOAD_FILE(0x2f) AS b -- ' AS a");
    expect(r.strings).toHaveLength(1);
    expect(r.finalValid).toBe(true);
  });

  it('P7 a backslash at the end of a value cannot eat the closing quote', () => {
    const r = pipeline('SELECT @p AS a, @q AS b', { p: 'x\\', q: ', LOAD_FILE(0x2f) #' });
    expect(r.strings).toEqual(["'x\\\\'", "', LOAD_FILE(0x2f) #'"]);
  });

  it('P8 raw "?" placeholders are refused (the driver is never asked to interpolate)', () => {
    expect(() => compileQuery('SELECT * FROM t WHERE id = ?', {})).toThrow(/Positional/);
  });

  it('P9 a value glued to an identifier does not form a hex/bit literal', () => {
    expect(compileQuery('SELECT x@p', { p: '41' })).toBe("SELECT x '41'");
  });

  it('P10 negative numbers cannot form a "--" comment', () => {
    expect(compileQuery('SELECT 1-@p, 2', { p: -1 })).toBe('SELECT 1-(-1), 2');
  });
});
