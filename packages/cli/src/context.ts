export function parseContextArgs(rawArgs: string[]): Record<string, unknown> {
  const context: Record<string, unknown> = {};

  for (const arg of rawArgs) {
    const match = arg.match(/^--context\.([a-zA-Z0-9_.-]+)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2];
    setNested(context, key, parseValue(rawValue));
  }

  return context;
}

function parseValue(raw: string): unknown {
  if (raw === '') return '';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw === 'undefined') return undefined;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function setNested(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let target: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in target) || typeof target[part] !== 'object' || target[part] === null) {
      target[part] = {};
    }
    target = target[part] as Record<string, unknown>;
  }

  target[parts[parts.length - 1]] = value;
}
