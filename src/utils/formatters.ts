import type { ToolResponse, ToolContent } from '../types.js';
import { getErrorMessage } from './errors.js';

/**
 * Format a successful tool response
 */
export function formatSuccess(data: unknown): ToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * Format an error tool response
 */
export function formatError(error: unknown): ToolResponse {
  const message = getErrorMessage(error);

  return {
    content: [
      {
        type: 'text',
        text: `Error: ${message}`,
      },
    ],
    isError: true,
  };
}

/**
 * Truncate a string to a maximum length
 */
export function truncate(str: string, maxLength: number = 500): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Format duration in milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }

  return `${seconds}s`;
}

/**
 * Format a number with thousands separator
 */
export function formatNumber(num: number): string {
  return num.toLocaleString('en-US');
}

/**
 * Create a tool content array from text
 */
export function textContent(text: string): ToolContent[] {
  return [{ type: 'text', text }];
}

/**
 * Create a tool content array from JSON data
 */
export function jsonContent(data: unknown): ToolContent[] {
  return [{ type: 'text', text: JSON.stringify(data, null, 2) }];
}
