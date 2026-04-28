const WORKER_SESSION_PREFIX = 'worker:';
const WORKER_CHAT_SEPARATOR = '#agent:';

export function buildWorkerSessionId(agentId: string): string {
  return `${WORKER_SESSION_PREFIX}${agentId}`;
}

export function isWorkerSessionId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(WORKER_SESSION_PREFIX);
}

export function extractAgentIdFromWorkerSessionId(
  sessionId: string | null | undefined,
): string | null {
  if (typeof sessionId !== 'string' || !isWorkerSessionId(sessionId)) return null;
  const agentId = sessionId.slice(WORKER_SESSION_PREFIX.length).trim();
  return agentId || null;
}

export function buildWorkerConversationJid(
  chatJid: string,
  agentId: string,
): string {
  return `${chatJid}${WORKER_CHAT_SEPARATOR}${agentId}`;
}

export function splitWorkerConversationJid(chatJid: string): {
  baseJid: string;
  agentId: string | null;
} {
  const agentSep = chatJid.indexOf(WORKER_CHAT_SEPARATOR);
  if (agentSep < 0) {
    return { baseJid: chatJid, agentId: null };
  }
  const agentId = chatJid.slice(agentSep + WORKER_CHAT_SEPARATOR.length).trim();
  return {
    baseJid: chatJid.slice(0, agentSep),
    agentId: agentId || null,
  };
}
