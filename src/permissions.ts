import { Permission, PermissionTemplateKey, UserRole } from './types.js';

export const ALL_PERMISSIONS: Permission[] = [
  'manage_system_config',
  'manage_group_env',
];

export const PERMISSION_TEMPLATES: Partial<Record<
  PermissionTemplateKey,
  {
    key: PermissionTemplateKey;
    label: string;
    role: UserRole;
    permissions: Permission[];
  }
>> = {
  admin_full: {
    key: 'admin_full',
    label: '单用户 Operator',
    role: 'admin',
    permissions: [...ALL_PERMISSIONS],
  },
  ops_manager: {
    key: 'ops_manager',
    label: '配置与环境维护',
    role: 'member',
    permissions: ['manage_system_config', 'manage_group_env'],
  },
};

export const ROLE_DEFAULT_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  member: [],
};

export function normalizePermissions(input: unknown): Permission[] {
  if (!Array.isArray(input)) return [];
  const set = new Set<Permission>();
  for (const value of input) {
    if (typeof value !== 'string') continue;
    if ((ALL_PERMISSIONS as string[]).includes(value)) {
      set.add(value as Permission);
    }
  }
  return Array.from(set);
}

export function getDefaultPermissions(role: UserRole): Permission[] {
  return [...(ROLE_DEFAULT_PERMISSIONS[role] || [])];
}

export function resolveTemplate(
  template: PermissionTemplateKey | undefined,
): { role: UserRole; permissions: Permission[] } | null {
  if (!template) return null;
  const item = PERMISSION_TEMPLATES[template];
  if (!item) return null;
  return { role: item.role, permissions: [...item.permissions] };
}

export function hasPermission(
  user: { role: UserRole; permissions: Permission[] },
  permission: Permission,
): boolean {
  if (user.role === 'admin') return true;
  return user.permissions.includes(permission);
}
