/**
 * `/model` slash command — pure parsing, resolution and text rendering.
 *
 * The command lets an IM user inspect and switch the runtime configuration of
 * the session their chat is currently routed to: runner, model, thinking
 * effort and model backend variant. Everything here is side-effect free so it
 * can be unit tested without a DB; `index.ts` owns the persistence and the
 * runtime restart, and `feishu-card-builder.ts` owns the card rendering.
 */

// ─── Snapshot types ─────────────────────────────────────────────

export interface ModelChoice {
  id: string;
  label?: string;
  modelProvider?: string;
  supportedThinkingEfforts?: string[];
  backendVariants?: Array<{ id: string; label?: string }>;
}

export interface ModelRunnerOption {
  id: string;
  label: string;
  /** Runner CLI present and authenticated. Unavailable runners stay listed. */
  available: boolean;
  unavailableReason?: string;
  defaultModel: string | null;
  models: ModelChoice[];
  /** Efforts declared by the runner profile schema (superset of per-model). */
  schemaEfforts: string[];
  /** Backend variants declared by the runner profile schema. */
  schemaVariants: string[];
}

/**
 * Everything `/model` needs to answer and to validate a change, resolved once
 * per invocation by the caller.
 */
export interface ModelConfigSnapshot {
  sessionId: string;
  sessionKind: string;
  /** "工作区 / 主会话" style line, same wording as /where and /status. */
  locationLine: string;
  runnerId: string;
  /** Explicit per-session override; null means "inherit". */
  model: string | null;
  thinkingEffort: string | null;
  modelBackendVariant: string | null;
  profileId: string | null;
  profileName: string | null;
  /** Model coming from the active runner profile, used when model is null. */
  profileModel: string | null;
  profileThinkingEffort: string | null;
  profileModelBackendVariant: string | null;
  /** A turn is executing right now — config lands on the next turn. */
  turnActive: boolean;
  runners: ModelRunnerOption[];
}

/**
 * Efforts and variants the session record can actually store
 * (`SessionRecord.thinking_effort` / `model_backend_variant`).
 *
 * A runner catalog may advertise levels outside this set; offering them would
 * produce a selection that silently fails to persist, so they are filtered out
 * of every option list here.
 */
export const PERSISTABLE_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const PERSISTABLE_VARIANTS = ['standard', 'max'];

const FALLBACK_EFFORTS = ['low', 'medium', 'high'];

const EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
};

/** Tokens that clear an override back to the runner/profile default. */
const RESET_TOKENS = new Set([
  'default',
  'defaults',
  'inherit',
  'none',
  'null',
  'off',
  'clear',
  'reset',
  '-',
  '默认',
  '清除',
]);

// ─── Snapshot helpers ───────────────────────────────────────────

export function findRunnerOption(
  snapshot: ModelConfigSnapshot,
  runnerId: string,
): ModelRunnerOption | undefined {
  return snapshot.runners.find((runner) => runner.id === runnerId);
}

export function findModelChoice(
  runner: ModelRunnerOption | undefined,
  modelId: string | null | undefined,
): ModelChoice | undefined {
  if (!runner || !modelId) return undefined;
  const normalized = modelId.trim().toLowerCase();
  return runner.models.find(
    (model) => model.id.trim().toLowerCase() === normalized,
  );
}

/** The model the runtime will actually launch with. */
export function effectiveModel(snapshot: ModelConfigSnapshot): string | null {
  const runner = findRunnerOption(snapshot, snapshot.runnerId);
  return (
    snapshot.model ?? snapshot.profileModel ?? runner?.defaultModel ?? null
  );
}

export function effectiveThinkingEffort(
  snapshot: ModelConfigSnapshot,
): string | null {
  return snapshot.thinkingEffort ?? snapshot.profileThinkingEffort ?? null;
}

export function effectiveModelBackendVariant(
  snapshot: ModelConfigSnapshot,
): string | null {
  return (
    snapshot.modelBackendVariant ?? snapshot.profileModelBackendVariant ?? null
  );
}

/**
 * Efforts a given model actually accepts.
 *
 * Per-model capabilities win when the catalog declares them; the profile
 * schema then narrows the list, mirroring `thinkingEffortOptionsFromSchema()`
 * in the web client so both surfaces offer the same choices.
 */
