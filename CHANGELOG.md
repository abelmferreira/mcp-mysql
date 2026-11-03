# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.2] - 2026-11-02

### Fixed
- Tools failed with `ER_USER_LIMIT_REACHED` (1226) on accounts with a low `max_user_connections`,
  even with `POOL_MAX` below the limit. The mysql2 pool forgets a connection as soon as `end()` /
  `destroy()` is called and opens the next one at once, while the server still counts the old
  session. A FIFO of `POOL_MAX` slots now bounds the connections open on the server in every mode:
  a slot is freed only when the server has closed the socket after `COM_QUIT`, or 500 ms after an
  aborted connection (truncated result, timeout), which the client cannot observe.
- Connections refused with 1226 `ER_USER_LIMIT_REACHED` or 1040 `ER_CON_COUNT_ERROR` (limits reached
  by other clients) are retried 3 times (200/400/800 ms plus jitter, within `QUERY_TIMEOUT`), also at
  startup; then the tool fails with a message that explains the limit and suggests lowering
  `POOL_MAX` (no account name or address).
- `schema_describe_table` and `schema_list_columns` returned `"defaultValue": "NULL"` on MariaDB
  10.2.7+, whose `information_schema.COLUMNS.COLUMN_DEFAULT` holds the word `NULL` for no default;
  it is now a JSON `null`, as on MySQL. MariaDB string defaults keep their quotes (`'abc'`), which
  tells them apart from expressions such as `current_timestamp()`.
- With `POOL_MAX=1` every tool works: no code holds a connection while waiting for another, and the
  `KILL QUERY` after a client-side timeout is skipped (the server-side statement timeout ends the
  statement) instead of waiting for a second connection.

### Changed
- `POOL_MAX` defaults to `3` (was `10`); raise it if the database account allows more connections.
- `MAX_RESULT_BYTES` defaults to 1 MiB (`1048576`, was 10 MiB); range unchanged (`1024`..`104857600`).
- `schema_describe_table`, `monitor_connections` and `monitor_database_size` run their queries one
  after the other instead of all at once (one connection at a time, predictable order).

## [1.0.1] - 2026-11-02

### Fixed
- Docker Hub publish workflow read `DOCKERHUB_USERNAME` as a secret; it is a repository variable.

### Changed
- First release built and published by the pipeline (npm Trusted Publishing with provenance, and the
  multi-arch Docker image). 1.0.0 was published manually.

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

[1.0.2]: https://github.com/abelmferreira/mcp-mysql/releases/tag/v1.0.2
[1.0.1]: https://github.com/abelmferreira/mcp-mysql/releases/tag/v1.0.1
[1.0.0]: https://github.com/abelmferreira/mcp-mysql/releases/tag/v1.0.0
