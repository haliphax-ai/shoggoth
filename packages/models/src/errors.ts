export class ModelHttpError extends Error {
  readonly status: number;
  readonly bodySnippet?: string;

  constructor(status: number, message: string, bodySnippet?: string) {
    super(message);
    this.name = "ModelHttpError";
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

/**
 * Thrown when a model provider returns a successful HTTP response but the
 * response body contains no assistant content and no tool calls. This is
 * common with free-tier OpenRouter models that occasionally return empty
 * completions. Extends ModelHttpError with status 502 so existing failover
 * and retry classification treats it as retryable.
 */
export class EmptyModelResponseError extends ModelHttpError {
  constructor(bodySnippet?: string) {
    super(502, "missing assistant content and tool_calls", bodySnippet);
    this.name = "EmptyModelResponseError";
  }
}

/**
 * Thrown when a model request (or its SSE response stream) is aborted via the
 * caller-supplied `AbortSignal`. The response stream is cancelled immediately
 * instead of being drained. Not failover-eligible: an aborted turn must stop,
 * not hop to the next provider.
 */
export class ModelRequestAbortedError extends Error {
  constructor(message = "model request aborted") {
    super(message);
    this.name = "ModelRequestAbortedError";
  }
}