export function availableEfforts(
  runner: ModelRunnerOption | undefined,
  model: ModelChoice | undefined,
): string[] {
  const persistable = (values: string[]): string[] =>
    values
      .map((value) => value.trim().toLowerCase())
      .filter((value) => PERSISTABLE_EFFORTS.includes(value));

  const schemaEfforts = persistable(runner?.schemaEfforts ?? []);
  const modelEfforts = persistable(model?.supportedThinkingEfforts ?? []);
  if (modelEfforts.length > 0) {
    const narrowed =
      schemaEfforts.length > 0
        ? modelEfforts.filter((effort) => schemaEfforts.includes(effort))
        : modelEfforts;
    return narrowed.length > 0 ? narrowed : modelEfforts;
  }
  if (schemaEfforts.length > 0) return schemaEfforts;
  return [...FALLBACK_EFFORTS];
}

export function availableVariants(
  runner: ModelRunnerOption | undefined,
  model: ModelChoice | undefined,
): Array<{ id: string; label?: string }> {
  const source = model?.backendVariants?.length
    ? model.backendVariants
    : (runner?.schemaVariants ?? []).map((id) => ({ id }));
  return source.filter((variant) =>
    PERSISTABLE_VARIANTS.includes(variant.id.trim().toLowerCase()),
  );
}

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort;
}

export function modelLabel(model: ModelChoice): string {
  return model.label && model.label !== model.id
    ? `${model.label} (${model.id})`
    : model.id;
}

// ─── Parsing ────────────────────────────────────────────────────

export interface ModelCommandSet {
  runner?: string;
  model?: string;
  /** `null` means "clear the override". */
  effort?: string | null;
  variant?: string | null;
}

export type ModelCommandIntent =
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'list'; runner?: string }
  | { kind: 'reset' }
  | { kind: 'set'; set: ModelCommandSet; positional: string[] }
  | { kind: 'error'; message: string };

const FIELD_ALIASES: Record<string, keyof ModelCommandSet> = {
  runner: 'runner',
  engine: 'runner',
  model: 'model',
  m: 'model',
  effort: 'effort',
  thinking: 'effort',
  thinking_effort: 'effort',
  reasoning: 'effort',
  variant: 'variant',
  backend: 'variant',
  model_backend_variant: 'variant',
};

/**
 * Split on whitespace while honouring quotes — several runners ship model ids
 * containing spaces and parentheses (e.g. `Gemini 3.1 Pro (High)`).
 */
export function tokenizeModelArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasCurrent = false;

  for (const char of raw.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasCurrent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasCurrent || current) tokens.push(current);
      current = '';
      hasCurrent = false;
      continue;
    }
    current += char;
    hasCurrent = true;
  }
  if (hasCurrent || current) tokens.push(current);
  return tokens.filter((token) => token.length > 0);
}

export function parseModelCommandArgs(raw: string): ModelCommandIntent {
  const tokens = tokenizeModelArgs(raw ?? '');
  if (tokens.length === 0) return { kind: 'status' };

  const head = tokens[0].toLowerCase();
  if (head === 'help' || head === '?' || head === 'h') return { kind: 'help' };
  if (head === 'list' || head === 'ls' || head === 'models') {
    return { kind: 'list', runner: tokens[1] };
  }
  if (tokens.length === 1 && RESET_TOKENS.has(head)) return { kind: 'reset' };

  const set: ModelCommandSet = {};
  const positional: string[] = [];

  const assign = (field: keyof ModelCommandSet, rawValue: string): void => {
    const value = rawValue.trim();
    if (field === 'effort' || field === 'variant') {
      set[field] = RESET_TOKENS.has(value.toLowerCase()) ? null : value;
      return;
    }
    set[field] = value;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const inline = token.match(/^([A-Za-z_]+)[=:]([\s\S]*)$/);
    if (inline) {
      const field = FIELD_ALIASES[inline[1].toLowerCase()];
      if (field) {
        const value = inline[2] || tokens[i + 1];
        if (!value) {
          return { kind: 'error', message: `${inline[1]} 缺少取值` };
        }
        if (!inline[2]) i += 1;
        assign(field, value);
        continue;
      }
    }
    const field = FIELD_ALIASES[token.toLowerCase()];
    if (field) {
      const value = tokens[i + 1];
      if (!value) return { kind: 'error', message: `${token} 缺少取值` };
      assign(field, value);
      i += 1;
      continue;
    }
    positional.push(token);
  }

  if (
    !set.runner &&
    !set.model &&
    set.effort === undefined &&
    set.variant === undefined &&
    positional.length === 0
  ) {
    return { kind: 'status' };
  }

  return { kind: 'set', set, positional };
}

