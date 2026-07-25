import { Check, Monitor, Moon, Sun } from 'lucide-react';

import { cn } from '@/lib/utils';
import { SKINS, type SkinDef, type ThemeMode } from '@/lib/themes';
import { useTheme } from '../../hooks/useTheme';

const MODES: { key: ThemeMode; label: string; icon: typeof Sun; hint: string }[] = [
  { key: 'light', label: '亮色', icon: Sun, hint: '始终使用亮色' },
  { key: 'dark', label: '暗色', icon: Moon, hint: '始终使用暗色' },
  { key: 'system', label: '跟随系统', icon: Monitor, hint: '随系统外观切换' },
];

/**
 * 皮肤预览卡片。左半边画亮色、右半边画暗色，
 * 让用户在不切换的情况下就能看出两种模式下的观感。
 */
function SkinPreview({ skin, active }: { skin: SkinDef; active: boolean }) {
  return (
    <div
      className={cn(
        'relative h-20 w-full overflow-hidden rounded-lg border transition-colors',
        active ? 'border-primary' : 'border-border',
      )}
      aria-hidden
    >
      <div className="absolute inset-0 flex">
        {/* 亮色半边 */}
        <div
          className="flex w-1/2 flex-col justify-between p-2"
          style={{ backgroundColor: skin.swatch.light }}
        >
          <div
            className="h-1.5 w-8 rounded-full"
            style={{ backgroundColor: skin.swatch.primary }}
          />
          <div className="space-y-1">
            <div
              className="h-1 w-10 rounded-full"
              style={{ backgroundColor: skin.swatch.primary, opacity: 0.35 }}
            />
            <div
              className="h-1 w-6 rounded-full"
              style={{ backgroundColor: skin.swatch.dark, opacity: 0.2 }}
            />
          </div>
        </div>
        {/* 暗色半边 */}
        <div
          className="flex w-1/2 flex-col justify-between p-2"
          style={{ backgroundColor: skin.swatch.dark }}
        >
          <div
            className="h-1.5 w-8 rounded-full"
            style={{ backgroundColor: skin.swatch.primary }}
          />
          <div className="space-y-1">
            <div
              className="h-1 w-10 rounded-full"
              style={{ backgroundColor: skin.swatch.primary, opacity: 0.45 }}
            />
            <div
              className="h-1 w-6 rounded-full"
              style={{ backgroundColor: skin.swatch.light, opacity: 0.25 }}
            />
          </div>
        </div>
      </div>

      {active && (
        <div className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
          <Check className="size-3" strokeWidth={3} />
        </div>
      )}
    </div>
  );
}

function SkinGrid({
  skins,
  current,
  onPick,
}: {
  skins: SkinDef[];
  current: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {skins.map((skin) => {
        const active = skin.id === current;
        return (
          <button
            key={skin.id}
            type="button"
            onClick={() => onPick(skin.id)}
            aria-pressed={active}
            className={cn(
              'group cursor-pointer rounded-xl border p-2 text-left transition-all',
              active
                ? 'border-primary bg-accent shadow-sm'
                : 'border-border hover:border-border-strong hover:bg-surface',
            )}
          >
            <SkinPreview skin={skin} active={active} />
            <div className="mt-2 px-0.5 pb-0.5">
              <div className="flex items-baseline gap-1.5">
                <span
                  className={cn(
                    'text-sm font-medium',
                    active ? 'text-primary' : 'text-foreground',
                  )}
                >
                  {skin.name}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {skin.latin}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                {skin.description}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function ThemeSection() {
  const { mode, resolvedMode, skin, setMode, setSkin } = useTheme();

  const signature = SKINS.filter((s) => s.group === 'signature');
  const classic = SKINS.filter((s) => s.group === 'classic');

  return (
    <div className="space-y-8">
      <p className="rounded-lg bg-surface px-4 py-3 text-sm text-muted-foreground">
        主题偏好保存在这台设备的浏览器里，不会影响其他人。共有 {SKINS.length} 套皮肤，
        每套都同时提供亮色与暗色两种模式。
      </p>

      {/* 明暗模式 */}
      <section>
        <h3 className="mb-1 text-base font-semibold text-foreground">显示模式</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          当前生效：{resolvedMode === 'dark' ? '暗色' : '亮色'}
        </p>
        <div className="grid max-w-md grid-cols-3 gap-2">
          {MODES.map(({ key, label, icon: Icon, hint }) => {
            const active = mode === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setMode(key)}
                aria-pressed={active}
                title={hint}
                className={cn(
                  'flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border px-3 py-3 transition-all',
                  active
                    ? 'border-primary bg-accent text-primary shadow-sm'
                    : 'border-border text-muted-foreground hover:border-border-strong hover:bg-surface hover:text-foreground',
                )}
              >
                <Icon className="size-5" />
                <span className="text-xs font-medium">{label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 皮肤 */}
      <section>
        <h3 className="mb-1 text-base font-semibold text-foreground">皮肤</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          预览左半边是亮色、右半边是暗色。
        </p>
        <SkinGrid skins={signature} current={skin} onPick={setSkin} />
      </section>

      <section>
        <h3 className="mb-1 text-base font-semibold text-foreground">经典配色</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          移植自广为人知的编辑器 / 终端配色方案。
        </p>
        <SkinGrid skins={classic} current={skin} onPick={setSkin} />
      </section>

      {/* 实时预览 */}
      <section>
        <h3 className="mb-3 text-base font-semibold text-foreground">效果预览</h3>
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
              主要按钮
            </span>
            <span className="rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground">
              次要按钮
            </span>
            <span className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground">
              描边按钮
            </span>
            <span className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground">
              危险操作
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <span className="rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success-foreground">
              成功
            </span>
            <span className="rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning-foreground">
              警告
            </span>
            <span className="rounded-full bg-error-bg px-2 py-0.5 text-xs font-medium text-error-foreground">
              错误
            </span>
            <span className="rounded-full bg-info-bg px-2 py-0.5 text-xs font-medium text-info-foreground">
              信息
            </span>
            <span className="tag-purple rounded-full px-2 py-0.5 text-xs font-medium">
              分类标签
            </span>
          </div>

          <div className="rounded-lg bg-surface p-3">
            <p className="text-sm text-foreground">正文文字，用于阅读的主要内容。</p>
            <p className="mt-1 text-xs text-muted-foreground">
              次要说明文字，对比度更低但仍然可读。
            </p>
          </div>

          <pre className="overflow-x-auto rounded-lg bg-[var(--code-bg)] p-3 text-xs">
            <code className="text-foreground">
              <span className="text-primary">const</span> theme ={' '}
              <span className="text-success">'{skin}'</span>;
            </code>
          </pre>
        </div>
      </section>
    </div>
  );
}
