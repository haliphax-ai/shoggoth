import type { TaskState } from "./types.js";

/**
 * Context for gate condition evaluation.
 * Built from completed upstream task states.
 */
export interface GateContext {
  task: Map<number, { output: string; success: boolean }>;
}

/**
 * Build a GateContext from a task map (only includes done/failed tasks).
 */
export function buildGateContext(tasks: Map<number, TaskState>): GateContext {
  const ctx: GateContext = { task: new Map() };
  for (const [id, t] of tasks) {
    if (t.status === "done" || t.status === "failed") {
      ctx.task.set(id, {
        output: t.output ?? "",
        success: t.status === "done",
      });
    }
  }
  return ctx;
}

// --- Tokenizer ---

type TokenType =
  | "TASK_REF"    // task.N.success or task.N.output
  | "BOOL"        // true / false
  | "STRING"      // "..." or '...'
  | "OP"          // ==, !=, &&, ||, !
  | "CONTAINS"    // contains
  | "LPAREN"      // (
  | "RPAREN"      // )
  | "EOF";

interface Token {
  type: TokenType;
  value: string;
  /** For TASK_REF: the parsed task id */
  taskId?: number;
  /** For TASK_REF: "output" or "success" */
  field?: string;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i])) { i++; continue; }

    // Parentheses
    if (expr[i] === "(") { tokens.push({ type: "LPAREN", value: "(" }); i++; continue; }
    if (expr[i] === ")") { tokens.push({ type: "RPAREN", value: ")" }); i++; continue; }

    // Two-char operators
    if (expr[i] === "=" && expr[i + 1] === "=") { tokens.push({ type: "OP", value: "==" }); i += 2; continue; }
    if (expr[i] === "!" && expr[i + 1] === "=") { tokens.push({ type: "OP", value: "!=" }); i += 2; continue; }
    if (expr[i] === "&" && expr[i + 1] === "&") { tokens.push({ type: "OP", value: "&&" }); i += 2; continue; }
    if (expr[i] === "|" && expr[i + 1] === "|") { tokens.push({ type: "OP", value: "||" }); i += 2; continue; }

    // Single-char ! (negation)
    if (expr[i] === "!") { tokens.push({ type: "OP", value: "!" }); i++; continue; }

    // String literals
    if (expr[i] === '"' || expr[i] === "'") {
      const quote = expr[i];
      let str = "";
      i++; // skip opening quote
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === "\\" && i + 1 < expr.length) {
          str += expr[i + 1];
          i += 2;
        } else {
          str += expr[i];
          i++;
        }
      }
      if (i >= expr.length) throw new Error(`Unterminated string literal in gate condition`);
      i++; // skip closing quote
      tokens.push({ type: "STRING", value: str });
      continue;
    }

    // Keywords and task refs: task.N.field, true, false, contains
    if (/[a-zA-Z_]/.test(expr[i])) {
      let word = "";
      while (i < expr.length && /[a-zA-Z0-9_.]/.test(expr[i])) {
        word += expr[i];
        i++;
      }

      if (word === "true" || word === "false") {
        tokens.push({ type: "BOOL", value: word });
      } else if (word === "contains") {
        tokens.push({ type: "CONTAINS", value: word });
      } else if (/^task\.\d+\.(output|success)$/.test(word)) {
        const parts = word.split(".");
        tokens.push({
          type: "TASK_REF",
          value: word,
          taskId: Number(parts[1]),
          field: parts[2],
        });
      } else {
        throw new Error(`Unknown identifier in gate condition: "${word}"`);
      }
      continue;
    }

    throw new Error(`Unexpected character in gate condition: "${expr[i]}" at position ${i}`);
  }

  tokens.push({ type: "EOF", value: "" });
  return tokens;
}

// --- Recursive descent parser ---
// Grammar (precedence low→high):
//   expr     → or
//   or       → and ( "||" and )*
//   and      → unary ( "&&" unary )*
//   unary    → "!" unary | primary ( ("==" | "!=" | "contains") primary )?
//   primary  → TASK_REF | BOOL | STRING | "(" expr ")"

type Value = string | boolean;

function resolveRef(token: Token, ctx: GateContext): Value {
  const entry = ctx.task.get(token.taskId!);
  if (!entry) throw new Error(`Gate condition references task ${token.taskId} which has no result`);
  if (token.field === "success") return entry.success;
  return entry.output;
}

/**
 * Evaluate a gate condition expression against a context.
 * Returns true (pass) or false (skip).
 *
 * Supported syntax:
 * - `task.N.success`, `task.N.output` — references to upstream task results
 * - `==`, `!=` — equality comparisons
 * - `contains` — string containment check
 * - `&&`, `||`, `!` — logical operators
 * - `true`, `false` — boolean literals
 * - `"string"` or `'string'` — string literals
 * - Parentheses for grouping
 */
export function evaluateGateCondition(expr: string, ctx: GateContext): boolean {
  const tokens = tokenize(expr);
  let pos = 0;

  function peek(): Token { return tokens[pos]; }
  function advance(): Token { return tokens[pos++]; }

  function expect(type: TokenType): Token {
    const t = advance();
    if (t.type !== type) throw new Error(`Expected ${type} but got ${t.type} ("${t.value}")`);
    return t;
  }

  function parseExpr(): Value {
    return parseOr();
  }

  function parseOr(): Value {
    let left = parseAnd();
    while (peek().type === "OP" && peek().value === "||") {
      advance();
      const right = parseAnd();
      left = toBool(left) || toBool(right);
    }
    return left;
  }

  function parseAnd(): Value {
    let left = parseComparison();
    while (peek().type === "OP" && peek().value === "&&") {
      advance();
      const right = parseComparison();
      left = toBool(left) && toBool(right);
    }
    return left;
  }

  function parseComparison(): Value {
    const left = parseUnary();

    const t = peek();
    if (t.type === "OP" && (t.value === "==" || t.value === "!=")) {
      advance();
      const right = parseUnary();
      const eq = String(left) === String(right);
      return t.value === "==" ? eq : !eq;
    }
    if (t.type === "CONTAINS") {
      advance();
      const right = parseUnary();
      return String(left).includes(String(right));
    }

    return left;
  }

  function parseUnary(): Value {
    if (peek().type === "OP" && peek().value === "!") {
      advance();
      const val = parseUnary();
      return !toBool(val);
    }
    return parsePrimary();
  }

  function parsePrimary(): Value {
    const t = peek();

    if (t.type === "TASK_REF") {
      advance();
      return resolveRef(t, ctx);
    }
    if (t.type === "BOOL") {
      advance();
      return t.value === "true";
    }
    if (t.type === "STRING") {
      advance();
      return t.value;
    }
    if (t.type === "LPAREN") {
      advance();
      const val = parseExpr();
      expect("RPAREN");
      return val;
    }

    throw new Error(`Unexpected token in gate condition: ${t.type} ("${t.value}")`);
  }

  const result = parseExpr();
  if (peek().type !== "EOF") {
    throw new Error(`Unexpected trailing tokens in gate condition: "${peek().value}"`);
  }
  return toBool(result);
}

function toBool(v: Value): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true";
  return Boolean(v);
}