// ─── Change resolution ──────────────────────────────────────────

export interface ModelChangePlan {
  runnerId: string;
  runnerChanged: boolean;
  model: string | null;
  modelChanged: boolean;
  thinkingEffort: string | null;
  effortChanged: boolean;
  modelBackendVariant: string | null;
  variantChanged: boolean;
  /** Human-readable side effects worth surfacing in the reply. */
  notes: string[];
  /**
   * A runner swap invalidates the provider session state, so the current
   * runtime has to be stopped and its resume anchor dropped.
   */
  requiresRuntimeReset: boolean;
}

export type ModelChangeResolution =
  | { ok: true; plan: ModelChangePlan }
  | { ok: false; message: string };

function matchRunner(
  snapshot: ModelConfigSnapshot,
  spec: string,
): ModelRunnerOption | undefined {
  const normalized = spec.trim().toLowerCase();
  return (
    snapshot.runners.find((runner) => runner.id.toLowerCase() === normalized) ||
    snapshot.runners.find(
      (runner) => runner.label.trim().toLowerCase() === normalized,
    )
  );
}

function matchModelInRunner(
  runner: ModelRunnerOption,
  spec: string,
): ModelChoice[] {
  const normalized = spec.trim().toLowerCase();
  const exact = runner.models.filter(
    (model) => model.id.toLowerCase() === normalized,
  );
  if (exact.length > 0) return exact;
  const byLabel = runner.models.filter(
    (model) => (model.label || '').trim().toLowerCase() === normalized,
  );
  if (byLabel.length > 0) return byLabel;
  const prefix = runner.models.filter((model) =>
    model.id.toLowerCase().startsWith(normalized),
  );
  if (prefix.length > 0) return prefix;
  return runner.models.filter(
    (model) =>
      model.id.toLowerCase().includes(normalized) ||
      (model.label || '').toLowerCase().includes(normalized),
  );
}

function describeModelCandidates(models: ModelChoice[], max = 8): string {
  const shown = models.slice(0, max).map((model) => model.id);
  const suffix = models.length > max ? ` …（共 ${models.length} 个）` : '';
  return shown.join(' / ') + suffix;
}

/**
 * Turn a parsed intent into a concrete change, or explain why it cannot apply.
 *
 * Model ids outside the catalog are accepted deliberately: several runner
 * catalogs are populated from an on-disk cache that may be cold, and the web
 * surface accepts free-form model ids too. Only a model that clearly belongs
 * to a *different* runner is rejected.
 */
