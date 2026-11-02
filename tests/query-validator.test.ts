import { describe, it, expect } from 'vitest';
import { validateQuery, isWriteOperation, getQueryType } from '../src/validators/query-validator.js';

const ok = (q: string) => expect(validateQuery(q)).toMatchObject({ valid: true });
const bad = (q: string, reason?: RegExp) => {
  const r = validateQuery(q);
  expect(r.valid).toBe(false);
  if (reason) expect(r.reason).toMatch(reason);
};

describe('validateQuery - allowed', () => {
  it('accepts plain SELECT, trailing semicolon, CTE and EXPLAIN', () => {
    ok('SELECT 1');
    ok('select * from orders;');
    ok('WITH c AS (SELECT id FROM orders) SELECT * FROM c');
    ok('EXPLAIN SELECT * FROM orders');
  });

  it('does not confuse identifiers that contain keywords', () => {
    ok('SELECT updated_at, timecreated, deletioninprogress FROM t');
  });

  it('ignores keywords inside string literals and quoted identifiers', () => {
    ok("SELECT * FROM t WHERE name = 'delete from users; drop table x'");
    ok('SELECT `update`, `into` FROM t');
    ok('SELECT * FROM t WHERE a = "it\'s into outfile"');
    ok("SELECT * FROM t WHERE a = 'it''s an update'");
  });

  it('accepts CHARACTER SET, REPLACE() and --x that is not a comment', () => {
    ok('SELECT CONVERT(a USING utf8mb4), CAST(b AS CHAR CHARACTER SET utf8) FROM t');
    ok("SELECT REPLACE(name, 'a', 'b') FROM t");
    ok('SELECT 1--1');
  });

  it('accepts harmless comments', () => {
    ok('SELECT 1 /* nota */ FROM dual');
    ok('SELECT 1 -- nota\nFROM dual');
    ok('SELECT 1 # nota\nFROM dual');
  });
});

describe('validateQuery - blocked', () => {
  it('rejects empty and non-SELECT statements', () => {
    bad('', /empty/i);
    bad('   -- só comentário', /empty/i);
    bad('DELETE FROM users', /must start with/i);
    bad('INSERT INTO t VALUES (1)', /must start with/i);
    // SHOW TABLES is allowed since the read-only SHOW allowlist; other SHOW forms are not
    bad('SHOW GRANTS', /Only these SHOW statements/i);
    bad('SELECTX 1', /must start with/i);
  });

  it('rejects stacked statements, including after comments', () => {
    bad('SELECT 1; DELETE FROM t', /multiple statements/i);
    bad('SELECT 1; SELECT 2', /multiple statements/i);
    bad('SELECT 1 /* x */ ; /* y */ DROP TABLE t', /multiple statements/i);
  });

  it('rejects write keywords hidden in a SELECT/CTE', () => {
    bad('WITH c AS (SELECT 1) DELETE FROM t', /DELETE/);
    bad('SELECT * FROM t UNION SELECT 1 FOR UPDATE', /UPDATE/);
    bad('SELECT * FROM t LOCK IN SHARE MODE', /LOCK/);
    bad('SELECT * FROM t FOR SHARE', /FOR SHARE/);
    bad('EXPLAIN DELETE FROM t', /DELETE/);
  });

  it('rejects SELECT ... INTO in every layout (single line, multi line, tabs)', () => {
    bad("SELECT 1 INTO OUTFILE '/tmp/x'", /INTO/);
    bad("SELECT 1\nINTO\nOUTFILE '/tmp/x'", /INTO/);
    bad("SELECT 1\tINTO DUMPFILE '/tmp/x'", /INTO/);
    bad('SELECT 1 INTO @v', /INTO/);
  });

  it('rejects executable comments, which the server runs', () => {
    bad("SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */", /executable comments/i);
    bad('SELECT 1 /*M!100100 FOR UPDATE */', /executable comments/i);
  });

  it('does not let "--x" or "#" hide code', () => {
    // "--x" is not a comment for the server, so the DELETE is real SQL and must be seen
    bad('SELECT 1 --x\nWITH a AS (SELECT 1) DELETE FROM t', /DELETE/);
    bad('SELECT 1 # c\n, (SELECT 1 FROM t FOR UPDATE)', /UPDATE/);
  });

  it('rejects unterminated strings, identifiers and comments', () => {
    bad("SELECT 'abc", /unterminated/i);
    bad('SELECT `abc', /unterminated/i);
    bad('SELECT 1 /* abc', /unterminated/i);
  });

  it('rejects side-effect and file functions', () => {
    bad('SELECT SLEEP(100)', /SLEEP/);
    bad('SELECT sleep (100)', /SLEEP/);
    bad("SELECT LOAD_FILE('/etc/passwd')", /LOAD_FILE/);
    bad('SELECT BENCHMARK(1000000000, MD5(1))', /BENCHMARK/);
    bad("SELECT GET_LOCK('x', 10)", /GET_LOCK/);
  });
});

describe('helpers', () => {
  it('isWriteOperation / getQueryType', () => {
    expect(isWriteOperation('UPDATE t SET a=1')).toBe(true);
    expect(isWriteOperation('SELECT 1')).toBe(false);
    expect(getQueryType('WITH a AS (SELECT 1) SELECT * FROM a')).toBe('CTE');
    expect(getQueryType('explain select 1')).toBe('EXPLAIN');
    expect(getQueryType('select 1')).toBe('SELECT');
  });
});
