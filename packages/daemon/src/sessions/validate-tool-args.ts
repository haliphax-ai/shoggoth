/**
 * Lightweight JSON Schema validation for tool call arguments.
 *
 * Validates parsed args against the tool's `inputSchema` (JsonSchemaLike).
 * Catches the most common model mistakes: missing required fields, wrong
 * top-level types, and malformed JSON — without pulling in ajv or similar.
 */

interface SchemaLike {
  readonly type?: string;
  readonly properties?: Record<string, SchemaLike>;
  readonly items?: SchemaLike;
  readonly required?: readonly string[];
  readonly enum?: readonly unknown[];
  readonly minimum?: number;
  readonly maximum?: number;
}

interface ToolArgValidationError {
  readonly field: string;
  readonly message: string;
}

/**
 * Validate `args` against `schema`. Returns an empty array when valid.
 *
 * Checks performed:
 * - Top-level type must be "object" (or absent) and args must be a plain object
 * - All `required` fields must be present and not undefined
 * - Per-property: basic type check (string, number, integer, boolean, array, object)
 * - Per-property: enum membership (type-coercive for string↔number)
 * - Per-property: minimum / maximum for numbers
 */
export function validateToolArgs(
  args: Record<string, unknown>,
  schema: SchemaLike,
): ToolArgValidationError[] {
  const errors: ToolArgValidationError[] = [];

  // Top-level must be object-shaped
  if (schema.type && schema.type !== "object") {
    errors.push({
      field: "(root)",
      message: `expected top-level type "object", schema declares "${schema.type}"`,
    });
    return errors;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    errors.push({ field: "(root)", message: "arguments must be a JSON object" });
    return errors;
  }

  // Required fields
  if (schema.required) {
    for (const key of schema.required) {
      if (!(key in args) || args[key] === undefined) {
        errors.push({ field: key, message: "required field is missing" });
      }
    }
  }

  // Per-property checks
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (!(key in args) || args[key] === undefined) continue; // optional and absent
      const value = args[key];
      validateProperty(key, value, propSchema, errors);
    }
  }

  return errors;
}

function validateProperty(
  field: string,
  value: unknown,
  schema: SchemaLike,
  errors: ToolArgValidationError[],
): void {
  // Type check
  if (schema.type) {
    if (!matchesType(value, schema.type)) {
      errors.push({ field, message: `expected type "${schema.type}", got ${describeType(value)}` });
      return; // skip further checks on type mismatch
    }
  }

  // Enum check — type-coercive for string↔number to handle Gemini string coercion
  if (schema.enum) {
    const match = schema.enum.some(
      (allowed) =>
        allowed === value ||
        (typeof allowed === "number" && typeof value === "string" && String(allowed) === value) ||
        (typeof allowed === "string" && typeof value === "number" && allowed === String(value)),
    );
    if (!match) {
      const allowed = schema.enum.map((v) => JSON.stringify(v)).join(", ");
      errors.push({ field, message: `value ${JSON.stringify(value)} is not one of: ${allowed}` });
    }
  }

  // Numeric bounds
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push({ field, message: `value ${value} is below minimum ${schema.minimum}` });
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push({ field, message: `value ${value} exceeds maximum ${schema.maximum}` });
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true; // unknown type — don't block
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
