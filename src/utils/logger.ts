import { config } from '../config.js';

/**
 * Log levels
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log level priority (higher = more severe)
 */
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Log entry structure
 */
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Keys that should be redacted from logs
 */
const SENSITIVE_KEYS = [
  'password',
  'secret',
  'token',
  'key',
  'credential',
  'auth',
  'apikey',
  'api_key',
];

/**
 * Sanitize data by removing sensitive information
 */
function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();

    // Check if key contains sensitive words
    if (SENSITIVE_KEYS.some((sk) => lowerKey.includes(sk))) {
      sanitized[key] = '***REDACTED***';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Recursively sanitize nested objects
      sanitized[key] = sanitizeData(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Log a message with optional data
 *
 * IMPORTANT: Uses console.error to avoid interfering with stdio transport
 */
export function log(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>
): void {
  // Check if we should log based on configured level
  if (LOG_LEVELS[level] < LOG_LEVELS[config.LOG_LEVEL]) {
    return;
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };

  // Add sanitized data if provided
  if (data) {
    entry.data = sanitizeData(data);
  }

  // Output to stderr (NEVER stdout - it's used for MCP protocol)
  console.error(JSON.stringify(entry));
}

/**
 * Convenience methods for each log level
 */
export const logger = {
  debug: (message: string, data?: Record<string, unknown>) => log('debug', message, data),
  info: (message: string, data?: Record<string, unknown>) => log('info', message, data),
  warn: (message: string, data?: Record<string, unknown>) => log('warn', message, data),
  error: (message: string, data?: Record<string, unknown>) => log('error', message, data),
};
