// Oxlint JS plugin rule: flag runs of consecutive line comments longer than
// the limit below. Block/JSDoc comments are exempt — long-form docs belong
// there or in the commit message, not in // banners.
const MAX_CONSECUTIVE_LINE_COMMENTS = 3;

const noCommentEssays = {
  meta: {
    messages: {
      essay:
        "Comment essay: more than {{max}} consecutive // lines. Use one line, a JSDoc block, or the commit body.",
    },
  },
  create(context) {
    return {
      Program(program) {
        const comments = context.sourceCode.getAllComments();
        let runLength = 0;
        let prevEndLine = -Infinity;
        for (const comment of comments) {
          if (comment.type !== "Line") {
            runLength = 0;
            prevEndLine = -Infinity;
            continue;
          }
          const startLine = comment.loc.start.line;
          runLength = startLine === prevEndLine + 1 ? runLength + 1 : 1;
          prevEndLine = comment.loc.end.line;
          if (runLength === MAX_CONSECUTIVE_LINE_COMMENTS + 1) {
            context.report({
              node: program,
              loc: comment.loc,
              messageId: "essay",
              data: { max: MAX_CONSECUTIVE_LINE_COMMENTS },
            });
            break;
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
  },
};
