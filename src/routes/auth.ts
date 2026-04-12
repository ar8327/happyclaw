import fs from 'fs';
import path from 'path';

import { Hono } from 'hono';

import { DATA_DIR } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getLocalWorkbenchSessionId,
  getLocalWorkbenchUserPublic,
  saveLocalWorkbenchProfile,
} from '../local-user.js';
import {
  getAppearanceConfig,
  getClaudeProviderConfig,
  getCodexProviderConfig,
  getFeishuProviderConfigWithSource,
} from '../runtime-config.js';
import {
  ChangePasswordSchema,
  ProfileUpdateSchema,
} from '../schemas.js';
import type { Variables } from '../web-context.js';

const authRoutes = new Hono<{ Variables: Variables }>();
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');

function buildSetupStatus() {
  const claudeConfig = getClaudeProviderConfig();
  const officialConfigured =
    !!claudeConfig.claudeCodeOauthToken?.trim() ||
    !!claudeConfig.claudeOAuthCredentials;
  const thirdPartyConfigured = !!(
    claudeConfig.anthropicBaseUrl?.trim() &&
    claudeConfig.anthropicAuthToken?.trim()
  );
  const claudeConfigured = officialConfigured || thirdPartyConfigured;
  const codexConfig = getCodexProviderConfig();
  const codexConfigured =
    codexConfig.hasCliAuth ||
    codexConfig.hasEnvApiKey ||
    !!codexConfig.activeProfile?.openaiApiKey;
  const { source: feishuSource } = getFeishuProviderConfigWithSource();
  const feishuConfigured = feishuSource !== 'none';

  return {
    needsSetup: !claudeConfigured && !codexConfigured,
    claudeConfigured,
    codexConfigured,
    feishuConfigured,
  };
}

function currentAuthPayload() {
  return {
    success: true,
    user: getLocalWorkbenchUserPublic(),
    setupStatus: buildSetupStatus(),
    appearance: getAppearanceConfig(),
  };
}

authRoutes.get('/status', (c) => {
  return c.json({ initialized: true, singleUser: true });
});

authRoutes.post('/setup', (c) => c.json(currentAuthPayload(), 201));
authRoutes.post('/login', (c) => c.json(currentAuthPayload()));
authRoutes.post('/register', (c) => c.json(currentAuthPayload(), 201));
authRoutes.post('/logout', authMiddleware, (c) =>
  c.json({ success: true, singleUser: true }),
);

authRoutes.get('/me', authMiddleware, (c) => {
  return c.json(currentAuthPayload());
});

authRoutes.put('/profile', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = ProfileUpdateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid profile payload' }, 400);
  }

  const data = validation.data;
  const user = saveLocalWorkbenchProfile({
    username: data.username?.trim() || undefined,
    display_name: data.display_name?.trim() || undefined,
    avatar_emoji: data.avatar_emoji ?? undefined,
    avatar_color: data.avatar_color ?? undefined,
    ai_name:
      data.ai_name === null
        ? null
        : data.ai_name?.trim()
          ? data.ai_name.trim()
          : undefined,
    ai_avatar_emoji: data.ai_avatar_emoji ?? undefined,
    ai_avatar_color: data.ai_avatar_color ?? undefined,
    ai_avatar_url: data.ai_avatar_url ?? undefined,
  });
  return c.json({ success: true, user });
});

authRoutes.put('/password', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = ChangePasswordSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid password payload' }, 400);
  }
  return c.json({
    success: true,
    singleUser: true,
    message: 'Single-user mode does not require an application password',
    user: getLocalWorkbenchUserPublic(),
  });
});

authRoutes.get('/sessions', authMiddleware, (c) => {
  return c.json({
    sessions: [
      {
        id: getLocalWorkbenchSessionId(),
        ip_address: 'local',
        user_agent: 'single-user-workbench',
        created_at: getLocalWorkbenchUserPublic().created_at,
        expires_at: null,
        last_active_at: new Date().toISOString(),
        is_current: true,
      },
    ],
  });
});

authRoutes.delete('/sessions/:id', authMiddleware, (c) => {
  return c.json({
    success: true,
    singleUser: true,
    message: 'Single-user mode keeps one local session active',
  });
});

authRoutes.post('/avatar', authMiddleware, async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('avatar');
  if (!(file instanceof File)) {
    return c.json({ error: 'Avatar file is required' }, 400);
  }
  if (file.size > 2 * 1024 * 1024) {
    return c.json({ error: 'Avatar file must be <= 2MB' }, 400);
  }

  const ext = (() => {
    if (file.type === 'image/png') return '.png';
    if (file.type === 'image/webp') return '.webp';
    if (file.type === 'image/gif') return '.gif';
    return '.jpg';
  })();
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const filename = `local-operator-${Date.now()}${ext}`;
  const absolutePath = path.join(AVATAR_DIR, filename);
  const bytes = await file.arrayBuffer();
  fs.writeFileSync(absolutePath, Buffer.from(bytes));

  const avatarUrl = `/api/auth/avatars/${filename}`;
  const user = saveLocalWorkbenchProfile({ ai_avatar_url: avatarUrl });
  return c.json({ success: true, avatarUrl, user });
});

authRoutes.get('/avatars/:filename', async (c) => {
  const filename = c.req.param('filename');
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  const absolutePath = path.join(AVATAR_DIR, filename);
  if (!fs.existsSync(absolutePath)) {
    return c.json({ error: 'Avatar not found' }, 404);
  }

  const ext = path.extname(filename).toLowerCase();
  const contentType =
    ext === '.png'
      ? 'image/png'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.gif'
          ? 'image/gif'
          : 'image/jpeg';
  return new Response(fs.readFileSync(absolutePath), {
    headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
});

export default authRoutes;
