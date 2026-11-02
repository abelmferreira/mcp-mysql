/**
 * Regression tests for the READONLY query validator (security review).
 *
 * MUST BLOCK: a passing query would be a bypass at the validator layer.
 * SHOULD ALLOW: legitimate read queries that used to be false positives.
 * Every rule that was relaxed has matching "does not open a bypass" cases.
 */
import { describe, it, expect } from 'vitest';
import { validateQuery } from '../src/validators/query-validator.js';
import { endsDoubleDash, lex } from '../src/validators/sql-lexer.js';

type Case = [id: string, sql: string];

const mustBlock: Case[] = [
  // --- baseline ---
  ['B01 executable comment', 'SELECT 1 /*!50000 , LOAD_FILE(0x2f) */'],
  ['B02 executable comment (MariaDB)', 'SELECT 1 /*M!100000 , SLEEP(5) */'],
  ['B03 multiple statements', 'SELECT 1; DELETE FROM t'],
  ['B04 INTO OUTFILE', "SELECT * FROM t INTO OUTFILE '/tmp/x'"],
  ['B05 INTO DUMPFILE', "SELECT 0x41 INTO DUMPFILE '/tmp/x'"],
  ['B06 INTO @var', 'SELECT 1 INTO @a'],
  ['B07 LOAD_FILE', "SELECT LOAD_FILE('/etc/passwd')"],
  ['B08 comment between function name and parenthesis', 'SELECT SLEEP/**/(5)'],
  ['B09 BENCHMARK', 'SELECT BENCHMARK(1e9, MD5(1))'],
  ['B10 GET_LOCK', "SELECT GET_LOCK('job_lock', 0)"],
  ['B11 FOR UPDATE', 'SELECT * FROM t FOR UPDATE'],
  ['B12 LOCK IN SHARE MODE', 'SELECT * FROM t LOCK IN SHARE MODE'],
  ['B13 FOR SHARE', 'SELECT * FROM t FOR SHARE'],
  ['B14 CTE + DELETE', 'WITH c AS (SELECT 1) DELETE FROM t'],
  ['B15 CTE + UPDATE', 'WITH c AS (SELECT 1) UPDATE t SET a=1'],
  ['B16 EXPLAIN ANALYZE DELETE', 'EXPLAIN ANALYZE DELETE FROM t'],
  ['B17 CALL', 'CALL p()'],
  ['B18 DO', 'DO SLEEP(5)'],
  ['B19 HANDLER', 'HANDLER t OPEN'],
  ['B20 SET STATEMENT', 'SET STATEMENT max_statement_time=0 FOR SELECT SLEEP(100)'],
  ['B21 SET', 'SET @a = 1'],
  ['B22 keyword split by a comment', 'SEL/**/ECT 1'],
  ['B23 DEL/**/ETE', 'DEL/**/ETE FROM t'],
  ['B24 tab/CR/VT whitespace', 'SELECT\t1\r\n;\x0bDELETE FROM t'],
  ['B25 MASTER_POS_WAIT', "SELECT MASTER_POS_WAIT('f', 4)"],
  ['B26 NBSP before parenthesis', 'SELECT SLEEP (5)'],

  // --- lexer divergences: "--" followed by a character that JS \s and the server classify differently ---
  ['X01 "--" + NBSP is not a comment for the server', 'SELECT 1 -- , LOAD_FILE(0x2f6574632f706173737764)\nFROM (SELECT 2 AS ` `) t'],
  ['X02 "--" + U+2028', 'SELECT 1 -- , SLEEP(30)\nFROM (SELECT 2 AS ` `) t'],
  ['X03 "--" + U+FEFF', "SELECT 1 --﻿, GET_LOCK('job_lock', 0)\nFROM (SELECT 2 AS `﻿`) t"],
  ['X04 "--" + DEL (0x7f) IS a comment for the server', "SELECT 1 --\x7f '\n, LOAD_FILE(0x2f6574632f706173737764) -- '"],

  // --- side effects, hangs, session state, credentials ---
  ['N01 well-known command UDF', "SELECT sys_exec('id')"],
  ['N02 MASTER_GTID_WAIT (MariaDB)', "SELECT MASTER_GTID_WAIT('0-1-999999', 100000)"],
  ['N03 NEXTVAL (MariaDB sequence)', 'SELECT NEXTVAL(s1)'],
  ['N03b NEXT VALUE FOR', 'SELECT NEXT VALUE FOR s1'],
  ['N03c SETVAL', 'SELECT SETVAL(s1, 100)'],
  ['N04 optimizer hint overriding max_execution_time', 'SELECT /*+ MAX_EXECUTION_TIME(4294967295) */ COUNT(*) FROM a, b, c'],
  ['N04b SET_VAR hint', "SELECT /*+ SET_VAR(sql_mode='NO_BACKSLASH_ESCAPES') */ 1"],
  ['N05 quoted user variable assignment', "SELECT @`x` := 'persisted'"],
  ['N05b user variable assignment', "SELECT @x := 'persisted'"],
  ['N05c user variable read', 'SELECT @x'],
  ['N06 credential hashes', 'SELECT user, host, authentication_string FROM mysql.user'],
  ['N06b mysql.user quoted', 'SELECT * FROM `mysql`.`user`'],
  ['N07 MariaDB password hashes', 'SELECT * FROM mysql.global_priv'],
  ['N08 EXPLAIN FOR CONNECTION', 'EXPLAIN FOR CONNECTION 42'],
  ['N08b DESCRIBE FOR CONNECTION', 'DESC FORMAT=JSON FOR CONNECTION 42'],
  ['N10 RELEASE_ALL_LOCKS', 'SELECT RELEASE_ALL_LOCKS()'],
  ['N11 replication admin function prefix', "SELECT group_replication_set_as_primary('uuid')"],
  ['N12 raw "?" placeholder', 'SELECT * FROM t WHERE id = ?'],

  // --- characters the server could read differently ---
  ['U01 dotless i (would upper-case to INSERT)', 'SELECT ınsert FROM t'],
  ['U02 non-ASCII identifier outside backticks', 'SELECT updateé FROM t'],
  ['U03 control character outside literals', 'SELECT 1\x01FROM t'],
  ['U04 NUL anywhere', 'SELECT 1 # \u0000\n'],
  ['U05 unterminated string', "SELECT 'abc"],

  // --- relaxed rules must not open bypasses ---
  ['R01 number + dot + INTO is the INTO keyword', "SELECT 1.INTO OUTFILE '/tmp/x'"],
  ['R02 number.e.INTO', "SELECT 1.e.INTO OUTFILE '/tmp/x'"],
  ['R03 dot after whitespace-separated number', "SELECT 1 .INTO OUTFILE '/tmp/x'"],
  ['R04 dot then space then keyword', 'SELECT t. delete FROM t'],
  ['R05 dot hidden by a comment', 'SELECT t./**/delete FROM t'],
  ['R06 string followed by .keyword', "SELECT 'a'.delete FROM t"],
  ['R07 SHOW GRANTS', 'SHOW GRANTS'],
  ['R08 SHOW PROCESSLIST', 'SHOW FULL PROCESSLIST'],
  ['R09 SHOW CREATE USER', 'SHOW CREATE USER root'],
  ['R10 SHOW ENGINE INNODB STATUS', 'SHOW ENGINE INNODB STATUS'],
  ['R11 SHOW with a dangerous subquery', "SHOW TABLES WHERE (SELECT LOAD_FILE('/etc/passwd')) IS NULL"],
  ['R12 parenthesised DELETE', '(DELETE FROM t)'],
  ['R13 parenthesised EXPLAIN', '(EXPLAIN SELECT 1)'],
  ['R14 TABLE ... INTO OUTFILE', "TABLE t INTO OUTFILE '/tmp/x'"],
  ['R15 non-reserved statement keyword at the start', 'KILL 42'],
  ['R16 FLUSH at the start', 'FLUSH TABLES'],
  ['R17 TRUNCATE statement', 'TRUNCATE TABLE t'],
  ['R18 EXECUTE statement', 'EXECUTE stmt'],
  ['R19 SHOW CREATE TABLE ... then something else', 'SHOW CREATE TABLE t; DROP TABLE t'],
  ['R20 qualified function call keeps blocked builtins blocked when unqualified', 'SELECT t.sleep, SLEEP(1) FROM t'],
];

