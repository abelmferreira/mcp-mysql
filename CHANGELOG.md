# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-02

First release, published as `@abelmferreira/mcp-mysql` (npm) and
`abelmferreira/mcp-mysql` (Docker Hub).

### Added

- MySQL/MariaDB port of [`@fabriciofs/mcp-postgres`](https://github.com/fabriciofs/mcp-postgres):
  same tool surface and `READONLY` model, with all SQL rewritten for MySQL
  (`information_schema`, `performance_schema` and the `sys` schema).
- Tools: `sql_execute`; `schema_list_tables`, `schema_list_columns`,
  `schema_describe_table`, `schema_list_indexes`, `schema_list_procedures`;
  `monitor_active_queries`, `monitor_connections`, `monitor_blocking`,
  `monitor_wait_stats`, `monitor_database_size`, `monitor_performance_counters`;
  `analyze_query`, `analyze_suggest_indexes`, `analyze_unused_indexes`,
  `analyze_duplicate_indexes`, `analyze_fragmentation`, `analyze_statistics`;
  `sql_insert`, `sql_update`, `sql_delete` (only when `READONLY=false`).
  Tools that depend on `performance_schema` / `sys` return an explicit warning
  when it is disabled or not readable.
- `READONLY` mode (mandatory variable):
  - lexical query validator (single statement, allowlist of statement types,
    blocked write keywords, side-effect functions, executable comments and
    optimizer hints); `@name` parameters are bound by the same lexer, so the
    exact text sent to the server is validated;
  - unsafe `sql_mode` flags (`NO_BACKSLASH_ESCAPES`, `ANSI_QUOTES` and modes
    implying them) removed from the session, or the query is refused;
  - every query runs inside `START TRANSACTION READ ONLY`;
  - server-side statement timeout (`max_statement_time` on MariaDB,
    `max_execution_time` on MySQL; fail closed) plus a client-side timer with
    `KILL QUERY` (`QUERY_TIMEOUT`);
  - rows are streamed and reading stops at `MAX_ROWS` or `MAX_RESULT_BYTES`
    (`truncated` flag in the result);
  - each query uses its own connection, which is discarded afterwards.
- `ENV_FILE`: load a dotenv file before validating the configuration
  (variables already in the environment win).
- Built-in SSH tunnel (`ssh2`), configured only through `SSH_*` variables; the
  host key is always pinned (`SSH_HOST_FINGERPRINT`, format checked at startup).
- TLS with certificate verification by default (`SQL_SSL`, `SQL_SSL_CA`,
  `SQL_SSL_REJECT_UNAUTHORIZED`).
- Graceful shutdown: the server closes the pool and the SSH tunnel and exits
  when the client closes stdin, or on `SIGINT` / `SIGTERM` / `SIGHUP`
  (forced exit after 5 s if closing hangs).
- Docker image (multi-stage, non-root) and GitHub Actions for CI and
  publishing (npm Trusted Publishing with provenance, multi-arch image on
  Docker Hub).

[1.0.0]: https://github.com/abelmferreira/mcp-mysql/releases/tag/v1.0.0
