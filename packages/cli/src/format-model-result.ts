function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Format a session_model control op result for CLI display.
 * Input arrives as untrusted JSON; malformed fields are skipped.
 */
export function formatModelResult(result: unknown): string {
  const r = isRecord(result) ? result : {};
  const lines: string[] = [`Model Configuration`];
  if (typeof r.session_id === "string") {
    lines.push(`Session: ${r.session_id}`);
  }
  const modelSelection = r.model_selection;
  if (modelSelection !== null && modelSelection !== undefined) {
    lines.push(
      `Selection: ${typeof modelSelection === "string" ? modelSelection : JSON.stringify(modelSelection)}`,
    );
  } else {
    lines.push(`Selection: (using default)`);
  }
  const effectiveModels = r.effective_models;
  if (isRecord(effectiveModels)) {
    const provider = effectiveModels.providerId;
    const model = effectiveModels.model;
    if (typeof provider === "string" && typeof model === "string" && provider && model) {
      lines.push(`Effective: ${provider}/${model}`);
    }
  }
  return lines.join("\n");
}
