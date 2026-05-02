# Specification

## Interfaces

### Core response schema type — `packages/models/src/types.ts`

```ts
/** JSON Schema constraint for the model's final text response. */
export interface ResponseSchema {
  /** Schema name (required by OpenAI; used as synthetic tool name for Anthropic). */
  readonly name: string;
  /** JSON Schema object describing the desired response shape. */
  readonly schema: Record<string, unknown>;
  /** When true, the provider enforces strict conformance (OpenAI only). Defaults to true. */
  readonly strict?: boolean;
}

export interface ModelInvocationParams {
  // ... existing fields ...

  /** Optional JSON schema constraint for the model's final response. */
  readonly responseSchema?: ResponseSchema;
}
```

`ModelCompleteInput` and `ModelToolCompleteInput` already extend `ModelInvocationParams`, so they inherit `responseSchema` automatically.

### Response validation result — `packages/models/src/response-validation.ts`

```ts
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
 * Validate a model response against a JSON schema.
 * @param content - Raw text content from the model's final response.
 * @param schema - JSON Schema object to validate against.
 * @returns Validation result with parsed data or error details.
 */
export function validateResponseSchema(
  content: string,
  schema: Record<string, unknown>,
): ValidationResult;
```

### Workflow agent task — `packages/workflow/src/types.ts`

```ts
export interface AgentTaskDef extends TaskDefBase {
  kind: "agent";
  prompt: string;
  // ... existing fields ...

  /** Optional: constrain the agent's final response to this JSON schema. */
  responseSchema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}
```

### Orchestrator spawn request — `packages/workflow/src/orchestrator.ts`

```ts
export interface SpawnRequest {
  // ... existing fields ...

  /** Optional response schema forwarded to the spawned session's model selection. */
  responseSchema?: ResponseSchema;
}
```

## Schemas

### Zod config schema — `packages/shared/src/schema.ts`

```ts
const responseSchemaSchema = z
  .object({
    name: z.string().min(1),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
  })
  .strict()
  .optional();
```

Added to `shoggothModelDefaultInvocationSchema` as:

```ts
responseSchema: responseSchemaSchema,
```

### Workflow tool descriptor — `packages/workflow/src/tool-descriptor.ts`

Added to the task item `properties` object:

```ts
response_schema: {
  type: "object",
  description: "Optional: constrain the task's final response to this JSON schema.",
  properties: {
    name: { type: "string", description: "Schema name identifier." },
    schema: { type: "object", description: "JSON Schema object." },
    strict: { type: "boolean", description: "Enforce strict conformance (OpenAI only)." },
  },
  required: ["name", "schema"],
},
```

## Provider Request Mapping

### OpenAI — `packages/models/src/openai-compatible.ts`

When `responseSchema` is present, add to the request body:

```ts
if (input.responseSchema) {
  body.response_format = {
    type: "json_schema",
    json_schema: {
      name: input.responseSchema.name,
      schema: input.responseSchema.schema,
      strict: input.responseSchema.strict ?? true,
    },
  };
}
```

Applied in `applyOpenAICompatibleRequestExtensions` (or equivalent body-building section), **after** `requestExtras` spread so that the typed field takes precedence.

No post-validation needed — OpenAI with `strict: true` guarantees conformance.

### Gemini — `packages/models/src/gemini.ts`

When `responseSchema` is present, add to `generationConfig`:

```ts
if (input.responseSchema) {
  generationConfig.responseMimeType = "application/json";
  generationConfig.responseSchema = sanitizeSchemaForGemini(input.responseSchema.schema);
}
```

Uses the existing `sanitizeSchemaForGemini` helper to strip `additionalProperties`, normalize `const`/`enum`, etc.

Post-validation is applied to the final response content (see Response Validation below).

### Anthropic — `packages/models/src/anthropic-messages.ts`

Implements the synthetic tool workaround:

```ts
// Constant for the synthetic tool name prefix
const STRUCTURED_OUTPUT_TOOL_PREFIX = "__structured_output_";

function buildSyntheticTool(responseSchema: ResponseSchema): AnthropicToolDef {
  return {
    name: `${STRUCTURED_OUTPUT_TOOL_PREFIX}${responseSchema.name}`,
    description:
      "Use this tool to provide your final structured response. " +
      "Call it with your answer conforming to the schema.",
    input_schema: responseSchema.schema,
  };
}

function isSyntheticToolCall(toolCall: ToolCall): boolean {
  return toolCall.name.startsWith(STRUCTURED_OUTPUT_TOOL_PREFIX);
}
```

#### Adapter behavior in `completeWithTools`:

