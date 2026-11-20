import { describe, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";
import plugin from "../no-comment-essays.js";

RuleTester.describe = describe;
RuleTester.it = it;

const essayRule = plugin.rules["no-comment-essays"];
const jsdocRule = plugin.rules["jsdoc-refer-docs"];

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const COMPRESS = "essayCompress";

ruleTester.run("no-comment-essays", essayRule, {
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
      name: "three comments plus a blank-joined fourth stays under a single run",
      code: "// one\n// two\n\n// three\nconst a = 1;\n",
    },
    {
      name: "two blank lines end the run",
      code: "// one\n// two\n// three\n\n\n// four\nconst a = 1;\n",
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
      name: "four consecutive line comments (plain)",
      code: "// one\n// two\n// three\n// four\nconst a = 1;\n",
      errors: [{ messageId: COMPRESS, line: 4, column: 0 }],
    },
    {
      name: "blank lines between comments do not reset the count",
      code: "// one\n// two\n// three\n\n// four is still within a single run\nconst a = 1;\n",
      errors: [{ messageId: COMPRESS, line: 5, column: 0 }],
    },
    {
      name: "long run reports only the fourth line",
      code: "// one\n// two\n// three\n// four\n// five\n// six\n// seven\nconst a = 1;\n",
      errors: [{ messageId: COMPRESS, line: 4, column: 0 }],
    },
    {
      name: "run spanning code with blank-line joins is still contiguous",
      code: "const a = 0;\n// one\n// two\n// three\n// four\nconst b = 1;\n",
      errors: [{ messageId: COMPRESS, line: 5, column: 0 }],
    },
    {
      name: "essays on the same line as code still count",
      code: "const a = 0; // one\n// two\n// three\n// four\nconst b = 1;\n",
      errors: [{ messageId: COMPRESS, line: 4, column: 0 }],
    },
    {
      name: "essay above a plain variable suggests compression only",
      code: "// header\n// for this\n// file that\n// runs long\nconst a = 1;\n",
      errors: [{ messageId: COMPRESS, line: 4, column: 0 }],
    },
    {
      name: "essay above a function suggests JSDoc",
      code: "// This helper does the thing.\n// It has steps.\n// More steps.\n// Even more steps.\nfunction helper() {\n  return 1;\n}\n",
      errors: [{ messageId: "essayJsdoc", line: 4, column: 0 }],
    },
    {
      name: "essay above a method suggests JSDoc",
      code: "class C {\n  // Does the thing.\n  // With detail.\n  // More detail.\n  // Even more detail.\n  method() {\n    return 1;\n  }\n}\n",
      errors: [{ messageId: "essayJsdoc", line: 5, column: 2 }],
    },
    {
      name: "essay above a complex const (function value) suggests JSDoc",
      code: "// Builds the thing.\n// Carefully.\n// Very carefully.\n// Extremely carefully.\nconst build = () => {\n  return 1;\n};\n",
      errors: [{ messageId: "essayJsdoc", line: 4, column: 0 }],
    },
    {
      name: "essay above a complex const (object literal) suggests JSDoc",
      code: "// Config map.\n// Of knobs.\n// Many knobs.\n// So many knobs.\nconst knobs = {\n  a: 1,\n};\n",
      errors: [{ messageId: "essayJsdoc", line: 4, column: 0 }],
    },
  ],
});

ruleTester.run("jsdoc-refer-docs", jsdocRule, {
  valid: [
    {
      name: "jsdoc at exactly 10 lines is allowed",
      code: "/**\n * l1\n * l2\n * l3\n * l4\n * l5\n * l6\n * l7\n * l8\n */\nfunction f() {}\n",
    },
  ],
  invalid: [
    {
      name: "jsdoc over 10 lines is flagged",
      code: "/**\n * l1\n * l2\n * l3\n * l4\n * l5\n * l6\n * l7\n * l8\n * l9\n */\nfunction f() {}\n",
      errors: [{ messageId: "referDocs", line: 1, column: 0 }],
    },
  ],
});
