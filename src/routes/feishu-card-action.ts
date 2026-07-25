import { Hono } from 'hono';
import * as lark from '@larksuiteoapi/node-sdk';
import type { Variables } from '../web-context.js';
import { getImFeishuConfig } from '../runtime-config.js';
import { handleProgressCardAction } from '../feishu-progress-card.js';
import { logger } from '../logger.js';

const routes = new Hono<{ Variables: Variables }>();

/**
 * Public Feishu card callback endpoint.
 *
 * This route intentionally does not use HappyClaw's browser auth cookie:
 * authenticity is checked by the Lark SDK with the configured verification
 * token (and encryption key when enabled in the developer console).
 */
routes.post('/card-action', async (c) => {
  const config = getImFeishuConfig();
  if (!config?.cardVerificationToken) {
    return c.json({ error: 'Feishu card callbacks are not configured' }, 503);
  }

  const payload = await c.req.json().catch(() => null);
  if (!payload) return c.json({ error: 'Invalid JSON body' }, 400);

  const handler = new lark.CardActionHandler(
    {
      verificationToken: config.cardVerificationToken,
      encryptKey: config.cardEncryptKey || undefined,
      loggerLevel: lark.LoggerLevel.warn,
    },
    async (data: Record<string, unknown>) => {
      const action = data.action as Record<string, unknown> | undefined;
      const result = await handleProgressCardAction(action?.value);
      if (result === 'stopped') {
        return {
          toast: { type: 'success', content: '已停止当前执行' },
        };
      }
      if (result === 'already_finished') {
        return {
          toast: { type: 'info', content: '该执行已结束' },
        };
      }
      return {
        toast: { type: 'warning', content: '无法识别此操作' },
      };
    },
  );

  try {
    const response = await handler.invoke(payload);
    if (response === undefined) {
      return c.json({ error: 'Invalid Feishu card callback' }, 401);
    }
    return c.json(response ?? {});
  } catch (err) {
    logger.warn({ err }, 'Rejected Feishu card action callback');
    return c.json({ error: 'Invalid Feishu card callback' }, 401);
  }
});

export default routes;
