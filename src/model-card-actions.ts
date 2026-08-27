/**
 * Feishu card callbacks for the `/model` card.
 *
 * The transport (`feishu.ts`) must not reach into session/runtime state, so
 * `index.ts` registers the actual apply function here at startup — the same
 * inversion the progress card uses for its stop button.
 *
 * Unlike the progress card, the routing context is embedded in the card's
 * callback value rather than kept in an in-memory registry: a config card is
 * long-lived in the chat history and has to keep working across restarts. The
 * embedded ids are re-validated on every click.
 */

export const MODEL_CARD_ACTION = 'model_config';

export interface ModelCardActionRequest {
  /** `runner` | `model` | `effort` | `variant` | `reset` */
  field: string;
  /** Selected option value; null for `reset` or an empty selection. */
  value: string | null;
  sessionId: string;
  chatJid: string;
  /** Routed session JID the card was built for (Feishu topic, bound agent). */
  targetJid: string | null;
}

export interface ModelCardActionOutcome {
  toast: {
    type: 'success' | 'info' | 'warning' | 'error';
    content: string;
  };
  /** Full replacement card, rendered by the caller as `{type:'raw',data}`. */
  card?: Record<string, unknown>;
}

export interface ModelCardActionPayload {
  action?: {
    value?: unknown;
    tag?: string;
    name?: string;
    option?: unknown;
    options?: unknown;
    input_value?: unknown;
    form_value?: unknown;
  };
}

type ModelCardActionHandler = (
  request: ModelCardActionRequest,
) => Promise<ModelCardActionOutcome>;

let handler: ModelCardActionHandler | null = null;

export function setModelCardActionHandler(
  fn: ModelCardActionHandler | null,
): void {
  handler = fn;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Pull the selected value out of a card action.
 *
 * Feishu reports a `select_static` choice in `action.option`, but a component
 * nested in a form container reports it under `action.form_value[name]`
 * instead. Accepting both keeps the card working in either layout.
 */
function readSelectedValue(
  action: NonNullable<ModelCardActionPayload['action']>,
  fieldName: string,
): string | null {
  const direct = readString(action.option) ?? readString(action.input_value);
  if (direct) return direct;
  if (Array.isArray(action.options)) {
    const first = action.options.find((item) => readString(item));
    if (first) return readString(first);
  }
  const formValue = action.form_value;
  if (formValue && typeof formValue === 'object' && !Array.isArray(formValue)) {
    const record = formValue as Record<string, unknown>;
    return (
      readString(record[`hc_model_${fieldName}`]) ??
      readString(record[fieldName])
    );
  }
  return null;
}

export function parseModelCardAction(
  payload: ModelCardActionPayload,
): ModelCardActionRequest | null {
  const action = payload.action;
  if (!action) return null;
  const value = action.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.action !== MODEL_CARD_ACTION) return null;

  const field = readString(record.field);
  const sessionId = readString(record.session);
  const chatJid = readString(record.jid);
  if (!field || !sessionId || !chatJid) return null;

  return {
    field,
    value: field === 'reset' ? null : readSelectedValue(action, field),
    sessionId,
    chatJid,
    targetJid: readString(record.target),
  };
}

/**
 * Returns null when the payload is not a model-card action, so the caller can
 * fall through to other card handlers.
 */
export async function handleModelCardAction(
  payload: ModelCardActionPayload,
): Promise<ModelCardActionOutcome | null> {
  const request = parseModelCardAction(payload);
  if (!request) return null;
  if (!handler) {
    return {
      toast: { type: 'error', content: '服务尚未就绪，请稍后重试' },
    };
  }
  return handler(request);
}