export function resolveModelChange(
  snapshot: ModelConfigSnapshot,
  intent: Extract<ModelCommandIntent, { kind: 'set' } | { kind: 'reset' }>,
): ModelChangeResolution {
  const notes: string[] = [];
  const currentRunner = findRunnerOption(snapshot, snapshot.runnerId);

  if (intent.kind === 'reset') {
    return {
      ok: true,
      plan: {
        runnerId: snapshot.runnerId,
        runnerChanged: false,
        model: null,
        modelChanged: snapshot.model !== null,
        thinkingEffort: null,
        effortChanged: snapshot.thinkingEffort !== null,
        modelBackendVariant: null,
        variantChanged: snapshot.modelBackendVariant !== null,
        notes: ['已清除 model / effort / variant 覆盖，回到 runner 默认值'],
        requiresRuntimeReset: false,
      },
    };
  }

  const { set, positional } = intent;

  // ── Runner ──
  let runner = currentRunner;
  let runnerExplicit = false;
  if (set.runner) {
    const matched = matchRunner(snapshot, set.runner);
    if (!matched) {
      return {
        ok: false,
        message: `未知 runner "${set.runner}"，可用：${snapshot.runners
          .map((item) => item.id)
          .join(' / ')}`,
      };
    }
    runner = matched;
    runnerExplicit = true;
  }

  // ── Model spec ──
  let modelSpec = set.model?.trim() || '';
  if (!modelSpec && positional.length > 0) {
    const leading = matchRunner(snapshot, positional[0]);
    if (leading && positional.length > 1) {
      if (runnerExplicit && leading.id !== runner?.id) {
        return {
          ok: false,
          message: `runner 指定冲突："${set.runner}" 与 "${positional[0]}"`,
        };
      }
      runner = leading;
      runnerExplicit = true;
      modelSpec = positional.slice(1).join(' ');
    } else if (leading && positional.length === 1 && !runnerExplicit) {
      runner = leading;
      runnerExplicit = true;
    } else {
      modelSpec = positional.join(' ');
    }
  }

  // A bare model spec picks its runner: prefer the current one, then any
  // runner whose catalog contains it.
  if (modelSpec && !runnerExplicit) {
    const inCurrent = currentRunner
      ? matchModelInRunner(currentRunner, modelSpec)
      : [];
    if (inCurrent.length === 0) {
      const owners = snapshot.runners.filter(
        (candidate) => matchModelInRunner(candidate, modelSpec).length > 0,
      );
      if (owners.length === 1) {
        runner = owners[0];
      } else if (owners.length > 1) {
        return {
          ok: false,
          message: `模型 "${modelSpec}" 在多个 runner 中都存在：${owners
            .map((item) => item.id)
            .join(' / ')}\n请写成 /model <runner> <model>`,
        };
      }
    }
  }

  if (!runner) {
    return { ok: false, message: `当前 runner "${snapshot.runnerId}" 未注册` };
  }

  // ── Resolve the model against the chosen runner ──
  let nextModel: string | null = snapshot.model;
  if (modelSpec) {
    if (RESET_TOKENS.has(modelSpec.toLowerCase())) {
      nextModel = null;
    } else {
      const matches = matchModelInRunner(runner, modelSpec);
      if (matches.length === 1) {
        nextModel = matches[0].id;
      } else if (matches.length > 1) {
        return {
          ok: false,
          message: `模型 "${modelSpec}" 不唯一：${describeModelCandidates(matches)}`,
        };
      } else {
        const foreignOwner = snapshot.runners.find(
          (candidate) =>
            candidate.id !== runner!.id &&
            matchModelInRunner(candidate, modelSpec).some(
              (model) => model.id.toLowerCase() === modelSpec.toLowerCase(),
            ),
        );
        if (foreignOwner) {
          return {
            ok: false,
            message: `模型 "${modelSpec}" 属于 runner "${foreignOwner.id}"，与 "${runner.id}" 不匹配`,
          };
        }
        nextModel = modelSpec;
        notes.push(
          `"${modelSpec}" 不在 ${runner.id} 的已知模型列表里，按原样写入`,
        );
      }
    }
  } else if (runnerExplicit && runner.id !== snapshot.runnerId) {
    // Switching runner without naming a model: the old override belongs to the
    // old catalog, so drop it and let the new runner's default apply.
    nextModel = null;
  }

  const runnerChanged = runner.id !== snapshot.runnerId;
  const modelChanged = nextModel !== snapshot.model;
  const modelChoice = findModelChoice(
    runner,
    nextModel ?? runner.defaultModel ?? null,
  );

  // ── Effort ──
  const efforts = availableEfforts(runner, modelChoice);
  let nextEffort = snapshot.thinkingEffort;
  if (set.effort !== undefined) {
    if (set.effort === null) {
      nextEffort = null;
    } else {
      const normalized = set.effort.trim().toLowerCase();
      if (!efforts.includes(normalized)) {
        return {
          ok: false,
          message: `effort "${set.effort}" 不可用，当前模型支持：${efforts.join(' / ')}（或 default 复位）`,
        };
      }
      nextEffort = normalized;
    }
  } else if ((runnerChanged || modelChanged) && nextEffort) {
    if (!efforts.includes(nextEffort)) {
      notes.push(`新模型不支持 effort "${nextEffort}"，已复位为默认`);
      nextEffort = null;
    }
  }

  // ── Backend variant ──
  const variants = availableVariants(runner, modelChoice);
  let nextVariant = snapshot.modelBackendVariant;
  if (set.variant !== undefined) {
    if (set.variant === null) {
      nextVariant = null;
    } else {
      const normalized = set.variant.trim().toLowerCase();
      const matched = variants.find(
        (variant) => variant.id.toLowerCase() === normalized,
      );
      if (!matched) {
        return {
          ok: false,
          message: variants.length
            ? `variant "${set.variant}" 不可用，当前模型支持：${variants
                .map((variant) => variant.id)
                .join(' / ')}（或 default 复位）`
            : `当前模型没有可选的 backend variant`,
        };
      }
      nextVariant = matched.id;
    }
  } else if (runnerChanged || modelChanged) {
    // Mirrors PATCH /api/sessions/:id — a variant is only meaningful for the
    // exact model it was chosen for.
    if (nextVariant) notes.push(`模型已变化，backend variant 复位为默认`);
    nextVariant = null;
  }

  const plan: ModelChangePlan = {
    runnerId: runner.id,
    runnerChanged,
    model: nextModel,
    modelChanged,
    thinkingEffort: nextEffort,
    effortChanged: nextEffort !== snapshot.thinkingEffort,
    modelBackendVariant: nextVariant,
    variantChanged: nextVariant !== snapshot.modelBackendVariant,
    notes,
    requiresRuntimeReset: runnerChanged,
  };

  if (
    !plan.runnerChanged &&
    !plan.modelChanged &&
    !plan.effortChanged &&
    !plan.variantChanged
  ) {
    return { ok: false, message: '配置没有变化' };
  }

  if (!runner.available) {
    plan.notes.push(
      `⚠️ runner "${runner.id}" 当前不可用${
        runner.unavailableReason ? `：${runner.unavailableReason}` : ''
      }`,
    );
  }

  return { ok: true, plan };
}

