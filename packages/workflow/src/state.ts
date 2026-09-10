import fs from "node:fs/promises";
import path from "node:path";
import type { TaskList, TaskState, DependencyGraph } from "./types.js";
import { isTerminal } from "./types.js";

// --- Serialization helpers (Map ↔ JSON) ---

interface SerializedGraph {
  [taskId: string]: number[];
}

export interface SerializedWorkflow {
  id: string;
  name: string;
  tasks: TaskState[];
  graph: SerializedGraph;
  pollingIntervalMs: number;
  createdAt: number;
  concurrency?: number;
  runtimeLimitMs?: number;
  currentDepth?: number;
  maxDepth?: number;
  replyTo?: string;
}

function serializeGraph(graph: DependencyGraph): SerializedGraph {
  const out: SerializedGraph = {};
  for (const [id, deps] of graph) {
    out[String(id)] = [...deps];
  }
  return out;
}

function deserializeGraph(raw: SerializedGraph): DependencyGraph {
  const graph: DependencyGraph = new Map();
  for (const [idStr, deps] of Object.entries(raw)) {
    graph.set(Number(idStr), new Set(deps));
  }
  return graph;
}

function serialize(wf: TaskList): SerializedWorkflow {
  return {
    id: wf.id,
    name: wf.name,
    tasks: wf.tasks,
    graph: serializeGraph(wf.graph),
    pollingIntervalMs: wf.pollingIntervalMs,
    createdAt: wf.createdAt,
    ...(wf.concurrency ? { concurrency: wf.concurrency } : {}),
    ...(wf.runtimeLimitMs ? { runtimeLimitMs: wf.runtimeLimitMs } : {}),
    ...(wf.currentDepth != null ? { currentDepth: wf.currentDepth } : {}),
    ...(wf.maxDepth != null ? { maxDepth: wf.maxDepth } : {}),
    ...(wf.replyTo != null ? { replyTo: wf.replyTo } : {}),
  };
}

function deserialize(raw: SerializedWorkflow): TaskList {
  return {
    id: raw.id,
    name: raw.name,
    tasks: raw.tasks,
    graph: deserializeGraph(raw.graph),
    pollingIntervalMs: raw.pollingIntervalMs,
    createdAt: raw.createdAt,
    ...(raw.concurrency ? { concurrency: raw.concurrency } : {}),
    ...(raw.runtimeLimitMs ? { runtimeLimitMs: raw.runtimeLimitMs } : {}),
    ...(raw.currentDepth != null ? { currentDepth: raw.currentDepth } : {}),
    ...(raw.maxDepth != null ? { maxDepth: raw.maxDepth } : {}),
    ...(raw.replyTo != null ? { replyTo: raw.replyTo } : {}),
  };
}

function statePath(baseDir: string, workflowId: string): string {
  return path.join(baseDir, `${workflowId}.json`);
}

// --- Public API ---

export async function saveWorkflow(baseDir: string, wf: TaskList): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true });
  const data = JSON.stringify(serialize(wf), null, 2);
  await fs.writeFile(statePath(baseDir, wf.id), data, "utf-8");
}

export async function loadWorkflow(
  baseDir: string,
  workflowId: string,
): Promise<TaskList | undefined> {
  const fp = statePath(baseDir, workflowId);
  try {
    const raw: SerializedWorkflow = JSON.parse(await fs.readFile(fp, "utf-8"));
    return deserialize(raw);
  } catch {
    return undefined;
  }
}

export async function deleteWorkflow(baseDir: string, workflowId: string): Promise<void> {
  const fp = statePath(baseDir, workflowId);
  try {
    await fs.unlink(fp);
  } catch {
    // ignore if not found
  }
}

export async function listWorkflows(
  baseDir: string,
  filter?: (wf: TaskList) => boolean,
): Promise<TaskList[]> {
  let files: string[];
  try {
    const entries = await fs.readdir(baseDir);
    files = entries.filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const workflows: TaskList[] = [];

  for (const file of files) {
    const fp = path.join(baseDir, file);
    try {
      const raw: SerializedWorkflow = JSON.parse(await fs.readFile(fp, "utf-8"));
      const wf = deserialize(raw);
      if (!filter || filter(wf)) workflows.push(wf);
    } catch {
      // skip corrupt files
    }
  }

  return workflows;
}

export async function listIncompleteWorkflows(baseDir: string): Promise<TaskList[]> {
  return listWorkflows(baseDir, (wf) => !wf.tasks.every((t) => isTerminal(t.status)));
}

export async function listAllWorkflows(baseDir: string): Promise<TaskList[]> {
  return listWorkflows(baseDir);
}
