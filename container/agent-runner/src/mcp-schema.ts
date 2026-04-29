import { z } from 'zod';

function zodFromPropertySchema(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return z.unknown();
  }
  const typed = schema as Record<string, unknown>;
  const enumValues = Array.isArray(typed.enum) ? typed.enum : undefined;
  if (enumValues && enumValues.every((value) => typeof value === 'string')) {
    return enumValues.length > 0
      ? z.enum(enumValues as [string, ...string[]])
      : z.string();
  }
  switch (typed.type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(z.unknown());
    case 'object':
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

export function convertJsonSchemaToZod(
  schema: Record<string, unknown>,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const properties =
    schema.properties &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : [];

  for (const [key, propertySchema] of Object.entries(properties)) {
    const converted = zodFromPropertySchema(propertySchema);
    shape[key] = required.includes(key) ? converted : converted.optional();
  }

  return z.object(shape);
}