// ─── Text rendering ─────────────────────────────────────────────

function displayValue(value: string | null, inherited: string | null): string {
  if (value) return value;
  return inherited ? `${inherited}（继承）` : '默认';
}

export function formatModelStatus(snapshot: ModelConfigSnapshot): string {
  const runner = findRunnerOption(snapshot, snapshot.runnerId);
  const resolvedModel = effectiveModel(snapshot);
  const modelChoice = findModelChoice(runner, resolvedModel);
  const efforts = availableEfforts(runner, modelChoice);
  const variants = availableVariants(runner, modelChoice);

  const lines = [
    '⚙️ 模型配置',
    '━━━━━━━━━━',
    `📍 会话: ${snapshot.locationLine}`,
    `🧩 Runner: ${runner ? `${runner.label} (${runner.id})` : snapshot.runnerId}${
      runner && !runner.available ? ' ⚠️ 不可用' : ''
    }`,
    `🤖 Model: ${displayValue(snapshot.model, resolvedModel)}`,
    `🧠 Effort: ${displayValue(
      snapshot.thinkingEffort,
      snapshot.profileThinkingEffort,
    )}`,
  ];

  if (variants.length > 0) {
    lines.push(
      `🎛 Variant: ${displayValue(
        snapshot.modelBackendVariant,
        snapshot.profileModelBackendVariant,
      )}`,
    );
  }
  if (snapshot.profileName) {
    lines.push(`📄 Profile: ${snapshot.profileName}`);
  }

  lines.push('');
  lines.push(
    `可选 Runner: ${snapshot.runners
      .map((item) => (item.available ? item.id : `${item.id}⚠️`))
      .join(' / ')}`,
  );
  if (runner) {
    const models = runner.models.slice(0, 10).map((model) => model.id);
    lines.push(
      `${runner.id} 的模型: ${
        models.length ? models.join(' / ') : '（catalog 为空）'
      }${runner.models.length > 10 ? ` …共 ${runner.models.length} 个` : ''}`,
    );
  }
  lines.push(`可选 Effort: ${efforts.join(' / ')}`);
  if (variants.length > 0) {
    lines.push(`可选 Variant: ${variants.map((item) => item.id).join(' / ')}`);
  }

  if (snapshot.turnActive) {
    lines.push('');
    lines.push('⏳ 当前 turn 正在执行，改动会在下一轮生效');
  }

  lines.push('');
  lines.push(formatModelHelp());
  return lines.join('\n');
}

