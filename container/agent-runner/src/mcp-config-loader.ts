import fs from 'node:fs';

function splitTomlItems(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (const char of value) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === '[' || char === '{') {
      depth += 1;
      current += char;
    } else if (char === ']' || char === '}') {
      depth -= 1;
      current += char;
    } else if (char === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return splitTomlItems(trimmed.slice(1, -1)).map(parseTomlValue);
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const result: Record<string, unknown> = {};
    for (const item of splitTomlItems(trimmed.slice(1, -1))) {
      const separator = item.indexOf('=');
      if (separator < 0) continue;
      const key = item
        .slice(0, separator)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      result[key] = parseTomlValue(item.slice(separator + 1));
    }
    return result;
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

export function readMcpServersFromCodexToml(
  filePath: string,
): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const servers: Record<string, Record<string, unknown>> = {};
    let current: { server: Record<string, unknown>; childKey?: string } | null =
      null;
    for (const rawLine of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const section = line.match(
        /^\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^\].]+))(?:\.([^\]]+))?\]$/,
      );
      if (section) {
        const name = section[1] || section[2] || section[3];
        const childKey = section[4]?.replace(/^['"]|['"]$/g, '');
        const server = servers[name] || (servers[name] = {});
        current = { server, childKey };
        if (childKey && !server[childKey]) server[childKey] = {};
        continue;
      }
      if (!current) continue;
      const separator = line.indexOf('=');
      if (separator < 0) continue;
      const key = line
        .slice(0, separator)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      const value = parseTomlValue(line.slice(separator + 1));
      if (current.childKey) {
        (current.server[current.childKey] as Record<string, unknown>)[key] =
          value;
      } else {
        current.server[key] = value;
      }
    }
    return servers;
  } catch {
    return {};
  }
}
