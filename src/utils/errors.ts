/**
 * Base error class for MCP MySQL
 */
export class McpError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Error thrown when query validation fails
 */
export class QueryValidationError extends McpError {
  public readonly queryType?: string;

  constructor(message: string, queryType?: string) {
    super(message, 'QUERY_VALIDATION_ERROR');
    this.name = 'QueryValidationError';
    this.queryType = queryType;
  }
}

/**
 * Error thrown when READONLY mode is violated
 */
export class ReadOnlyViolationError extends McpError {
  public readonly operation: string;

  /**
   * @param operation The blocked operation, e.g. "INSERT"
   */
  constructor(operation: string) {
    super(
      `Operation blocked in READONLY mode: ${operation} is not allowed. ` +
        'Only read queries are permitted; set READONLY=false to enable the write tools.',
      'READONLY_VIOLATION'
    );
    this.name = 'ReadOnlyViolationError';
    this.operation = operation;
  }
}

/**
 * Error thrown when database connection fails
 */
export class ConnectionError extends McpError {
  constructor(message: string) {
    super(message, 'CONNECTION_ERROR');
    this.name = 'ConnectionError';
  }
}

/**
 * Error thrown when query times out
 */
export class TimeoutError extends McpError {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Query timed out after ${timeoutMs}ms. Consider optimizing your query or increasing the timeout.`,
      'TIMEOUT_ERROR'
    );
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error thrown when required parameters are missing
 */
export class MissingParameterError extends McpError {
  public readonly parameterName: string;

  constructor(parameterName: string) {
    super(`Required parameter "${parameterName}" is missing`, 'MISSING_PARAMETER');
    this.name = 'MissingParameterError';
    this.parameterName = parameterName;
  }
}

/**
 * Error thrown for invalid SQL operations
 */
export class InvalidOperationError extends McpError {
  constructor(message: string) {
    super(message, 'INVALID_OPERATION');
    this.name = 'InvalidOperationError';
  }
}

/**
 * Error thrown when the database session cannot be put in a safe state
 * (sql_mode, statement timeout). The query is not run.
 */
export class UnsafeSessionError extends McpError {
  constructor(message: string) {
    super(message, 'UNSAFE_SESSION');
    this.name = 'UnsafeSessionError';
  }
}

/**
 * Shape of the errors raised by mysql2 for server errors
 */
interface DriverError {
  errno?: number;
  code?: string;
  sqlMessage?: string;
}

/** Server error numbers meaning "statement timeout / interrupted" */
export const TIMEOUT_ERRNOS = new Set([
  1969, // MariaDB ER_STATEMENT_TIMEOUT (max_statement_time)
  3024, // MySQL ER_QUERY_TIMEOUT (max_execution_time)
  1317, // ER_QUERY_INTERRUPTED (KILL QUERY, used by the client-side timeout)
]);

/** Client-side error codes meaning "timeout" */
const TIMEOUT_CODES = new Set(['PROTOCOL_SEQUENCE_TIMEOUT', 'ETIMEDOUT']);

/**
 * Server error numbers meaning "no privilege" or "object does not exist":
 * optional parts of a tool are skipped with a warning when they fail this way.
 */
export const OPTIONAL_FEATURE_ERRNOS = new Set([
  1044, // ER_DBACCESS_DENIED_ERROR
  1142, // ER_TABLEACCESS_DENIED_ERROR
  1143, // ER_COLUMNACCESS_DENIED_ERROR
  1227, // ER_SPECIFIC_ACCESS_DENIED_ERROR (PROCESS, ...)
  1049, // ER_BAD_DB_ERROR (no sys schema)
  1146, // ER_NO_SUCH_TABLE
  1109, // ER_UNKNOWN_TABLE (information_schema table missing in this version)
  1356, // ER_VIEW_INVALID (sys view whose base tables are not readable)
  1054, // ER_BAD_FIELD_ERROR (column missing in this version)
  1305, // ER_SP_DOES_NOT_EXIST (sys function missing)
  1370, // ER_PROCACCESS_DENIED_ERROR (sys function not executable)
]);

/**
 * Server errno of a driver error, if any
 */
export function getErrno(error: unknown): number | undefined {
  if (error && typeof error === 'object' && typeof (error as DriverError).errno === 'number') {
    return (error as DriverError).errno;
  }
  return undefined;
}

/**
 * Is this a timeout (server statement timeout, KILL QUERY or client timeout)?
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  const errno = getErrno(error);
  if (errno !== undefined && TIMEOUT_ERRNOS.has(errno)) return true;
  const code = error && typeof error === 'object' ? (error as DriverError).code : undefined;
  return typeof code === 'string' && TIMEOUT_CODES.has(code);
}

/**
 * Is this a missing privilege / missing object error (optional feature unavailable)?
 */
export function isOptionalFeatureError(error: unknown): boolean {
  const errno = getErrno(error);
  return errno !== undefined && OPTIONAL_FEATURE_ERRNOS.has(errno);
}

/**
 * Remove account names, passwords and IP addresses from a message, so they are
 * not handed to the MCP client (an LLM).
 */
export function redactSensitive(message: string): string {
  return (
    message
      // 'user'@'host' (Access denied for user 'x'@'host', SELECT command denied to user ...)
      .replace(/'[^']*'@'[^']*'/g, "'***'@'***'")
      .replace(/Login failed for user '[^']*'/g, "Login failed for user '***'")
      .replace(/password[^,]*/gi, 'password=***')
      // IPv4, optionally with :port
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<host>')
      // DNS failures name the host
      .replace(/\b(ENOTFOUND|EAI_AGAIN)\s+\S+/g, '$1 <host>')
  );
}

/**
 * Get a user-friendly error message from an error.
 * Database errors are reported as "MySQL error <errno> (<code>): <message>",
 * without account names or addresses.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof McpError) {
    return redactSensitive(error.message);
  }

  if (error instanceof Error) {
    const driver = error as DriverError;
    if (typeof driver.errno === 'number' && driver.sqlMessage) {
      return redactSensitive(`MySQL error ${driver.errno} (${driver.code ?? 'UNKNOWN'}): ${driver.sqlMessage}`);
    }
    return redactSensitive(error.message);
  }

  return 'An unknown error occurred';
}