const shouldAllow: Case[] = [
  ['F01 updated_at / created_at', 'SELECT update_time, create_time, created_at FROM information_schema.TABLES'],
  ['F02 string with DELETE', "SELECT * FROM t WHERE note = 'please DELETE me; now'"],
  ['F03 SHOW TABLES', 'SHOW TABLES'],
  ['F04 SHOW CREATE TABLE', 'SHOW CREATE TABLE users'],
  ['F05 DESCRIBE', 'DESCRIBE users'],
  ['F06 DESC', 'DESC users'],
  ['F07 parenthesised SELECT', '(SELECT 1) UNION (SELECT 2)'],
  ['F08 qualified column named like a reserved word', 'SELECT t.delete FROM t'],
  ['F08b three-part qualified name', 'SELECT db.t.update FROM db.t'],
  ['F08c backtick-qualified', 'SELECT `t`.delete, `t`.into FROM t'],
  ['F09 non-reserved keyword as column: handler', 'SELECT handler FROM jobs'],
  ['F10 non-reserved keywords as columns', 'SELECT reset, flush, install, merge, kill FROM settings'],
  ['F11 column named lock via qualification', 'SELECT 1 AS load_avg, t.lock FROM t'],
  ['F12 keyword followed by $ (identifier character)', 'SELECT update$flag FROM t'],
  ['F13 unicode identifier in backticks', 'SELECT `updateé` FROM t'],
  ['F15 TABLE statement', 'TABLE app_config'],
  ['F16 VALUES statement', 'VALUES ROW(1,2)'],
  ['F17 IS_FREE_LOCK / IS_USED_LOCK are read-only', "SELECT IS_FREE_LOCK('x'), IS_USED_LOCK('x')"],
  ['F18 "--" + DEL is a comment for the server', "SELECT 1 --\x7f it's a note\nFROM dual"],
  ['F19 LIKE with ESCAPE', "SELECT * FROM t WHERE a LIKE 'x\\_%' ESCAPE '\\\\'"],
  ['F20 JSON path with keyword', "SELECT JSON_EXTRACT(doc, '$.delete') FROM t"],
  ['F21 information_schema lock tables', 'SELECT * FROM information_schema.INNODB_LOCK_WAITS'],
  ['F22 TRUNCATE() numeric function', 'SELECT TRUNCATE(1.2345, 2)'],
  ['F23 SHOW variants', 'SHOW FULL COLUMNS FROM t'],
  ['F24 SHOW GLOBAL STATUS with WHERE', "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime')"],
  ['F25 SHOW INDEX', 'SHOW INDEX FROM t'],
  ['F26 SHOW TABLE STATUS', "SHOW TABLE STATUS LIKE 'u%'"],
  ['F27 SHOW VARIABLES', "SHOW VARIABLES LIKE 'sql_mode'"],
  ['F28 SHOW DATABASES', 'SHOW DATABASES'],
  ['F29 SHOW CREATE VIEW', 'SHOW CREATE VIEW v'],
  ['F30 system variables', 'SELECT @@version, @@SESSION.sql_mode'],
  ['F31 non-ASCII in strings and comments', "SELECT 'ação' AS x -- descrição\n/* comentário */ FROM dual"],
  ['F32 mysql.innodb_table_stats is not a credential table', 'SELECT * FROM mysql.innodb_table_stats'],
  ['F33 EXPLAIN FORMAT=JSON', 'EXPLAIN FORMAT=JSON SELECT * FROM t'],
  ['F34 stored function qualified by schema', 'SELECT app.sleep(1)'],
];

