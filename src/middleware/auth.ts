import type { Permission } from '../types.js';
import { hasPermission } from '../permissions.js';
import {
  getLocalWorkbenchAuthUser,
  getLocalWorkbenchSessionId,
} from '../local-user.js';

export const authMiddleware = async (c: any, next: any) => {
  c.set('user', getLocalWorkbenchAuthUser());
  c.set('sessionId', getLocalWorkbenchSessionId());
  await next();
};

export const requirePermission =
  (permission: Permission) => async (c: any, next: any) => {
    const user = c.get('user') ?? getLocalWorkbenchAuthUser();
    if (!hasPermission(user, permission)) {
      return c.json({ error: `Forbidden: ${permission} required` }, 403);
    }
    await next();
  };

export const requireAnyPermission =
  (permissions: Permission[]) => async (c: any, next: any) => {
    const user = c.get('user') ?? getLocalWorkbenchAuthUser();
    const ok = permissions.some((permission) => hasPermission(user, permission));
    if (!ok) {
      return c.json(
        { error: `Forbidden: one of [${permissions.join(', ')}] required` },
        403,
      );
    }
    await next();
  };

export const systemConfigMiddleware = requirePermission('manage_system_config');
export const groupEnvMiddleware = requireAnyPermission([
  'manage_group_env',
  'manage_system_config',
]);
export const usersManageMiddleware = requirePermission('manage_users');
export const inviteManageMiddleware = requirePermission('manage_invites');
export const auditViewMiddleware = requirePermission('view_audit_log');
