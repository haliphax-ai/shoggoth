import { describe, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";
import plugin from "../no-comment-essays.js";

RuleTester.describe = describe;
RuleTester.it = it;

const rule = plugin.rules["no-comment-essays"];

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const MESSAGE_ID = "essay";

ruleTester.run("no-comment-essays", rule, {
  valid: [
    {
      name: "single comment",
      code: "// one is fine\nconst a = 1;\n",
    },
    {
      name: "run of exactly three is allowed",
      code: "// one\n// two\n// three\nconst a = 1;\n",
    },
    {
      name: "code between runs resets the count",
      code: "// one\n// two\n// three\nconst a = 1;\n// four\n// five\nconst b = 2;\n",
    },
    {
      name: "blank lines between comments do not reset the count",
      code: "// one\n// two\n// three\n\n// four is still within a single run\nconst a = 1;\n",
    },
    {
      name: "contiguous block comments are exempt",
      code: "/*\n * one\n * two\n * three\n * four\n * five\n */\nconst a = 1;\n",
    },
    {
      name: "a block comment separates two runs",
      code: "// one\n// two\n// three\n/* block */\n// four\n// five\nconst a = 1;\n",
    },
    {
      name: "line comment and jsdoc do not combine into a run",
      code: "// one\n// two\n// three\n/**\n * jsdoc\n */\n// four\nconst a = 1;\n",
    },
  ],
  invalid: [
    {
      name: "four consecutive line comments",
      code: "// one\n// two\n// three\n// four\nconst a = 1;\n",
      errors: [{ messageId: MESSAGE_ID, line: 4, column: 0 }],
    },
    {
      name: "long run reports only the fourth line",
      code: "// one\n// two\n// three\n// four\n// five\n// six\n// seven\nconst a = 1;\n",
      errors: [{ messageId: MESSAGE_ID, line: 4, column: 0 }],
    },
    {
      name: "run spanning code with blank-line joins is still contiguous",
      code: "const a = 0;\n// one\n// two\n// three\n// four\nconst b = 1;\n",
      errors: [{ messageId: MESSAGE_ID, line: 5, column: 0 }],
    },
    {
      name: "essays on the same line as code still count",
      code: "const a = 0; // one\n// two\n// three\n// four\nconst b = 1;\n",
      errors: [{ messageId: MESSAGE_ID, line: 4, column: 0 }],
    },
  ],
});