describe('MUST BLOCK', () => {
  it.each(mustBlock)('%s', (_id, sql) => {
    const r = validateQuery(sql);
    expect(r.valid, `validator accepted: ${JSON.stringify(sql)}`).toBe(false);
  });
});

describe('SHOULD ALLOW', () => {
  it.each(shouldAllow)('%s', (_id, sql) => {
    const r = validateQuery(sql);
    expect(r.valid, `validator rejected (${r.reason}): ${JSON.stringify(sql)}`).toBe(true);
  });
});

describe('sql_mode dependent payloads', () => {
  // Under the default sql_mode these are harmless string literals, and that is
  // how the validator reads them. They would only be dangerous with
  // NO_BACKSLASH_ESCAPES / ANSI_QUOTES, which db/session.ts removes from every
  // session before a query runs (and refuses to run otherwise), see
  // tests/execute.test.ts.
  it.each([
    ['X05 NO_BACKSLASH_ESCAPES payload', "SELECT 'x\\' , LOAD_FILE(0x2f6574632f706173737764) , '"],
    ['X06 ANSI_QUOTES payload', 'SELECT 1 "a\\" , LOAD_FILE(0x2f6574632f706173737764) -- "'],
  ])('%s is a single string literal for the enforced sql_mode', (_id, sql) => {
    const strings = lex(sql).tokens.filter((t) => t.type === 'string');
    expect(strings).toHaveLength(1);
    expect(strings[0].text).toContain('LOAD_FILE');
  });
});

