export interface ProfileValidationResult {
  ok: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function schemaTypes(schema: Record<string, unknown>): string[] {
  const rawType = schema.type;
  if (Array.isArray(rawType)) {
    return rawType.filter((item): item is string => typeof item === 'string');
  }
  return typeof rawType === 'string' ? [rawType] : [];
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number';
  if (expected === 'object') return isRecord(value);
  if (expected === 'array') return Array.isArray(value);
  return jsonType(value) === expected;
}

function numberSchemaValue(
  schema: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = schema[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function validateStringConstraints(
  value: string,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const minLength = numberSchemaValue(schema, 'minLength');
  if (minLength !== undefined && value.length < minLength) {
    errors.push(`${path} 长度不能小于 ${minLength}`);
  }
  const maxLength = numberSchemaValue(schema, 'maxLength');
  if (maxLength !== undefined && value.length > maxLength) {
    errors.push(`${path} 长度不能大于 ${maxLength}`);
  }
  if (typeof schema.pattern === 'string') {
    try {
      if (!new RegExp(schema.pattern).test(value)) {
        errors.push(`${path} 格式不匹配`);
      }
    } catch {
      errors.push(`${path} 的 schema pattern 无效`);
    }
  }
}

function validateNumberConstraints(
  value: number,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const minimum = numberSchemaValue(schema, 'minimum');
  if (minimum !== undefined && value < minimum) {
    errors.push(`${path} 不能小于 ${minimum}`);
  }
  const maximum = numberSchemaValue(schema, 'maximum');
  if (maximum !== undefined && value > maximum) {
    errors.push(`${path} 不能大于 ${maximum}`);
  }
  const exclusiveMinimum = numberSchemaValue(schema, 'exclusiveMinimum');
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
    errors.push(`${path} 必须大于 ${exclusiveMinimum}`);
  }
  const exclusiveMaximum = numberSchemaValue(schema, 'exclusiveMaximum');
  if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) {
    errors.push(`${path} 必须小于 ${exclusiveMaximum}`);
  }
  const multipleOf = numberSchemaValue(schema, 'multipleOf');
  if (multipleOf !== undefined && multipleOf > 0) {
    const quotient = value / multipleOf;
    if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 100) {
      errors.push(`${path} 必须是 ${multipleOf} 的倍数`);
    }
  }
}

function validateArrayConstraints(
  value: unknown[],
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const minItems = numberSchemaValue(schema, 'minItems');
  if (minItems !== undefined && value.length < minItems) {
    errors.push(`${path} 至少需要 ${minItems} 项`);
  }
  const maxItems = numberSchemaValue(schema, 'maxItems');
  if (maxItems !== undefined && value.length > maxItems) {
    errors.push(`${path} 最多只能有 ${maxItems} 项`);
  }
  if (schema.uniqueItems === true) {
    const seen = new Set(value.map((item) => JSON.stringify(item)));
    if (seen.size !== value.length) {
      errors.push(`${path} 不允许重复项`);
    }
  }
}

function validateValue(
  value: unknown,
  schema: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(schema)) return;

  const expectedTypes = schemaTypes(schema);
  if (
    expectedTypes.length > 0 &&
    !expectedTypes.some((type) => typeMatches(value, type))
  ) {
    errors.push(`${path} 必须是 ${expectedTypes.join(' 或 ')}`);
    return;
  }

  const allowed = schema.enum;
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    errors.push(`${path} 不在允许范围内`);
    return;
  }

  if (typeof value === 'string') {
    validateStringConstraints(value, schema, path, errors);
  }

  if (typeof value === 'number') {
    validateNumberConstraints(value, schema, path, errors);
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    for (const key of required) {
      if (value[key] === undefined) errors.push(`${path}.${key} 是必填项`);
    }
    for (const [key, childValue] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema) {
        validateValue(childValue, childSchema, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} 不允许出现`);
      } else if (isRecord(schema.additionalProperties)) {
        validateValue(
          childValue,
          schema.additionalProperties,
          `${path}.${key}`,
          errors,
        );
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    validateArrayConstraints(value, schema, path, errors);
    value.forEach((item, index) => {
      validateValue(item, schema.items, `${path}[${index}]`, errors);
    });
  } else if (Array.isArray(value)) {
    validateArrayConstraints(value, schema, path, errors);
  }
}

export function validateRunnerProfileConfig(
  schema: Record<string, unknown> | undefined,
  config: unknown,
): ProfileValidationResult {
  const errors: string[] = [];
  if (!isRecord(config)) {
    return { ok: false, errors: ['config_json 必须是 JSON object'] };
  }
  if (schema) {
    validateValue(config, schema, 'config_json', errors);
  }
  return { ok: errors.length === 0, errors };
}
