import type { TaskList, TaskState } from "./types.js";
import { formatDuration } from "./format.js";

const STATUS_EMOJI: Record<TaskState["status"], string> = {
  pending: "⏳",
  in_progress: "🚀",
  paused: "⏸️",
  done: "✅",
  failed: "❌",
};

function taskDuration(task: TaskState, now?: number): string | null {
  if (task.startedAt == null) return null;
  const end = task.completedAt ?? now ?? Date.now();
  return formatDuration(end - task.startedAt);
}

function formatTaskLine(task: TaskState, deps: Set<number>, now?: number): string {
  const emoji = STATUS_EMOJI[task.status];
  const id = task.taskDef.id;
  const depStr = deps.size > 0 ? ` [${[...deps].sort((a, b) => a - b).join(",")}]` : "";
  const dur = taskDuration(task, now);
  const durStr = dur != null ? ` (${dur})` : "";
  return `${emoji} ${id}${depStr} - ${task.taskDef.prompt}${durStr}`;
}

/**
 * Format the live status message for a workflow.
 * Pass `now` to pin the current time (useful for tests).
 */
export function formatStatusMessage(wf: TaskList, now?: number): string {
  const lines = [`**Task workflow:** ${wf.name}`, ""];
  for (const task of wf.tasks) {
    const deps = wf.graph.get(task.taskDef.id) ?? new Set<number>();
    lines.push(formatTaskLine(task, deps, now));
  }
  return lines.join("\n");
}

/**
 * Format the summarization message posted when a workflow completes.
 */
export function formatSummaryMessage(wf: TaskList): string {
  const total = wf.tasks.length;
  const failed = wf.tasks.filter((t) => t.status === "failed");
  const completed = total - failed.length;

  // Total duration: createdAt → last completedAt
  const lastCompleted = Math.max(...wf.tasks.map((t) => t.completedAt ?? 0));
  const totalDuration = formatDuration(lastCompleted - wf.createdAt);

  const lines = [
    `**Task workflow complete:** ${wf.name}`,
    `⏱️ **Duration:** ${totalDuration}`,
    `✅ **Completed:** ${completed}/${total}`,
  ];

  if (failed.length > 0) {
    lines.push(`❌ **Failed:** ${failed.length}/${total}`);
    for (const t of failed) {
      const dur = taskDuration(t);
      const durStr = dur != null ? ` (${dur})` : "";
      lines.push(`- ${t.taskDef.id} - ${t.taskDef.prompt}${durStr}`);
    }
  }

  return lines.join("\n");
}
