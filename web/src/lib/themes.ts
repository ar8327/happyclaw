/**
 * 皮肤注册表 — 与 src/styles/themes.css 中的 [data-skin=...] 块一一对应。
 *
 * 新增皮肤时：
 *   1. 在 themes.css 里加一对 `[data-skin='xxx']` / `[data-skin='xxx'].dark` 种子块
 *   2. 在这里追加一条记录（swatch 用于设置页的预览色块）
 */

export type ThemeMode = 'light' | 'dark' | 'system';

export interface SkinDef {
  /** 与 data-skin 属性值一致 */
  id: string;
  /** 设置页显示的中文名 */
  name: string;
  /** 英文/原始名，作为副标题 */
  latin: string;
  /** 一句话描述 */
  description: string;
  /** 分组，用于设置页分区展示 */
  group: 'signature' | 'classic';
  /** 预览色块：[亮色底, 主色, 暗色底] */
  swatch: {
    light: string;
    primary: string;
    dark: string;
  };
}

export const SKINS: SkinDef[] = [
  {
    id: 'teal',
    name: '青瓷',
    latin: 'Teal',
    description: '默认皮肤，克制的青绿主色配中性石板灰',
    group: 'signature',
    swatch: { light: '#ffffff', primary: '#0d9488', dark: '#0a1120' },
  },
  {
    id: 'indigo',
    name: '靛蓝',
    latin: 'Indigo',
    description: '沉稳的靛蓝主色，适合长时间阅读',
    group: 'signature',
    swatch: { light: '#ffffff', primary: '#4f46e5', dark: '#0b0d1a' },
  },
  {
    id: 'violet',
    name: '紫棠',
    latin: 'Violet',
    description: '偏冷的紫色调，界面观感更现代',
    group: 'signature',
    swatch: { light: '#ffffff', primary: '#7c3aed', dark: '#0f0a1a' },
  },
  {
    id: 'rose',
    name: '胭脂',
    latin: 'Rose',
    description: '高饱和玫红主色，对比强烈',
    group: 'signature',
    swatch: { light: '#ffffff', primary: '#e11d48', dark: '#150810' },
  },
  {
    id: 'amber',
    name: '琥珀',
    latin: 'Amber',
    description: '暖橙主色配米白底，夜间不刺眼',
    group: 'signature',
    swatch: { light: '#fffdf8', primary: '#c2610c', dark: '#120e08' },
  },
  {
    id: 'emerald',
    name: '竹青',
    latin: 'Emerald',
    description: '清爽的翠绿，视觉负担低',
    group: 'signature',
    swatch: { light: '#ffffff', primary: '#059669', dark: '#061109' },
  },
  {
    id: 'graphite',
    name: '石墨',
    latin: 'Graphite',
    description: '完全单色，只靠层次和排版表达结构',
    group: 'signature',
    swatch: { light: '#ffffff', primary: '#27272a', dark: '#09090b' },
  },
  {
    id: 'sakura',
    name: '樱色',
    latin: 'Sakura',
    description: '柔和的樱粉，低对比、偏温柔',
    group: 'signature',
    swatch: { light: '#fff8fa', primary: '#d1618a', dark: '#181017' },
  },
  {
    id: 'abyss',
    name: '深海',
    latin: 'Abyss',
    description: '深蓝海底基调，暗色模式格外通透',
    group: 'signature',
    swatch: { light: '#f3f8fb', primary: '#0369a1', dark: '#03111b' },
  },
  {
    id: 'nord',
    name: '北欧',
    latin: 'Nord',
    description: '经典 Nord 极地配色，冷灰蓝',
    group: 'classic',
    swatch: { light: '#eceff4', primary: '#5e81ac', dark: '#2e3440' },
  },
  {
    id: 'dracula',
    name: '德古拉',
    latin: 'Dracula',
    description: '经典 Dracula，紫粉高饱和',
    group: 'classic',
    swatch: { light: '#f6f5fb', primary: '#bd93f9', dark: '#282a36' },
  },
  {
    id: 'solarized',
    name: '曝晒',
    latin: 'Solarized',
    description: '经典 Solarized，米黄底与低饱和强调色',
    group: 'classic',
    swatch: { light: '#fdf6e3', primary: '#268bd2', dark: '#002b36' },
  },
  {
    id: 'gruvbox',
    name: '复古',
    latin: 'Gruvbox',
    description: '经典 Gruvbox，暖褐色的复古终端感',
    group: 'classic',
    swatch: { light: '#fbf1c7', primary: '#fe8019', dark: '#282828' },
  },
  {
    id: 'catppuccin',
    name: '卡布',
    latin: 'Catppuccin',
    description: '经典 Catppuccin，Latte 与 Mocha 双味',
    group: 'classic',
    swatch: { light: '#eff1f5', primary: '#8839ef', dark: '#1e1e2e' },
  },
  {
    id: 'tokyo',
    name: '东京夜',
    latin: 'Tokyo Night',
    description: '经典 Tokyo Night，霓虹蓝紫',
    group: 'classic',
    swatch: { light: '#e6e7ed', primary: '#7aa2f7', dark: '#1a1b26' },
  },
];

export const DEFAULT_SKIN = 'teal';

const SKIN_IDS = new Set(SKINS.map((s) => s.id));

export function isValidSkin(id: string | null | undefined): id is string {
  return !!id && SKIN_IDS.has(id);
}

export function getSkin(id: string): SkinDef {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}
