// Minimal environment so modules that import config.ts can be loaded in tests.
process.env.READONLY ??= 'true';
process.env.SQL_SERVER ??= 'localhost';
process.env.SQL_DATABASE ??= 'test';
process.env.SQL_USER ??= 'test';
process.env.SQL_PASSWORD ??= 'test';
process.env.LOG_LEVEL ??= 'error';