describe('specific reasons', () => {
  it.each([
    ["SELECT 1.INTO OUTFILE '/tmp/x'"],
    ["SELECT 1.e.INTO OUTFILE '/tmp/x'"],
    ["SELECT 1 .INTO OUTFILE '/tmp/x'"],
  ])('a dot after a number does not qualify the next keyword: %s', (sql) => {
    expect(validateQuery(sql).reason).toMatch(/"INTO"/);
  });

  it('optimizer hints are refused with an explanation', () => {
    expect(validateQuery('SELECT /*+ MAX_EXECUTION_TIME(1) */ 1').reason).toMatch(/Optimizer hints/);
  });

  it('non-ASCII outside literals is refused with an explanation', () => {
    expect(validateQuery('SELECT ınsert FROM t').reason).toMatch(/Non-ASCII/);
  });

  it('INTO @var reports INTO (not the user variable)', () => {
    expect(validateQuery('SELECT 1 INTO @v').reason).toMatch(/INTO/);
  });

  it('@param placeholders are accepted only when pre-checking a template', () => {
    expect(validateQuery('SELECT * FROM t WHERE id = @id').valid).toBe(false);
    expect(validateQuery('SELECT * FROM t WHERE id = @id', { allowParameters: true }).valid).toBe(true);
    // quoted user variables are never placeholders
    expect(validateQuery('SELECT @`id`', { allowParameters: true }).valid).toBe(false);
  });
});

describe('lexer', () => {
  it('"--" starts a comment only before ASCII whitespace/control characters or the end', () => {
    for (const ch of [undefined, ' ', '\t', '\n', '\r', '\x0b', '\x0c', '\x01', '\x7f']) {
      expect(endsDoubleDash(ch), JSON.stringify(ch)).toBe(true);
    }
    for (const ch of [' ', ' ', '﻿', 'x', '1', '-']) {
      expect(endsDoubleDash(ch), JSON.stringify(ch)).toBe(false);
    }
  });

  it('classifies comments, hints and executable comments', () => {
    const types = lex("SELECT /* a */ /*+ b */ /*! c */ # d\n-- e\n'f' `g` @@h @i @'j'").tokens.map((t) => t.type);
    expect(types.filter((t) => t !== 'ws')).toEqual([
      'word',
      'comment',
      'hint',
      'exec_comment',
      'comment',
      'comment',
      'string',
      'qident',
      'sysvar',
      'uservar',
      'uservar',
    ]);
  });
});
