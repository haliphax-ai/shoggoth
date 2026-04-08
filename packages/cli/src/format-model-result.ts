/** Format a session_model control op result for CLI display. */
export function formatModelResult(r: Record<string, unknown>): string {
  const sessionId = r.session_id as string;
  const modelSelection = r.model_selection;
  const effectiveModels = r.effective_models as Record<string, unknown> | null;
  const lines: string[] = [
    `Model Configuration`,
    `Session: ${sessionId}`,
  ];
  if (modelSelection !== null && modelSelection !== undefined) {
    lines.push(`Selection: ${typeof modelSelection === "string" ? modelSelection : JSON.stringify(modelSelection)}`);
  } else {
    lines.push(`Selection: (using default)`);
  }
  if (effectiveModels) {
    const provider = effectiveModels.providerId as string | undefined;
    const model = effectiveModels.model as string | undefined;
    if (provider && model) {
      lines.push(`Effective: ${provider}/${model}`);
    }
  }
  return lines.join("\n");
}
