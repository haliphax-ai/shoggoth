import Ajv from "ajv";

/** Mode strength ordering for min() comparison. */
const MODE_RANK: Record<StructuredOutputMode, number> = {
  none: 0,
  "best-effort": 1,
  strict: 2,
};

export type StructuredOutputMode = "strict" | "best-effort" | "none";

export interface ValidationSuccess {
  valid: true;
  data: unknown;
}

export interface ValidationFailure {
  valid: false;
  /** Human-readable description of what went wrong. */
  error: string;
  /** Raw response content that failed validation. */
  rawContent: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

/**
 * Resolve the effective structured output mode.
 * Returns the lesser of the configured mode and the adapter's ceiling.
 */
export function resolveStructuredOutputMode(
  configured: StructuredOutputMode | undefined,
  adapterCeiling: StructuredOutputMode,
): StructuredOutputMode {
  const effective = configured ?? adapterCeiling;
  return (MODE_RANK[effective] ?? 0) <= (MODE_RANK[adapterCeiling] ?? 0)
    ? effective
    : adapterCeiling;
}

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Validate a model response against a JSON schema.
 * @param content - Raw text content from the model's final response.
 * @param schema - JSON Schema object to validate against.
 * @returns Validation result with parsed data or error details.
 */
export function validateResponseSchema(
  content: string,
  schema: Record<string, unknown>,
): ValidationResult {
  // Step 1: Parse as JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return {
      valid: false,
      error: `Response is not valid JSON: ${(e as Error).message}`,
      rawContent: content,
    };
  }

  // Step 2: Validate against schema
  const validate = ajv.compile(schema);
  if (validate(parsed)) {
    return { valid: true, data: parsed };
  }

  const errors = validate.errors?.map((e) => `${e.instancePath || "/"}: ${e.message}`).join("; ");

  return {
    valid: false,
    error: `Schema validation failed: ${errors}`,
    rawContent: content,
  };
}

export class StructuredOutputValidationError extends Error {
  constructor(
    message: string,
    /** The raw non-conformant response content. */
    public readonly rawContent: string,
    /** The schema that was violated. */
    public readonly schema: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StructuredOutputValidationError";
  }
}