```ts
// 1. Inject synthetic tool into the tools list
if (input.responseSchema) {
  tools = [...tools, buildSyntheticTool(input.responseSchema)];
}

// 2. After receiving model response, classify tool calls:
const realToolCalls = response.toolCalls.filter((tc) => !isSyntheticToolCall(tc));
const syntheticCall = response.toolCalls.find((tc) => isSyntheticToolCall(tc));

if (syntheticCall && realToolCalls.length === 0) {
  // Terminal: model is done, extract structured content
  return {
    content: JSON.stringify(syntheticCall.arguments),
    toolCalls: [],
  };
} else if (syntheticCall && realToolCalls.length > 0) {
  // Mixed: strip synthetic, return only real tool calls
  // The synthetic result is discarded; the model will call it again
  // on a subsequent turn when it's truly done.
  return {
    content: response.content,
    toolCalls: realToolCalls,
  };
} else {
  // No synthetic call — model is still working with real tools,
  // OR model produced a text response without calling the synthetic tool.
  // If text-only and responseSchema is set, force the synthetic tool:
  if (input.responseSchema && response.toolCalls.length === 0) {
    // Re-invoke with tool_choice forced to the synthetic tool
    const forcedResponse = await this.complete({
      ...input,
      tool_choice: {
        type: "tool",
        name: `${STRUCTURED_OUTPUT_TOOL_PREFIX}${input.responseSchema.name}`,
      },
    });
    // Extract from forced response
    const forced = forcedResponse.toolCalls.find((tc) => isSyntheticToolCall(tc));
    if (forced) {
      return {
        content: JSON.stringify(forced.arguments),
        toolCalls: [],
      };
    }
  }
  return response;
}
```

Post-validation is applied to the extracted content (see Response Validation below).

## Response Validation

### Validator — `packages/models/src/response-validation.ts`

A shared utility that validates the model's final response against the provided schema:

```ts
import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

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
```

### Integration point

Validation is called by the adapter (or a thin wrapper around it) after producing the final response content, for Gemini and Anthropic only:

```ts
// In adapter post-processing (Gemini and Anthropic)
if (input.responseSchema && finalContent) {
  const result = validateResponseSchema(finalContent, input.responseSchema.schema);
  if (!result.valid) {
    // Return structured error — caller decides whether to retry
    throw new StructuredOutputValidationError(result.error, result.rawContent);
  }
}
```

OpenAI skips validation when `strict` is true (the default).

## Merge Logic — `packages/models/src/invocation-merge.ts`

### Parsing

`parseModelInvocationFromUnknown` recognizes `responseSchema` from raw JSON input:

```ts
if (raw.responseSchema && typeof raw.responseSchema === "object") {
  result.responseSchema = {
    name: String(raw.responseSchema.name),
    schema: raw.responseSchema.schema as Record<string, unknown>,
    strict: raw.responseSchema.strict != null ? Boolean(raw.responseSchema.strict) : undefined,
  };
}
```

### Merging

`mergeInvocations` uses overlay-wins semantics (same as other fields):

```ts
responseSchema: overlay.responseSchema ?? base.responseSchema,
```

### Session keys

Add `"responseSchema"` to the `SESSION_INVOCATION_KEYS` set so `mergeSubagentSpawnModelSelection` handles it correctly during strip/reattach.

## Daemon Spawn Adapter — `packages/daemon/src/workflow-adapters.ts`

`createDaemonSpawnAdapter` forwards `responseSchema` into the spawned session's `model_selection`:

```ts
if (request.responseSchema) {
  modelSelection.responseSchema = request.responseSchema;
}
```

## Code Examples

### Workflow task with structured output

```ts
// Inside a workflow definition (as seen by the LLM via the tool descriptor)
{
  id: 1,
  kind: "agent",
  prompt: "Analyze the error logs and return a summary.",
  response_schema: {
    name: "error_summary",
    schema: {
      type: "object",
      properties: {
        total_errors: { type: "number" },
        categories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              count: { type: "number" },
              sample_message: { type: "string" },
            },
            required: ["name", "count", "sample_message"],
          },
        },
      },
      required: ["total_errors", "categories"],
      additionalProperties: false,
    },
    strict: true,
  },
}
```

### Subagent spawn with structured output via model_options

```ts
// Spawning a subagent with responseSchema in model_options
{
  action: "spawn_one_shot",
  prompt: "List the top 5 files by size in the project.",
  model_options: {
    responseSchema: {
      name: "file_list",
      schema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                size_bytes: { type: "number" },
              },
              required: ["path", "size_bytes"],
            },
          },
        },
        required: ["files"],
        additionalProperties: false,
      },
    },
  },
}
```

### Handling validation errors

```ts
try {
  const response = await modelClient.completeWithTools(input);
  // response.content is guaranteed to be schema-conformant
} catch (e) {
  if (e instanceof StructuredOutputValidationError) {
    // e.message contains the validation error description
    // e.rawContent contains the non-conformant response
    // Caller can retry, log, or surface the error
  }
}
```
