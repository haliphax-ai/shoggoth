// Oxlint JS plugin: no-comment-essays (flags >3-run // comments; suggests JSDoc
// fold on a documentable symbol, else delete/compress) and jsdoc-refer-docs
// (JSDoc blocks over 10 lines should keep a summary and reference full docs).

const MAX_CONSECUTIVE_LINE_COMMENTS = 3;
const MAX_JSDOC_LINES = 10;

const DOCUMENTABLE_NODES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "MethodDefinition",
  "PropertyDefinition",
  "TSMethodSignature",
  "TSAbstractMethodDefinition",
]);

function nodeKindLabel(node) {
  switch (node.type) {
    case "MethodDefinition":
    case "TSAbstractMethodDefinition":
      return "method";
    case "TSMethodSignature":
      return "method signature";
    case "PropertyDefinition":
      return "property";
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return "function";
    default:
      return "declaration";
  }
}

// A variable counts as documentable only when its initializer is a function,
// class, object, array, or constructor call — `const x = 1` does not.
function isComplexVariableDeclarator(node) {
  if (node.type !== "VariableDeclarator" || !node.init) return false;
  const t = node.init.type;
  return (
    t === "FunctionExpression" ||
    t === "ArrowFunctionExpression" ||
    t === "ClassExpression" ||
    t === "ObjectExpression" ||
    t === "ArrayExpression" ||
    t === "NewExpression"
  );
}

function isDocumentableNode(node) {
  return (
    DOCUMENTABLE_NODES.has(node.type) ||
    (node.type === "ExportDefaultDeclaration" && isComplexVariableDeclarator(node.declaration)) ||
    isComplexVariableDeclarator(node)
  );
}

// Group line comments into runs by source adjacency: a comment continues the
// current run when it starts on the line right after the previous comment, or
// after exactly one BLANK line. A code line or block comment ends the run.
function assembleEssayRuns(sourceText, comments, minRunLength) {
  const sourceLines = sourceText.split("\n");
  const isBlankLine = (lineNo) => {
    // lineNo is 1-indexed; a gap line past EOF cannot be blank.
    const text = sourceLines[lineNo - 1];
    return text !== undefined && /^\s*$/.test(text);
  };
  const runs = [];
  let run = null;
  let prevEndLine = -Infinity;
  for (const comment of comments) {
    if (comment.type !== "Line") {
      if (run && run.length >= minRunLength) runs.push(run);
      run = null;
      prevEndLine = -Infinity;
      continue;
    }
    const startLine = comment.loc.start.line;
    const contiguous =
      run &&
      (startLine === prevEndLine + 1 ||
        (startLine === prevEndLine + 2 && isBlankLine(prevEndLine + 1)));
    if (!contiguous) {
      if (run && run.length >= minRunLength) runs.push(run);
      run = null;
    }
    if (!run) run = [];
    run.push(comment);
    prevEndLine = comment.loc.end.line;
  }
  if (run && run.length >= minRunLength) runs.push(run);
  return runs;
}

const noCommentEssays = {
  meta: {
    messages: {
      essayJsdoc:
        "Comment essay: more than {{max}} consecutive // lines. If this documents the {{kind}} below, fold it into that symbol's JSDoc (max {{maxJsdoc}} lines — see jsdoc-refer-docs); otherwise compress to {{max}} lines.",
      essayCompress:
        "Comment essay: more than {{max}} consecutive // lines. Delete narration or compress to {{max}} lines; long-form rationale belongs in the commit body or reference docs.",
    },
  },
  create(context) {
    const docNodes = [];
    let runs = [];

    function collect(node) {
      if (isDocumentableNode(node)) {
        docNodes.push({ line: node.loc.start.line, kind: nodeKindLabel(node) });
      }
    }

    function reportRun(run) {
      const nextLine = run[run.length - 1].loc.end.line + 1;
      const target = docNodes
        .filter((entry) => entry.line >= nextLine && entry.line <= nextLine + 1)
        .sort((a, b) => a.line - b.line)[0];
      // Report at the 4th comment — the first line past the limit.
      const reportAt = run[MAX_CONSECUTIVE_LINE_COMMENTS].loc;
      if (target) {
        context.report({
          loc: reportAt,
          messageId: "essayJsdoc",
          data: {
            max: MAX_CONSECUTIVE_LINE_COMMENTS,
            maxJsdoc: MAX_JSDOC_LINES,
            kind: target.kind,
          },
        });
      } else {
        context.report({
          loc: reportAt,
          messageId: "essayCompress",
          data: { max: MAX_CONSECUTIVE_LINE_COMMENTS },
        });
      }
    }

    return {
      FunctionDeclaration: collect,
      FunctionExpression: collect,
      ArrowFunctionExpression: collect,
      MethodDefinition: collect,
      PropertyDefinition: collect,
      TSMethodSignature: collect,
      TSAbstractMethodDefinition: collect,
      VariableDeclarator: collect,
      ExportDefaultDeclaration: collect,
      Program(program) {
        void program;
        runs = assembleEssayRuns(
          context.sourceCode.text,
          context.sourceCode.getAllComments(),
          MAX_CONSECUTIVE_LINE_COMMENTS + 1,
        );
      },
      "Program:exit"() {
        for (const run of runs) reportRun(run);
      },
    };
  },
};

const jsdocReferDocs = {
  meta: {
    messages: {
      referDocs:
        "JSDoc block exceeds {{max}} lines. Keep a short summary here and reference the full documentation instead (docs/ or a link).",
    },
  },
  create(context) {
    return {
      "Program:exit"() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type !== "Block" || !comment.value.startsWith("*")) continue;
          const lines = comment.loc.end.line - comment.loc.start.line + 1;
          if (lines > MAX_JSDOC_LINES) {
            context.report({
              loc: comment.loc,
              messageId: "referDocs",
              data: { max: MAX_JSDOC_LINES },
            });
          }
        }
      },
    };
  },
};

export default {
  meta: { name: "custom-lint" },
  rules: {
    "no-comment-essays": noCommentEssays,
    "jsdoc-refer-docs": jsdocReferDocs,
  },
};
