import { getPrimarySessionForOwner } from './db.js';
import { getDefaultRunnerId } from './runner-registry.js';
import type { SessionRecord } from './types.js';

export function getInheritedWorkspaceRuntimeConfig(
  ownerKey: string,
): Pick<
  SessionRecord,
  | 'runner_id'
  | 'runner_profile_id'
  | 'model'
  | 'thinking_effort'
  | 'context_compression'
> {
  const primarySession = getPrimarySessionForOwner(ownerKey);
  return {
    runner_id: primarySession?.runner_id || getDefaultRunnerId(),
    runner_profile_id: primarySession?.runner_profile_id ?? null,
    model: primarySession?.model ?? null,
    thinking_effort: primarySession?.thinking_effort ?? null,
    context_compression: primarySession?.context_compression ?? 'off',
  };
}
