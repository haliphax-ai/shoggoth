import fs from "node:fs";
import path from "node:path";
import type { TaskList, TaskState, DependencyGraph } from "./types.js";

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
  };
}

function statePath(baseDir: string, workflowId: string): string {
  return path.join(baseDir, `${workflowId}.json`);
}

// --- Public API ---

export function saveWorkflow(baseDir: string, wf: TaskList): void {
  fs.mkdirSync(baseDir, { recursive: true });
  const data = JSON.stringify(serialize(wf), null, 2);
  fs.writeFileSync(statePath(baseDir, wf.id), data, "utf-8");
}

export function loadWorkflow(baseDir: string, workflowId: string): TaskList | undefined {
  const fp = statePath(baseDir, workflowId);
  if (!fs.existsSync(fp)) return undefined;
  const raw: SerializedWorkflow = JSON.parse(fs.readFileSync(fp, "utf-8"));
  return deserialize(raw);
}

export function deleteWorkflow(baseDir: string, workflowId: string): void {
  const fp = statePath(baseDir, workflowId);
  try {
    fs.unlinkSync(fp);
  } catch {
    // ignore if not found
  }
}

function isTerminal(status: TaskState["status"]): boolean {
  return status === "done" || status === "failed";
}

export function listIncompleteWorkflows(baseDir: string): TaskList[] {
  if (!fs.existsSync(baseDir)) return [];

  const files = fs.readdirSync(baseDir).filter((f) => f.endsWith(".json"));
  const incomplete: TaskList[] = [];

  for (const file of files) {
    const fp = path.join(baseDir, file);
    try {
      const raw: SerializedWorkflow = JSON.parse(fs.readFileSync(fp, "utf-8"));
      const wf = deserialize(raw);
      const allTerminal = wf.tasks.every((t) => isTerminal(t.status));
      if (!allTerminal) incomplete.push(wf);
    } catch {
      // skip corrupt files
    }
  }

  return incomplete;
}

export function listAllWorkflows(baseDir: string): TaskList[] {
  if (!fs.existsSync(baseDir)) return [];

  const files = fs.readdirSync(baseDir).filter((f) => f.endsWith(".json"));
  const workflows: TaskList[] = [];

  for (const file of files) {
    const fp = path.join(baseDir, file);
    try {
      const raw: SerializedWorkflow = JSON.parse(fs.readFileSync(fp, "utf-8"));
      workflows.push(deserialize(raw));
    } catch {
      // skip corrupt files
    }
  }

  return workflows;
}
