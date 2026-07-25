type RunnerProfileSchema = Record<string, unknown> | null | undefined;

const FALLBACK_THINKING_EFFORTS = ['low', 'medium', 'high'];

const THINKING_EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
};

function normalizeEfforts(
  values: readonly unknown[] | null | undefined,
): string[] {
  if (!values) return [];
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => /^[a-z][a-z0-9_-]{0,31}$/u.test(value)),
    ),
  );
}

function effortsFromSchema(schema: RunnerProfileSchema): string[] {
  const properties =
    schema?.properties &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : undefined;
  const property = properties?.thinkingEffort ?? properties?.thinking_effort;
  if (!property || typeof property !== 'object' || Array.isArray(property)) {
    return [];
  }
  return normalizeEfforts((property as { enum?: unknown[] }).enum);
}

export function isThinkingEffortSupported(
  effort: string | null | undefined,
  supportedEfforts?: readonly string[] | null,
): boolean {
  if (!effort || effort === '__default__') return true;
  if (supportedEfforts === undefined || supportedEfforts === null) return true;
  return normalizeEfforts(supportedEfforts).includes(effort);
}

export function thinkingEffortOptionsFromSchema(
  schema: RunnerProfileSchema,
  currentValue?: string | null,
  modelSupportedEfforts?: readonly string[] | null,
): Array<{ value: string; label: string; disabled?: boolean }> {
  const hasModelCapabilities =
    modelSupportedEfforts !== undefined && modelSupportedEfforts !== null;
  const supportedValues = normalizeEfforts(modelSupportedEfforts);
  const schemaValues = effortsFromSchema(schema);
  const values = hasModelCapabilities
    ? schemaValues.length > 0
      ? supportedValues.filter((value) => schemaValues.includes(value))
      : supportedValues
    : schemaValues.length > 0
      ? schemaValues
      : [...FALLBACK_THINKING_EFFORTS];
  const normalizedCurrent =
    currentValue && currentValue !== '__default__' ? currentValue : '';
  const unsupportedCurrent =
    hasModelCapabilities &&
    normalizedCurrent &&
    !values.includes(normalizedCurrent)
      ? normalizedCurrent
      : '';
  if (
    !hasModelCapabilities &&
    normalizedCurrent &&
    !values.includes(normalizedCurrent)
  ) {
    values.push(normalizedCurrent);
  }
  return [
    ...(hasModelCapabilities && supportedValues.length > 0
      ? []
      : [{ value: '__default__', label: 'Default' }]),
    ...values.map((value) => ({
      value,
      label: THINKING_EFFORT_LABELS[value] ?? value,
    })),
    ...(unsupportedCurrent
      ? [
          {
            value: unsupportedCurrent,
            label: `${THINKING_EFFORT_LABELS[unsupportedCurrent] ?? unsupportedCurrent}（当前模型不支持）`,
            disabled: true,
          },
        ]
      : []),
  ];
}
