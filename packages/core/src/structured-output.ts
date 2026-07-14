import { safeJsonParse, extractBalancedJson } from './json-utils.js';

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function tryParseStructured(
  structured: unknown,
): Record<string, unknown> | undefined {
  if (isObject(structured)) {
    return structured;
  }
  if (typeof structured === 'string') {
    const parsed = safeJsonParse(structured.trim());
    if (isObject(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function tryParseStructuredFromText(
  text: string,
): Record<string, unknown> | undefined {
  // 1. Try a markdown JSON block.
  const blockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (blockMatch) {
    const parsed = safeJsonParse(blockMatch[1].trim());
    if (isObject(parsed)) return parsed;
  }

  // 2. Find the first balanced JSON object in the text.
  const balanced = extractBalancedJson(text);
  if (balanced) {
    const parsed = safeJsonParse(balanced);
    if (isObject(parsed)) return parsed;
  }

  // 3. Fallback: parse the whole string.
  const parsed = safeJsonParse(text.trim());
  if (isObject(parsed)) return parsed;

  return undefined;
}
