/**
 * Pure utility functions for AgentDock agent runners.
 */

/** Shorten a string to maxLen, appending "..." if truncated. */
export function shorten(input: string, maxLen = 180): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, maxLen)}...`;
}

/** Recursively redact sensitive fields from an object. */
export function redactSensitive(input: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (input == null) return input;
  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') return input;
  if (Array.isArray(input)) {
    return input.slice(0, 10).map((item) => redactSensitive(item, depth + 1));
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/(token|password|secret|api[_-]?key|authorization|cookie)/iu.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitive(v, depth + 1);
      }
    }
    return out;
  }
  return '[unsupported]';
}

/** Summarize tool input for display in stream events. */
export function summarizeToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') return shorten(input.trim());
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    for (const key of ['command', 'query', 'path', 'pattern', 'prompt', 'url', 'name']) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return `${key}: ${shorten(value.trim())}`;
    }
    try {
      const json = JSON.stringify(redactSensitive(obj));
      if (!json || json === '{}' || json === '[]') return undefined;
      return shorten(json);
    } catch { return undefined; }
  }
  return undefined;
}

/** Sanitize a string for use as a filename. */
export function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/** Generate a fallback conversation archive filename. */
export function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}