export function formatModelList(
  snapshot: ModelConfigSnapshot,
  runnerSpec?: string,
): string {
  if (runnerSpec) {
    const runner = matchRunner(snapshot, runnerSpec);
    if (!runner) {
      return `未知 runner "${runnerSpec}"，可用：${snapshot.runners
        .map((item) => item.id)
        .join(' / ')}`;
    }
    const lines = [
      `🧩 ${runner.label} (${runner.id})${runner.available ? '' : ' ⚠️ 不可用'}`,
    ];
    if (!runner.available && runner.unavailableReason) {
      lines.push(`   ${runner.unavailableReason}`);
    }
    lines.push(`   默认模型: ${runner.defaultModel || '（未声明）'}`);
    lines.push('');
    if (runner.models.length === 0) {
      lines.push('   （模型 catalog 为空，可直接写模型名）');
    }
    for (const model of runner.models) {
      const marker =
        model.id === effectiveModel(snapshot) && runner.id === snapshot.runnerId
          ? ' ← 当前'
          : '';
      lines.push(`   · ${modelLabel(model)}${marker}`);
      const efforts = availableEfforts(runner, model);
      const variants = availableVariants(runner, model);
      const detail = [
        efforts.length ? `effort: ${efforts.join('/')}` : '',
        variants.length
          ? `variant: ${variants.map((v) => v.id).join('/')}`
          : '',
        model.modelProvider ? `provider: ${model.modelProvider}` : '',
      ].filter(Boolean);
      if (detail.length) lines.push(`       ${detail.join(' · ')}`);
    }
    return lines.join('\n');
  }

  const lines = ['🧩 可用 Runner'];
  for (const runner of snapshot.runners) {
    const marker = runner.id === snapshot.runnerId ? ' ← 当前' : '';
    lines.push(
      `${runner.available ? '·' : '⚠️'} ${runner.label} (${runner.id})${marker}`,
    );
    const models = runner.models.slice(0, 6).map((model) => model.id);
    lines.push(
      `    模型: ${models.length ? models.join(' / ') : '（catalog 为空）'}${
        runner.models.length > 6 ? ` …共 ${runner.models.length} 个` : ''
      }`,
    );
  }
  lines.push('');
  lines.push('💡 /model list <runner> 查看某个 runner 的完整模型与参数');
  return lines.join('\n');
}

export function formatModelHelp(): string {
  return [
    '用法：',
    '  /model                     查看当前配置',
    '  /model list [runner]       列出 runner 与模型',
    '  /model <model>             切换模型（自动推断 runner）',
    '  /model <runner> <model>    显式指定 runner 与模型',
    '  /model effort <level>      切换推理强度（default 复位）',
    '  /model variant <id>        切换模型后端变体（default 复位）',
    '  /model reset               清除全部覆盖',
    '  组合写法：/model claude opus effort:high',
  ].join('\n');
}

export function formatModelChangeResult(
  before: ModelConfigSnapshot,
  plan: ModelChangePlan,
  outcome: { runtimeStopped: boolean; turnWasActive: boolean },
): string {
  const beforeRunner = findRunnerOption(before, before.runnerId);
  const afterRunner = findRunnerOption(before, plan.runnerId);
  const beforeModel = effectiveModel(before);
  const afterModel =
    plan.model ?? before.profileModel ?? afterRunner?.defaultModel ?? null;

  const lines = ['✅ 已更新模型配置'];
  if (plan.runnerChanged) {
    lines.push(
      `  Runner: ${beforeRunner?.id || before.runnerId} → ${afterRunner?.id || plan.runnerId}`,
    );
  } else {
    lines.push(`  Runner: ${afterRunner?.id || plan.runnerId}`);
  }
  if (plan.modelChanged) {
    lines.push(`  Model: ${beforeModel || '默认'} → ${afterModel || '默认'}`);
  } else {
    lines.push(`  Model: ${afterModel || '默认'}`);
  }
  if (plan.effortChanged) {
    lines.push(
      `  Effort: ${before.thinkingEffort || '默认'} → ${plan.thinkingEffort || '默认'}`,
    );
  }
  if (plan.variantChanged) {
    lines.push(
      `  Variant: ${before.modelBackendVariant || '默认'} → ${
        plan.modelBackendVariant || '默认'
      }`,
    );
  }

  for (const note of plan.notes) lines.push(`  · ${note}`);

  if (outcome.runtimeStopped) {
    lines.push(
      '  · 已停止旧 runtime 并清空会话恢复状态，下一条消息用新 runner 重新起会话',
    );
  } else if (outcome.turnWasActive) {
    lines.push('  · 当前 turn 仍在用旧配置执行，下一轮生效');
  } else {
    lines.push('  · 下一条消息即使用新配置');
  }

  return lines.join('\n');
}
