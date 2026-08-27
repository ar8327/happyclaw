import assert from 'node:assert/strict';

import {
  buildModelConfigCard,
  MODEL_CARD_DEFAULT_VALUE,
} from './feishu-card-builder.js';
import { parseModelCardAction } from './model-card-actions.js';
import {
  availableEfforts,
  availableVariants,
  findModelChoice,
  findRunnerOption,
  formatModelList,
  formatModelStatus,
  parseModelCommandArgs,
  resolveModelChange,
  tokenizeModelArgs,
  type ModelConfigSnapshot,
} from './model-command.js';

function snapshot(
  overrides: Partial<ModelConfigSnapshot> = {},
): ModelConfigSnapshot {
  return {
    sessionId: 'main:demo',
    sessionKind: 'main',
    locationLine: 'Demo / 主会话',
    runnerId: 'claude',
    model: null,
    thinkingEffort: null,
    modelBackendVariant: null,
    profileId: null,
    profileName: null,
    profileModel: null,
    profileThinkingEffort: null,
    profileModelBackendVariant: null,
    turnActive: false,
    runners: [
      {
        id: 'claude',
        label: 'Claude',
        available: true,
        defaultModel: 'opus',
        models: [
          { id: 'haiku', label: 'Haiku' },
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
        schemaEfforts: ['low', 'medium', 'high'],
        schemaVariants: [],
      },
      {
        id: 'codex',
        label: 'Codex',
        available: false,
        unavailableReason: '未检测到可用凭据',
        defaultModel: 'gpt-5.4',
        models: [
          {
            id: 'gpt-5.4',
            label: 'GPT-5.4',
            supportedThinkingEfforts: ['low', 'medium', 'high', 'xhigh'],
          },
          {
            id: 'gpt-5.6-sol',
            label: 'GPT-5.6-Sol',
            supportedThinkingEfforts: ['medium', 'high'],
            backendVariants: [
              { id: 'standard', label: 'Standard' },
              { id: 'max', label: 'Max' },
            ],
          },
        ],
        schemaEfforts: ['low', 'medium', 'high', 'xhigh'],
        schemaVariants: ['standard', 'max'],
      },
      {
        id: 'agy',
        label: 'Antigravity',
        available: true,
        defaultModel: 'Gemini 3.1 Pro (High)',
        models: [
          { id: 'Gemini 3.1 Pro (High)' },
          { id: 'Gemini 3.1 Pro (Low)' },
        ],
        schemaEfforts: [],
        schemaVariants: [],
      },
    ],
    ...overrides,
  };
}

function setIntent(raw: string) {
  const intent = parseModelCommandArgs(raw);
  assert.equal(intent.kind, 'set', `expected a set intent for "${raw}"`);
  return intent as Extract<typeof intent, { kind: 'set' }>;
}

// ─── Tokenizing ────────────────────────────────────────────────

function testTokenize(): void {
  assert.deepEqual(tokenizeModelArgs('claude opus'), ['claude', 'opus']);
  assert.deepEqual(tokenizeModelArgs('  effort:high  '), ['effort:high']);
  // Model ids with spaces and parentheses must survive when quoted.
  assert.deepEqual(tokenizeModelArgs('agy "Gemini 3.1 Pro (High)"'), [
    'agy',
    'Gemini 3.1 Pro (High)',
  ]);
  assert.deepEqual(tokenizeModelArgs(''), []);
}

// ─── Parsing ───────────────────────────────────────────────────

function testParsing(): void {
  assert.deepEqual(parseModelCommandArgs(''), { kind: 'status' });
  assert.deepEqual(parseModelCommandArgs('help'), { kind: 'help' });
  assert.deepEqual(parseModelCommandArgs('list'), {
    kind: 'list',
    runner: undefined,
  });
  assert.deepEqual(parseModelCommandArgs('list codex'), {
    kind: 'list',
    runner: 'codex',
  });
  assert.deepEqual(parseModelCommandArgs('reset'), { kind: 'reset' });

  assert.deepEqual(setIntent('opus').positional, ['opus']);
  assert.deepEqual(setIntent('effort high').set, { effort: 'high' });
  assert.deepEqual(setIntent('effort:high').set, { effort: 'high' });
  assert.deepEqual(setIntent('effort default').set, { effort: null });
  assert.deepEqual(setIntent('variant=max').set, { variant: 'max' });
  assert.deepEqual(setIntent('runner codex').set, { runner: 'codex' });

  const combined = setIntent('claude opus effort:high');
  assert.deepEqual(combined.set, { effort: 'high' });
  assert.deepEqual(combined.positional, ['claude', 'opus']);

  const missing = parseModelCommandArgs('effort');
  assert.equal(missing.kind, 'error');
}

// ─── Change resolution ─────────────────────────────────────────

function testBareModelInCurrentRunner(): void {
  const result = resolveModelChange(snapshot(), setIntent('sonnet'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.runnerId, 'claude');
  assert.equal(result.plan.runnerChanged, false);
  assert.equal(result.plan.model, 'sonnet');
  assert.equal(result.plan.requiresRuntimeReset, false);
}

function testModelInfersRunner(): void {
  // gpt-5.4 only exists in the codex catalog, so the runner follows the model.
  const result = resolveModelChange(snapshot(), setIntent('gpt-5.4'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.runnerId, 'codex');
  assert.equal(result.plan.runnerChanged, true);
  assert.equal(result.plan.model, 'gpt-5.4');
  // A runner swap invalidates provider session state.
  assert.equal(result.plan.requiresRuntimeReset, true);
  // An unauthenticated runner is still allowed, but is called out.
  assert.ok(result.plan.notes.some((note) => note.includes('不可用')));
}

function testExplicitRunnerAndModel(): void {
  const result = resolveModelChange(snapshot(), setIntent('codex gpt-5.6-sol'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.runnerId, 'codex');
  assert.equal(result.plan.model, 'gpt-5.6-sol');
}

function testQuotedModelWithSpaces(): void {
  const result = resolveModelChange(
    snapshot(),
    setIntent('agy "Gemini 3.1 Pro (Low)"'),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.runnerId, 'agy');
  assert.equal(result.plan.model, 'Gemini 3.1 Pro (Low)');
}

function testRunnerOnlyDropsStaleModel(): void {
  // The old override belongs to the old catalog; keeping it would hand the new
  // runner a model it has never heard of.
  const result = resolveModelChange(
    snapshot({ model: 'sonnet' }),
    setIntent('runner codex'),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.runnerId, 'codex');
  assert.equal(result.plan.model, null);
}

function testAmbiguousModelIsRejected(): void {
  const ambiguous = snapshot();
  ambiguous.runners[2].models.push({ id: 'sonnet' });
  const result = resolveModelChange(ambiguous, setIntent('sonnet'));
  // The current runner owns it, so preference resolves the ambiguity.
  assert.equal(result.ok, true);

  const fromCodex = snapshot({ runnerId: 'codex' });
  fromCodex.runners[2].models.push({ id: 'sonnet' });
  const conflict = resolveModelChange(fromCodex, setIntent('sonnet'));
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.match(conflict.message, /多个 runner/);
}

function testForeignModelRejected(): void {
  const result = resolveModelChange(snapshot(), setIntent('claude gpt-5.4'));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /属于 runner "codex"/);
}

function testUnknownModelAccepted(): void {
  // Catalogs can be cold (codex reads an on-disk cache), so an unknown id is
  // written through rather than refused.
  const result = resolveModelChange(
    snapshot(),
    setIntent('claude claude-opus-4-5-20251101'),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.model, 'claude-opus-4-5-20251101');
  assert.ok(result.plan.notes.some((note) => note.includes('按原样写入')));
}

function testEffortValidation(): void {
  const ok = resolveModelChange(snapshot(), setIntent('effort high'));
  assert.equal(ok.ok, true);

  // claude's profile schema stops at high.
  const bad = resolveModelChange(snapshot(), setIntent('effort xhigh'));
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.message, /low \/ medium \/ high/);

  const cleared = resolveModelChange(
    snapshot({ thinkingEffort: 'high' }),
    setIntent('effort default'),
  );
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  assert.equal(cleared.plan.thinkingEffort, null);
}

function testEffortResetWhenModelStopsSupportingIt(): void {
  // gpt-5.6-sol supports medium/high only, so a carried-over "low" is dropped.
  const result = resolveModelChange(
    snapshot({ runnerId: 'codex', model: 'gpt-5.4', thinkingEffort: 'low' }),
    setIntent('gpt-5.6-sol'),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.thinkingEffort, null);
  assert.ok(result.plan.notes.some((note) => note.includes('effort')));
}

function testVariantHandling(): void {
  const base = snapshot({ runnerId: 'codex', model: 'gpt-5.6-sol' });
  const ok = resolveModelChange(base, setIntent('variant max'));
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.plan.modelBackendVariant, 'max');

  const bad = resolveModelChange(base, setIntent('variant turbo'));
  assert.equal(bad.ok, false);

  // Changing the model invalidates a variant chosen for the previous one.
  const carried = resolveModelChange(
    snapshot({
      runnerId: 'codex',
      model: 'gpt-5.6-sol',
      modelBackendVariant: 'max',
    }),
    setIntent('gpt-5.4'),
  );
  assert.equal(carried.ok, true);
  if (!carried.ok) return;
  assert.equal(carried.plan.modelBackendVariant, null);
}

function testResetAndNoop(): void {
  const reset = resolveModelChange(
    snapshot({ model: 'sonnet', thinkingEffort: 'high' }),
    { kind: 'reset' },
  );
  assert.equal(reset.ok, true);
  if (!reset.ok) return;
  assert.equal(reset.plan.model, null);
  assert.equal(reset.plan.thinkingEffort, null);
  assert.equal(reset.plan.runnerId, 'claude');

  const noop = resolveModelChange(
    snapshot({ model: 'sonnet' }),
    setIntent('sonnet'),
  );
  assert.equal(noop.ok, false);
  if (noop.ok) return;
  assert.equal(noop.message, '配置没有变化');
}

// ─── Option derivation ─────────────────────────────────────────

function testOptionDerivation(): void {
  const snap = snapshot({ runnerId: 'codex' });
  const runner = findRunnerOption(snap, 'codex');
  const sol = findModelChoice(runner, 'gpt-5.6-sol');
  assert.deepEqual(availableEfforts(runner, sol), ['medium', 'high']);
  assert.deepEqual(
    availableVariants(runner, sol).map((variant) => variant.id),
    ['standard', 'max'],
  );

  // No per-model capabilities and no schema → the shared fallback.
  const agy = findRunnerOption(snap, 'agy');
  assert.deepEqual(availableEfforts(agy, undefined), ['low', 'medium', 'high']);
  assert.deepEqual(availableVariants(agy, undefined), []);
}

// ─── Rendering ─────────────────────────────────────────────────

function testRendering(): void {
  const status = formatModelStatus(snapshot({ model: 'sonnet' }));
  for (const expected of ['Runner', 'sonnet', 'Effort', '/model list']) {
    assert.ok(status.includes(expected), `status missing ${expected}`);
  }
  // An inherited value is shown as the resolved default, not as blank.
  assert.ok(formatModelStatus(snapshot()).includes('opus（继承）'));

  const list = formatModelList(snapshot());
  assert.ok(list.includes('Claude (claude)'));
  assert.ok(list.includes('⚠️'), 'unavailable runner should be flagged');

  const codexList = formatModelList(snapshot(), 'codex');
  assert.ok(codexList.includes('gpt-5.6-sol'));
  assert.ok(codexList.includes('variant: standard/max'));

  assert.match(formatModelList(snapshot(), 'nope'), /未知 runner/);
}

function testCardBuild(): void {
  const card = buildModelConfigCard({
    locationLine: 'Demo / 主会话',
    summaryLines: ['**Runner** Claude'],
    fields: [
      {
        field: 'runner',
        label: 'Runner',
        placeholder: '选择 Runner',
        selected: 'claude',
        options: [{ value: 'claude', label: 'Claude' }],
      },
      // An empty field must not emit a select with zero options.
      {
        field: 'variant',
        label: 'Variant',
        placeholder: '选择变体',
        selected: null,
        options: [],
      },
    ],
    actionValue: {
      action: 'model_config',
      jid: 'feishu:oc_x',
      session: 'main:demo',
    },
  });
  const serialized = JSON.stringify(card);
  assert.ok(serialized.includes('select_static'));
  assert.ok(serialized.includes('hc_model_runner'));
  assert.ok(!serialized.includes('hc_model_variant'));
  assert.ok(serialized.includes('"initial_option":"claude"'));
  assert.equal((card as { schema?: string }).schema, '2.0');
}

// ─── Card callbacks ────────────────────────────────────────────

function testCardActionParsing(): void {
  const base = {
    action: 'model_config',
    jid: 'feishu:oc_x',
    target: 'web:feishu-topic-abc',
    session: 'main:flow-feishu-topic-abc',
    field: 'model',
  };

  assert.deepEqual(
    parseModelCardAction({ action: { value: base, option: 'sonnet' } }),
    {
      field: 'model',
      value: 'sonnet',
      sessionId: 'main:flow-feishu-topic-abc',
      chatJid: 'feishu:oc_x',
      // The routed JID must round-trip or a click would land on the parent chat.
      targetJid: 'web:feishu-topic-abc',
    },
  );

  // Inside a form container the selection arrives under form_value instead.
  assert.deepEqual(
    parseModelCardAction({
      action: { value: base, form_value: { hc_model_model: 'opus' } },
    }),
    {
      field: 'model',
      value: 'opus',
      sessionId: 'main:flow-feishu-topic-abc',
      chatJid: 'feishu:oc_x',
      targetJid: 'web:feishu-topic-abc',
    },
  );

  // Reset carries no selection.
  assert.deepEqual(
    parseModelCardAction({ action: { value: { ...base, field: 'reset' } } }),
    {
      field: 'reset',
      value: null,
      sessionId: 'main:flow-feishu-topic-abc',
      chatJid: 'feishu:oc_x',
      targetJid: 'web:feishu-topic-abc',
    },
  );

  // Cards posted before the routed JID was embedded must still resolve.
  assert.deepEqual(
    parseModelCardAction({
      action: {
        value: {
          action: 'model_config',
          jid: 'feishu:oc_x',
          session: 'main:demo',
          field: 'effort',
        },
        option: 'high',
      },
    }),
    {
      field: 'effort',
      value: 'high',
      sessionId: 'main:demo',
      chatJid: 'feishu:oc_x',
      targetJid: null,
    },
  );

  // Foreign actions fall through to the other card handlers.
  assert.equal(
    parseModelCardAction({
      action: { value: { action: 'stop_turn', action_id: 'x' } },
    }),
    null,
  );
  assert.equal(parseModelCardAction({ action: { value: 'oops' } }), null);
  assert.equal(parseModelCardAction({}), null);
  // Missing routing context must not resolve to a half-specified request.
  assert.equal(
    parseModelCardAction({
      action: { value: { action: 'model_config', field: 'model' } },
    }),
    null,
  );

  assert.equal(MODEL_CARD_DEFAULT_VALUE, '__default__');
}

testTokenize();
testParsing();
testBareModelInCurrentRunner();
testModelInfersRunner();
testExplicitRunnerAndModel();
testQuotedModelWithSpaces();
testRunnerOnlyDropsStaleModel();
testAmbiguousModelIsRejected();
testForeignModelRejected();
testUnknownModelAccepted();
testEffortValidation();
testEffortResetWhenModelStopsSupportingIt();
testVariantHandling();
testResetAndNoop();
testOptionDerivation();
testRendering();
testCardBuild();
testCardActionParsing();
console.log('model command tests passed');
