const NEW_PREFIX = 'AGENTDOCK_';
const LEGACY_PREFIX = 'HAPPYCLAW_';

export function applyAgentDockEnvAliases(
  env: NodeJS.ProcessEnv | Record<string, string>,
): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith(NEW_PREFIX)) {
      const legacyKey = `${LEGACY_PREFIX}${key.slice(NEW_PREFIX.length)}`;
      if (env[legacyKey] === undefined) env[legacyKey] = value;
    } else if (key.startsWith(LEGACY_PREFIX)) {
      const newKey = `${NEW_PREFIX}${key.slice(LEGACY_PREFIX.length)}`;
      if (env[newKey] === undefined) env[newKey] = value;
    }
  }
}

applyAgentDockEnvAliases(process.env);
