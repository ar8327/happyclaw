export interface FeishuApiErrorSummary {
  message: string;
  code?: string;
  status?: number;
  larkCode?: number;
  larkMessage?: string;
}

/** Keep SDK request headers, sockets, and bearer tokens out of logs. */
export function summarizeFeishuApiError(err: unknown): FeishuApiErrorSummary {
  const candidate =
    err && typeof err === 'object'
      ? (err as {
          message?: unknown;
          code?: unknown;
          response?: {
            status?: unknown;
            data?: { code?: unknown; msg?: unknown };
          };
        })
      : null;
  const status = candidate?.response?.status;
  const larkCode = candidate?.response?.data?.code;
  const larkMessage = candidate?.response?.data?.msg;
  return {
    message:
      typeof candidate?.message === 'string'
        ? candidate.message
        : err instanceof Error
          ? err.message
          : String(err),
    ...(typeof candidate?.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof larkCode === 'number' ? { larkCode } : {}),
    ...(typeof larkMessage === 'string' ? { larkMessage } : {}),
  };
}

export function isTransientFeishuApiError(err: unknown): boolean {
  const summary = summarizeFeishuApiError(err);
  if (summary.status !== undefined) {
    return (
      summary.status === 408 || summary.status === 429 || summary.status >= 500
    );
  }
  return (
    summary.message === 'No Lark client available' ||
    summary.code === 'ECONNRESET' ||
    summary.code === 'ECONNREFUSED' ||
    summary.code === 'ETIMEDOUT' ||
    summary.code === 'EAI_AGAIN' ||
    summary.code === 'ERR_NETWORK' ||
    summary.code === 'ERR_BAD_RESPONSE'
  );
}
