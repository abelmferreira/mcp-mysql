import { getErrorMessage, isOptionalFeatureError } from '../utils/errors.js';

/**
 * Run an optional part of a tool. When it fails because of a missing
 * privilege or a missing object (sys schema, performance_schema table, column
 * of another server version), a warning is recorded and `null` is returned,
 * so the tool can still answer with what it has. Other errors are rethrown.
 */
export async function optional<T>(warnings: string[], label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (isOptionalFeatureError(error)) {
      warnings.push(`${label} unavailable (missing privilege or object): ${getErrorMessage(error)}`);
      return null;
    }
    throw error;
  }
}

/** Add `warnings` to a response object only when there is any */
export function withWarnings<T extends object>(data: T, warnings: string[]): T & { warnings?: string[] } {
  return warnings.length > 0 ? { ...data, warnings } : data;
}
