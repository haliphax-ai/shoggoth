import type { DependencyGraph, TaskState, TemplateRef } from "./types.js";
import { getTransitiveDeps } from "./graph.js";

const TEMPLATE_RE = /\{\{task:(\d+):(output|success)\}\}/g;

/**
 * Parse template references from a prompt string.
 * Returns all `{{task:N:output}}` and `{{task:N:success}}` refs found.
 */
export function parseTemplateRefs(prompt: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  let match: RegExpExecArray | null;

  // Reset lastIndex since we reuse the regex
  TEMPLATE_RE.lastIndex = 0;
  while ((match = TEMPLATE_RE.exec(prompt)) !== null) {
    const taskId = Number(match[1]);
    const kind = match[2] as "output" | "success";
    refs.push({ kind, taskId });
  }

  return refs;
}

/**
 * Validate that all template references in a task's prompt point to
 * direct or transitive dependencies of that task.
 * Throws if a reference points to a non-dependency.
 */
export function validateTemplateRefs(
  taskId: number,
  refs: TemplateRef[],
  graph: DependencyGraph,
): void {
  if (refs.length === 0) return;

  const transitiveDeps = getTransitiveDeps(graph, taskId);
  const directDeps = graph.get(taskId) ?? new Set<number>();
  const allDeps = new Set([...directDeps, ...transitiveDeps]);

  for (const ref of refs) {
    if (!allDeps.has(ref.taskId)) {
      throw new Error(
        `Task ${taskId} references {{task:${ref.taskId}:${ref.kind}}} but task ${ref.taskId} is not a direct or transitive dependency`,
      );
    }
  }
}

/**
 * Resolve template strings in a prompt using completed task states.
 * Substitutes `{{task:N:output}}` with the task's output and
 * `{{task:N:success}}` with "true"/"false" based on status.
 */
export function resolveTemplates(
  prompt: string,
  tasks: Map<number, TaskState>,
): string {
  TEMPLATE_RE.lastIndex = 0;
  return prompt.replace(TEMPLATE_RE, (fullMatch, idStr, kind) => {
    const taskId = Number(idStr);
    const task = tasks.get(taskId);

    if (!task) return fullMatch;

    if (kind === "output") {
      return task.output ?? "";
    }

    if (kind === "success") {
      return task.status === "done" ? "true" : "false";
    }

    return fullMatch;
  });
}
