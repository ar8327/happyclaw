const NEW_PREFIX = 'AGENTDOCK_';
const LEGACY_PREFIX = 'HAPPYCLAW_';

for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined) continue;
  if (key.startsWith(NEW_PREFIX)) {
    const legacyKey = `${LEGACY_PREFIX}${key.slice(NEW_PREFIX.length)}`;
    if (process.env[legacyKey] === undefined) process.env[legacyKey] = value;
  } else if (key.startsWith(LEGACY_PREFIX)) {
    const newKey = `${NEW_PREFIX}${key.slice(LEGACY_PREFIX.length)}`;
    if (process.env[newKey] === undefined) process.env[newKey] = value;
  }
}
