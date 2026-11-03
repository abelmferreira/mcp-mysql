# MCP MySQL

[![npm version](https://img.shields.io/npm/v/%40abelmferreira%2Fmcp-mysql)](https://www.npmjs.com/package/@abelmferreira/mcp-mysql)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.12-green.svg)](https://nodejs.org/)

A Model Context Protocol (MCP) server for **MySQL and MariaDB**. Query, monitor and analyze your databases directly from Claude Code (or any MCP client), read-only by default, with an optional built-in SSH tunnel.

It is a MySQL/MariaDB port of [`@fabriciofs/mcp-postgres`](https://github.com/fabriciofs/mcp-postgres): same tool surface and `READONLY` safety model, with all SQL rewritten for MySQL (`information_schema`, `performance_schema` and the `sys` schema).

## Features

- **Query execution** - `SELECT` / `WITH` / `EXPLAIN` / `DESCRIBE` / read-only `SHOW` with named `@param` placeholders (rendered as escaped literals by the server itself, then validated as a whole).
- **Schema exploration** - tables, views, columns, indexes, stored procedures, full table description.
- **Monitoring** - active queries, connections, InnoDB lock waits, wait stats, database size, performance counters.
- **Performance analysis** - index suggestions, unused/redundant indexes, fragmentation, statistics freshness, `EXPLAIN` plans.
- **Read-only by design** - several independent layers of protection (see [Security](#security)).
- **Built-in SSH tunnel** - reach a database behind a bastion host with nothing but environment variables; the host key is always pinned.
- **Write operations** (`INSERT` / `UPDATE` / `DELETE`) only when explicitly enabled with `READONLY=false`.

## Requirements

- Node.js **>= 20.12** (only for the `npx` usage), or Docker.
- MySQL 8.0+ or MariaDB 10.5+ recommended. Some monitoring/analysis tools rely on `performance_schema` and the `sys` schema.

## Quick start

The recommended way is `npx`, configured in your MCP client. For Claude Code, add it to `.mcp.json` in your project (or use `claude mcp add`). Every setting is an environment variable, passed in the `env` block.

### 1. Direct connection

```json
{
  "mcpServers": {
    "mydb": {
      "command": "npx",
      "args": ["-y", "@abelmferreira/mcp-mysql"],
      "env": {
        "SQL_CONNECTION_URL": "mysql://readonly_user:password@db.example.com:3306/mydb",
        "READONLY": "true"
      }
    }
  }
}
```

Or with individual parameters instead of the URL:

```json
"env": {
  "SQL_SERVER": "db.example.com",
  "SQL_PORT": "3306",
  "SQL_DATABASE": "mydb",
  "SQL_USER": "readonly_user",
  "SQL_PASSWORD": "password",
  "READONLY": "true"
}
```

### 2. Through an SSH tunnel (environment variables only)

When `SSH_HOST` is set the server opens the tunnel itself (an in-process `ssh -L` on a random `127.0.0.1` port). No `ssh` binary, helper script or Docker is needed. `SQL_SERVER:SQL_PORT` is the database address **as seen from the SSH host**.

```json
{
  "mcpServers": {
    "mydb": {
      "command": "npx",
      "args": ["-y", "@abelmferreira/mcp-mysql"],
      "env": {
        "SQL_SERVER": "192.0.2.10",
        "SQL_PORT": "3306",
        "SQL_DATABASE": "mydb",
        "SQL_USER": "readonly_user",
        "SQL_PASSWORD": "password",
        "READONLY": "true",
        "SSH_HOST": "bastion.example.com",
        "SSH_USER": "tunnel",
        "SSH_KEY_PATH": "~/.ssh/mcp_tunnel_key",
        "SSH_HOST_FINGERPRINT": "SHA256:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

- `SSH_KEY_PATH` is a path on the machine running the MCP server. `~` is expanded; relative paths are resolved against the working directory chosen by the MCP client, so prefer absolute or `~/` paths.
- Encrypted keys need `SSH_KEY_PASSPHRASE`. A dedicated key without passphrase, restricted on the server (see below), is usually simpler.
- `SSH_HOST_FINGERPRINT` is mandatory: the host key is always verified and there is no "trust on first use". Get it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server, or `ssh-keyscan bastion.example.com | ssh-keygen -lf -` (and confirm it through another channel). A comma separated list is accepted (one per host key algorithm).
- The SSH session is opened at startup, so a bad key, host or fingerprint fails fast with a clear message on stderr. It is re-established automatically if it drops.

**Restrict the tunnel key on the SSH server.** In `~/.ssh/authorized_keys` of the tunnel user:

```
restrict,port-forwarding,permitopen="192.0.2.10:3306",command="/usr/sbin/nologin" ssh-ed25519 AAAA... mcp-tunnel
```

`restrict` disables everything (PTY, agent/X11 forwarding, user rc), `port-forwarding` re-enables only local forwarding, and `permitopen` limits it to the database address. `restrict` alone does **not** stop the key from running commands or opening a shell, so `command="/usr/sbin/nologin"` is needed to make it useless for anything but the tunnel.

### 3. Pointing to a project `.env` file (`ENV_FILE`)

Keep the configuration in a `.env` file of your project (git-ignored) and point the server at it:

```json
{
  "mcpServers": {
    "mydb": {
      "command": "npx",
      "args": ["-y", "@abelmferreira/mcp-mysql"],
      "env": {
        "ENV_FILE": "/path/to/project/.env"
      }
    }
  }
}
```

- The file uses the usual dotenv syntax (`KEY=value`, `# comments`, quotes) and may contain any variable from the [table below](#environment-variables), including `SSH_*`.
- Variables set in the `env` block **win** over the file (same precedence as `node --env-file`), so you can share one file and override, for example, `READONLY` per client.
- `~` is expanded; relative paths are resolved against the working directory of the server process.
- A missing or unreadable file stops the server with an error on stderr (exit code 1). Values are never logged.

### 4. Docker

A public image is available on Docker Hub as `abelmferreira/mcp-mysql`. The server speaks MCP over stdio, so run it with `-i` and without `-t`:

```json
{
  "mcpServers": {
    "mydb": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/path/to/project/.env",
        "abelmferreira/mcp-mysql"
      ]
    }
  }
}
```

With the SSH tunnel, mount the key read-only and point `SSH_KEY_PATH` at the path **inside** the container:

```json
"args": [
  "run", "-i", "--rm",
  "--env-file", "/path/to/project/.env",
  "-e", "SSH_KEY_PATH=/run/secrets/ssh_key",
  "-v", "/home/me/.ssh/mcp_tunnel_key:/run/secrets/ssh_key:ro",
  "abelmferreira/mcp-mysql"
]
```

Notes for Docker:

- `--env-file` is read by Docker itself, so use it instead of `ENV_FILE` (the container cannot see host paths unless you mount them). Docker's `--env-file` does not strip quotes: write `KEY=value`, not `KEY="value"`.
- If the database runs on the Docker host, use `host.docker.internal` (add `--add-host=host.docker.internal:host-gateway` on Linux) instead of `localhost`.
- The SSH tunnel listens on `127.0.0.1` inside the container only.

## Environment variables

| Variable | Required | Default | Description |
| -------- | -------- | ------- | ----------- |
| `ENV_FILE` | no | - | Path of a dotenv file to load first. Variables already in the environment win. `~` and relative paths are supported |
| `SQL_CONNECTION_URL` | no\* | - | `mysql://user:pass@host:port/database?ssl=true` (`mariadb://` also accepted; URL-encode special characters in the password) |
| `SQL_SERVER` | no\* | - | Database host (as seen from the SSH host when the tunnel is enabled) |
| `SQL_DATABASE` | no\* | - | Database name |
| `SQL_USER` | no\* | - | Username |
| `SQL_PASSWORD` | no\* | - | Password |
| `SQL_PORT` | no | `3306` | Port |
| `SQL_SSL` | no | `false` | Enable TLS to the database. The server certificate **is verified** (see [TLS](#tls)) |
| `SQL_SSL_CA` | no | - | PEM file of the CA that signed the database certificate (`~` supported). Without it the system CA store is used |
| `SQL_SSL_REJECT_UNAUTHORIZED` | no | `true` | `false` disables certificate verification (not recommended; a warning is logged) |
| `READONLY` | **yes** | - | `true` (read-only, recommended) or `false` (enables write tools) |
| `QUERY_TIMEOUT` | no | `30000` | Statement timeout in ms (max `120000`), enforced by the server and by the client |
| `MAX_ROWS` | no | `1000` | Max rows returned per query (max `5000`); caps the `maxRows` argument of the tools |
| `MAX_RESULT_BYTES` | no | `1048576` (1 MiB) | Max size of one query result (approximate, in bytes; `1024`..`104857600`). Larger results are cut and flagged `truncated` |
| `POOL_MAX` | no | `3` | Maximum connections open on the database at the same time (`1`..`50`); further queries wait in a FIFO queue. Keep it below the account's `max_user_connections` (leave room for its other clients); raise it if the account allows more. `POOL_MIN` is no longer used and is ignored |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` (logs go to stderr) |
| `SSH_HOST` | no | - | Enables the built-in SSH tunnel |
| `SSH_PORT` | no | `22` | SSH port |
| `SSH_USER` | with `SSH_HOST` | - | SSH user |
| `SSH_KEY_PATH` | with `SSH_HOST` | - | Private key path (`~` supported; inside the container when using Docker) |
| `SSH_KEY_PASSPHRASE` | no | - | Passphrase of an encrypted key |
| `SSH_HOST_FINGERPRINT` | with `SSH_HOST` | - | Pinned host key fingerprint(s), `SHA256:...`, comma separated |

\* Provide either `SQL_CONNECTION_URL` **or** `SQL_SERVER`, `SQL_DATABASE`, `SQL_USER` and `SQL_PASSWORD`. When the URL is set it takes precedence. See [`.env.example`](.env.example) for a commented template.

## Security

The server is meant to be driven by an AI assistant, which can be manipulated by the content it reads (prompt injection). Read-only access is therefore enforced by several independent layers. **The first one is the real boundary**; the others are defence in depth and must not be relied upon alone.

### 1. A database account that can only read (the real boundary)

Create a dedicated user with `SELECT` only, on the databases it needs:

```sql
CREATE USER 'mcp_readonly'@'%' IDENTIFIED BY 'a-strong-password';
GRANT SELECT ON mydb.* TO 'mcp_readonly'@'%';
-- optional, for the monitor/analyze tools:
GRANT SELECT ON performance_schema.* TO 'mcp_readonly'@'%';
GRANT SELECT ON sys.* TO 'mcp_readonly'@'%';
```

- Restrict the host part (`'%'`) to where the server connects from (for example the SSH host).
- **Do not grant `FILE`** (`LOAD_FILE()`, `INTO OUTFILE`), `PROCESS` (it shows the text of every running query, including other users' literals), `SUPER` or any admin privilege, and no `EXECUTE` on routines that write. Do not grant `SELECT` on the `mysql` schema (credential hashes) nor on tables holding secrets you do not want an AI assistant to read.
- Without `PROCESS`/`performance_schema` privileges the monitor and analyze tools still work, with less information and an explicit `warnings` entry.
- User-defined functions (UDFs, e.g. `sys_exec` from lib_mysqludf_sys) and stored functions can do anything; a keyword list cannot know them. Only the GRANT can stop them.

### 2. Query validator (`READONLY=true`)

A lexer that mirrors the MySQL/MariaDB one splits the query into tokens (string literals, `` `quoted identifiers` ``, comments, variables, words). The same lexer is used to bind `@param` placeholders, so the validator checks **the exact text sent to the server**. It accepts exactly one statement starting with `SELECT`, `WITH`, `EXPLAIN`/`DESCRIBE`/`DESC`, `TABLE`, `VALUES`, `(SELECT ...)`, or one of these `SHOW` forms: `SHOW [FULL] TABLES`, `SHOW [FULL] COLUMNS`, `SHOW INDEX`, `SHOW TABLE STATUS`, `SHOW CREATE TABLE`/`VIEW`, `SHOW [GLOBAL|SESSION] STATUS`/`VARIABLES`, `SHOW DATABASES`. It rejects:

- multiple statements, executable comments (`/*! ... */`, `/*M! ... */`) and optimizer hints (`/*+ ... */`, which could override the statement timeout or the sql_mode);
- non-ASCII or control characters outside string literals, quoted identifiers and comments (use backticks for non-ASCII identifiers), and NUL characters anywhere;
- reserved write/DDL keywords anywhere (`INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, `ALTER`, `RENAME`, `GRANT`, `REVOKE`, `CALL`, `LOAD`, `LOCK`, `UNLOCK`), `INTO` (`OUTFILE`, `DUMPFILE`, `@var`), locking clauses (`FOR UPDATE`, `FOR SHARE`, `LOCK IN SHARE MODE`) and `EXPLAIN ... FOR CONNECTION`;
- side-effect, blocking or state-changing functions: `SLEEP`, `BENCHMARK`, `LOAD_FILE`, `GET_LOCK`, `RELEASE_LOCK`, `RELEASE_ALL_LOCKS`, the locking service functions, replication waits (`MASTER_POS_WAIT`, `SOURCE_POS_WAIT`, `MASTER_GTID_WAIT`, `WAIT_FOR_EXECUTED_GTID_SET`, ...), MariaDB sequences (`NEXTVAL`, `SETVAL`, `NEXT VALUE FOR`), `GROUP_REPLICATION_*`, `ASYNCHRONOUS_CONNECTION_FAILOVER_*` and the well-known `sys_exec`/`sys_eval` UDFs;
- user variables (`@x`, `` @`x` ``, `@x := ...`): only `@name` placeholders that have a value in `params` are accepted, `@@system_variables` can be read. Positional `?` placeholders are not supported;
- credential objects, best effort: `mysql.user`, `mysql.global_priv`, `authentication_string`, `slave_master_info`.

Statement-only keywords that are not reserved (`HANDLER`, `RESET`, `FLUSH`, `KILL`, `EXECUTE`, `PREPARE`, `SHUTDOWN`, `TRUNCATE`, ...) can be used as column names, and a reserved word right after a dot (`t.delete`) is an identifier, as it is for the server.

### 3. Read-only, short-lived sessions

With `READONLY=true` each query runs on its own connection:

- the session `sql_mode` is checked first. `NO_BACKSLASH_ESCAPES` and `ANSI_QUOTES` (and the combination modes that imply it: `ANSI`, `ORACLE`, `DB2`, `MSSQL`, `POSTGRESQL`, `MAXDB`) change how string literals are read, which the validator and the parameter escaping rely on: they are removed from the session `sql_mode` (no privilege needed); if that does not stick, the query is refused;
- a server-side statement timeout is set (`max_statement_time` on MariaDB, `max_execution_time` on MySQL). If neither can be set, the query is refused. A client-side timer (`QUERY_TIMEOUT` + 1 s) also aborts the query, with a `KILL QUERY` on another connection (an account can always kill its own threads; skipped with `POOL_MAX=1`, where the server-side timeout ends the statement);
- the statement runs inside `START TRANSACTION READ ONLY`, so even a `SELECT f()` where `f` writes is refused by the database;
- rows are streamed and reading stops at `maxRows` (capped by `MAX_ROWS`) or `MAX_RESULT_BYTES`; the connection is then dropped, so a huge result never fills the memory of the process;
- the connection is closed afterwards and never reused, so no session state survives a query (user-level locks, user variables, `LAST_INSERT_ID(x)`, temporary tables). This costs one new connection per query (through the SSH tunnel: a new forwarded channel on the same SSH session).

### Connection limits

The server never has more than `POOL_MAX` connections open from this process, in both modes: further queries wait in a FIFO queue. A slot is freed only when the server has really dropped the connection (the socket closed after `COM_QUIT`; after an aborted result or a timeout, 500 ms later, since the client cannot observe it), so a closing connection and its replacement are never counted together against `max_user_connections`. With `POOL_MAX=1` every tool still works (the tools run their queries one after the other).

When the server still refuses a connection because a limit is reached by other clients (`1226 ER_USER_LIMIT_REACHED` for the account's `max_user_connections`, `1040 ER_CON_COUNT_ERROR` for the server's `max_connections`), the connection is retried 3 times (200/400/800 ms plus jitter, within `QUERY_TIMEOUT`); then the tool fails with a message that explains the limit and suggests lowering `POOL_MAX`.

### TLS

With `SQL_SSL=true` the database certificate is verified against the system CA store or `SQL_SSL_CA`. On direct connections the host name is verified too; through the SSH tunnel the driver connects to `127.0.0.1`, so only the certificate chain is verified (the tunnel itself is authenticated by the pinned host key). `SQL_SSL_REJECT_UNAUTHORIZED=false` disables verification (a warning is logged). The URL form accepts `?ssl=true`.

### Other measures

The SSH host key is always verified against `SSH_HOST_FINGERPRINT` (format checked at startup; on mismatch the received fingerprint is logged to stderr so it can be compared), the tunnel listens on `127.0.0.1` only, passwords are redacted from logs, logs carry a short hash of the query instead of its text, errors returned to the client do not contain account names or IP addresses, and nothing but MCP protocol messages is written to stdout.

### Known limitations

- The validator is a blocklist on top of an allowlist of statement types: it cannot know UDFs or stored functions, and it is not a substitute for the GRANT.
- MySQL's `max_execution_time` only applies to `SELECT`; `SHOW`/`EXPLAIN` are bounded by the client-side timer.
- `MAX_RESULT_BYTES` (1 MiB by default) is approximate, and a single row can still be as large as the server's `max_allowed_packet`.
- Keep `READONLY=true` unless you really need the write tools: with `READONLY=false` none of the checks above applies to `sql_execute` (only the `sql_mode` check, which keeps parameter escaping correct).

## Available tools

| Category | Tools |
| -------- | ----- |
| Query | `sql_execute` |
| Schema | `schema_list_tables`, `schema_list_columns`, `schema_describe_table`, `schema_list_indexes`, `schema_list_procedures` |
| Monitor | `monitor_active_queries`, `monitor_connections`, `monitor_blocking`, `monitor_wait_stats`, `monitor_database_size`, `monitor_performance_counters` |
| Analyze | `analyze_query`, `analyze_suggest_indexes`, `analyze_unused_indexes`, `analyze_duplicate_indexes`, `analyze_fragmentation`, `analyze_statistics` |
| Write\* | `sql_insert`, `sql_update`, `sql_delete` |

\* Only registered when `READONLY=false`.

In MySQL "schema" and "database" are synonyms: the `schema` argument of the tools is a database name and defaults to the connected database.

Notes on the tools:

- `sql_execute` returns `rows`, `rowCount` (rows returned), `fields`, `duration` and `truncated`; when `truncated` is `true` there were more rows (or more data) than returned.
- `analyze_query` only accepts `SELECT`/`WITH` queries. Digest statistics need MySQL 8 with `performance_schema` (`STATEMENT_DIGEST()`); on MariaDB only the plan is returned.
- Tools based on `performance_schema` or the `sys` schema (`monitor_wait_stats`, `analyze_suggest_indexes`, `analyze_unused_indexes`, the usage counters of `schema_list_indexes`, digest statistics) return an explicit warning when `performance_schema` is disabled (the MariaDB default) or not readable, instead of an empty result. `monitor_performance_counters` uses `SHOW GLOBAL STATUS` and works everywhere.
- Arguments removed because MySQL has no data for them: `minImpact` (`analyze_suggest_indexes`), `minSizeMB`/`minAgeDays` (`analyze_unused_indexes`), `minRowsChanged` (`analyze_statistics`). `analyze_fragmentation` `minPageCount` now filters by table size in InnoDB pages (default `0`).

## Development

Clone the repository, then use Docker so nothing has to be installed on the host:

```bash
git clone https://github.com/abelmferreira/mcp-mysql.git
cd mcp-mysql

# Typecheck + unit tests (no database needed)
docker build --target test .

# Or interactively
docker run --rm -v "$PWD":/app -w /app node:22-alpine \
  sh -c 'npm ci && npm run typecheck && npm test && npm run build'

# Local image
docker build -t mcp-mysql:local .
```

A throwaway MySQL for manual testing is available in `docker-compose.yml`:

```bash
cp .env.example .env      # adjust; SQL_SERVER is overridden to the compose service
docker compose up -d mysql
docker compose run --rm mcp-mysql
```

With Node.js >= 20.12 on the host the usual scripts work too: `npm ci`, `npm run build`, `npm test`, `npm start` (reads `./.env`), `npm run inspector` (MCP Inspector).

## Acknowledgements

This project is a port to MySQL/MariaDB of [**mcp-postgres**](https://github.com/fabriciofs/mcp-postgres) ([`@fabriciofs/mcp-postgres`](https://www.npmjs.com/package/@fabriciofs/mcp-postgres)) by **fabriciofs**, released under the MIT License. The tool set, the `READONLY` model and the overall structure come from it; the SQL, the validator, the read-only transaction and the SSH tunnel were rewritten or added for MySQL/MariaDB.

## License

[MIT](LICENSE). Copyright (c) 2024 fabriciofs (original work) and (c) 2026 Abel Ferreira (MySQL/MariaDB port).
