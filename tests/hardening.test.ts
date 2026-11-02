/**
 * Smaller hardening items of the security review: SSH fingerprint checks,
 * configuration validation, TLS options, write query builders, version.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fingerprintMatches, hexToFingerprint } from '../src/db/tunnel.js';
import { invalidFingerprints, parseConfig, ConfigError } from '../src/config.js';
import { buildInsertQuery, buildUpdateQuery, buildDeleteQuery, compileQuery, quoteIdentifier } from '../src/db/execute.js';
import { safeSqlMode } from '../src/db/session.js';
import { readPackageVersion } from '../src/server.js';

const hex = '4f2a'.repeat(16);
const b64 = Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');

describe('fingerprintMatches fails closed', () => {
  it.each(['', ' ', ',', ' , ', 'SHA256:', 'SHA256:=', 'MD5:ab:cd', 'SHA256:AAAA', b64.toLowerCase()])(
    'rejects %j',
    (fp) => {
      expect(fingerprintMatches(hex, fp)).toBe(false);
    }
  );

  it('accepts exact, with/without padding, any case of the prefix, in a list', () => {
    expect(fingerprintMatches(hex, `SHA256:${b64}=`)).toBe(true);
    expect(fingerprintMatches(hex, ` sha256:${b64} `)).toBe(true);
    expect(fingerprintMatches(hex, `SHA256:zzz,${b64}`)).toBe(true);
  });

  it('rejects a malformed digest from ssh2', () => {
    expect(fingerprintMatches('', '')).toBe(false);
    expect(fingerprintMatches('zz', 'SHA256:')).toBe(false);
    expect(fingerprintMatches('', `SHA256:${b64}`)).toBe(false);
  });

  it('formats the received digest for the mismatch log', () => {
    expect(hexToFingerprint(hex)).toBe(`SHA256:${b64}`);
  });
});

describe('SSH_HOST_FINGERPRINT format', () => {
  it('accepts one or more SHA256 fingerprints', () => {
    expect(invalidFingerprints(`SHA256:${b64}`)).toBeNull();
    expect(invalidFingerprints(`SHA256:${b64}=, sha256:${b64}`)).toBeNull();
  });

  it.each(['SHA256:', 'SHA256:AAAA', ' , ', 'MD5:aa:bb', b64])('rejects %j', (value) => {
    expect(invalidFingerprints(value)).not.toBeNull();
  });

  it('is enforced by parseConfig', () => {
    const env = {
      READONLY: 'true',
      SQL_SERVER: 'db',
      SQL_DATABASE: 'd',
      SQL_USER: 'u',
      SQL_PASSWORD: 'p',
      SSH_HOST: 'bastion.example.com',
      SSH_USER: 'tunnel',
      SSH_KEY_PATH: '/nonexistent',
      SSH_HOST_FINGERPRINT: 'SHA256:',
    };
    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(/SSH_HOST_FINGERPRINT/);
  });
});

describe('configuration', () => {
  const base = { READONLY: 'true', SQL_SERVER: 'db', SQL_DATABASE: 'd', SQL_USER: 'u', SQL_PASSWORD: 'p' };

  it('verifies TLS certificates by default', () => {
    expect(parseConfig({ ...base, SQL_SSL: 'true' }).SQL_SSL_REJECT_UNAUTHORIZED).toBe(true);
    expect(parseConfig({ ...base, SQL_SSL: 'true', SQL_SSL_REJECT_UNAUTHORIZED: 'false' }).SQL_SSL_REJECT_UNAUTHORIZED).toBe(false);
    expect(() => parseConfig({ ...base, SQL_SSL_REJECT_UNAUTHORIZED: 'no' })).toThrow(ConfigError);
  });

  it('checks that SQL_SSL_CA is readable', () => {
    expect(() => parseConfig({ ...base, SQL_SSL: 'true', SQL_SSL_CA: '/nonexistent/ca.pem' })).toThrow(/SQL_SSL_CA/);
  });

  it('caps POOL_MAX and ignores the obsolete POOL_MIN', () => {
    expect(() => parseConfig({ ...base, POOL_MAX: '500' })).toThrow(ConfigError);
    expect(parseConfig({ ...base, POOL_MIN: '2' })).not.toHaveProperty('POOL_MIN');
  });
});

describe('sql_mode sanitising', () => {
  it('removes only the flags that change string lexing', () => {
    expect(safeSqlMode('STRICT_TRANS_TABLES,ANSI_QUOTES,NO_BACKSLASH_ESCAPES')).toEqual({
      mode: 'STRICT_TRANS_TABLES',
      removed: ['ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES'],
    });
    expect(safeSqlMode('PIPES_AS_CONCAT,ANSI_QUOTES,IGNORE_SPACE,ORACLE').mode).toBe('PIPES_AS_CONCAT,IGNORE_SPACE');
    expect(safeSqlMode('').removed).toEqual([]);
  });
});

describe('write query builders (C4)', () => {
  it('a WHERE parameter cannot override a SET value', () => {
    const { query, params } = buildUpdateQuery('app', 'users', { role: 'user' }, 'id = @id', { id: 1, role: 'admin' });
    const sql = compileQuery(query, params);
    expect(sql).toContain("SET `role` = 'user'");
    expect(sql).toContain('WHERE id = 1;');
  });

  it('reserved placeholder names are refused in WHERE parameters', () => {
    expect(() => buildUpdateQuery('app', 'users', { a: 1 }, 'id = @__set0', { __set0: 1 })).toThrow(/reserved/);
    expect(() => buildDeleteQuery('app', 'users', 'id = @__val0', { __val0: 1 })).toThrow(/reserved/);
  });

  it('identifiers are quoted with backticks escaped', () => {
    expect(quoteIdentifier('we`ird')).toBe('`we``ird`');
    const { query, params } = buildInsertQuery('app', 'my`table', { 'col`x': "v'1", 'my-col': 2 });
    const sql = compileQuery(query, params);
    expect(sql).toContain('INSERT INTO `app`.`my``table` (`col``x`, `my-col`)');
    expect(sql).toContain("VALUES ('v\\'1', 2);");
    expect(() => quoteIdentifier('')).toThrow();
  });
});

describe('server version', () => {
  it('comes from package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(readPackageVersion()).toBe(pkg.version);
  });
});
