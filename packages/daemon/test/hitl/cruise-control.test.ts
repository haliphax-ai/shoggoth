import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert";

// ---------------------------------------------------------------------------
// Mock DecisionService before importing the module under test
// ---------------------------------------------------------------------------

const { mockEvaluate, MockDecisionService } = vi.hoisted(() => {
  const mockEvaluate = vi.fn();
  const MockDecisionService = vi.fn().mockImplementation(() => ({
    evaluate: mockEvaluate,
  }));
  MockDecisionService.fromConfig = vi.fn().mockImplementation(() => ({
    evaluate: mockEvaluate,
  }));
  return { mockEvaluate, MockDecisionService };
});

vi.mock("../../src/decision/decision-service", () => ({
  DecisionService: MockDecisionService,
}));

import {
  buildCruiseControlBanner,
  createCruiseControlStore,
  cruiseControlActivationWarnings,
  DEFAULT_CRUISE_ESCALATE_MIN_SCORE,
  extractCruiseToolCommand,
  judgeCruiseControl,
} from "../../src/hitl/cruise-control";
import type { ShoggothConfig, CruiseControlPolicy } from "@shoggoth/shared";

const SESSION = "agent:main:discord:channel:abc";

function makeConfig(overrides?: Partial<ShoggothConfig>): ShoggothConfig {
  return {
    decision: {
      providers: [
        {
          id: "typesafe-main",
          kind: "typesafe",
          apiKey: "k",
          baseUrl: "https://api.typesafe.ai",
          models: [{ name: "jev-latest" }],
        },
      ],
    },
    ...overrides,
  } as ShoggothConfig;
}

function basePolicy(overrides?: Partial<CruiseControlPolicy>): CruiseControlPolicy {
  return {
    yes: "approve routine ops",
    no: "deny risky ops",
    model: "typesafe-main/jev-latest",
    ...overrides,
  };
}

function judgeInput(policy: CruiseControlPolicy, config = makeConfig()) {
  return {
    sessionId: SESSION,
    toolName: "builtin-exec:git",
    argsJson: '{"argv":["git","push"]}',
    policy,
    config,
  };
}

beforeEach(() => {
  mockEvaluate.mockReset();
});

describe("cruise control store", () => {
  it("sets, gets, clears, and reports activity per session", () => {
    const store = createCruiseControlStore();
    assert.equal(store.isActive(SESSION), false);
    store.set(SESSION, basePolicy());
    assert.equal(store.isActive(SESSION), true);
    assert.deepEqual(store.get(SESSION), basePolicy());
    assert.equal(store.clear(SESSION), true);
    assert.equal(store.isActive(SESSION), false);
    assert.equal(store.clear(SESSION), false);
  });
});

describe("cruise control activation warnings", () => {
  it("warns when no model is provided and no default is configured", () => {
    const warnings = cruiseControlActivationWarnings(
      makeConfig(),
      basePolicy({ model: undefined }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /no cruise control model/);
  });

  it("accepts the configured default model", () => {
    const config = makeConfig({
      agents: { cruiseControl: { model: "typesafe-main/jev-latest" } },
    } as Partial<ShoggothConfig>);
    assert.deepEqual(cruiseControlActivationWarnings(config, basePolicy()), []);
  });

  it("warns when the effective model is not in the decision provider config", () => {
    const warnings = cruiseControlActivationWarnings(
      makeConfig(),
      basePolicy({ model: "typesafe-main/unknown-model" }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /not listed in the decision provider config/);
  });

  it("warns when decision support is not configured at all", () => {
    const warnings = cruiseControlActivationWarnings(
      makeConfig({ decision: undefined }),
      basePolicy({ model: "p/m" }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /decision support is not configured/);
  });
});

describe("cruise control judge (noul)", () => {
  it("builds a noul question mapping yes/no guidance to true/false criteria", async () => {
    mockEvaluate.mockResolvedValue({
      status: "complete",
      model: "jev-latest",
      answers: { decision: { type: "noul", noul: 0.91 } },
    });
    const decision = await judgeCruiseControl(judgeInput(basePolicy()));
    assert.equal(decision, "approve");
    const req = mockEvaluate.mock.calls[0]![0] as {
      model: string;
      questions: Record<string, { type: string; criteria: Record<string, string> }>;
    };
    assert.equal(req.model, "typesafe-main/jev-latest");
    const q = req.questions.decision!;
    assert.equal(q.type, "noul");
    assert.equal(q.criteria.true, "approve routine ops");
    assert.equal(q.criteria.false, "deny risky ops");
  });

  it("denies when the noul probability is below 0.5", async () => {
    mockEvaluate.mockResolvedValue({
      status: "complete",
      model: "jev-latest",
      answers: { decision: { type: "noul", noul: 0.42 } },
    });
    assert.equal(await judgeCruiseControl(judgeInput(basePolicy())), "deny");
  });

  it("prefers the policy model over the configured default", async () => {
    mockEvaluate.mockResolvedValue({
      status: "complete",
      model: "x",
      answers: { decision: { type: "noul", noul: 0.99 } },
    });
    await judgeCruiseControl(judgeInput(basePolicy({ model: "typesafe-main/jev-latest" })));
    const req = mockEvaluate.mock.calls[0]![0] as { model: string };
    assert.equal(req.model, "typesafe-main/jev-latest");
  });
});

describe("cruise control judge (choice with escalation)", () => {
  const escalatePolicy = () => basePolicy({ escalate: "ask the operator when uncertain" });

  it("builds a choice question with approve/deny/escalate routes", async () => {
    mockEvaluate.mockResolvedValue({
      status: "complete",
      model: "x",
      answers: {
        decision: {
          type: "choice",
          choice: "approve",
          distribution: { approve: 0.9, deny: 0.05, escalate: 0.05 },
        },
      },
    });
    assert.equal(await judgeCruiseControl(judgeInput(escalatePolicy())), "approve");
    const req = mockEvaluate.mock.calls[0]![0] as {
      questions: Record<string, { type: string; criteria: Record<string, string> }>;
    };
    const q = req.questions.decision!;
    assert.equal(q.type, "choice");
    assert.equal(q.criteria.approve, "approve routine ops");
    assert.equal(q.criteria.deny, "deny risky ops");
    assert.equal(q.criteria.escalate, "ask the operator when uncertain");
  });

  it("escalates when the escalation route reaches the default 34% threshold even if not the top route", async () => {
    mockEvaluate.mockResolvedValue({
      status: "complete",
      model: "x",
      answers: {
        decision: {
          type: "choice",
          choice: "approve",
          distribution: { approve: 0.6, deny: 0.05, escalate: 0.35 },
        },
      },
    });
    assert.equal(await judgeCruiseControl(judgeInput(escalatePolicy())), "escalate");
  });

  it("approves when the escalation route stays under the threshold", async () => {
    mockEvaluate.mockResolvedValue({
      status: "complete",
      model: "x",
      answers: {
        decision: {
          type: "choice",
          choice: "approve",
          distribution: { approve: 0.8, deny: 0.05, escalate: 0.15 },
        },
      },
    });
    assert.equal(await judgeCruiseControl(judgeInput(escalatePolicy())), "approve");
  });

  it("respects a configured escalateMinScore", async () => {
    const config = makeConfig({
      agents: { cruiseControl: { escalateMinScore: 0.5 } },
    } as Partial<ShoggothConfig>);
    mockEvaluate.mockResolvedValue({
      status: "complete",
      model: "x",
      answers: {
        decision: {
          type: "choice",
          choice: "approve",
          distribution: { approve: 0.5, deny: 0.0, escalate: 0.5 },
        },
      },
    });
    assert.equal(await judgeCruiseControl(judgeInput(escalatePolicy(), config)), "escalate");
    assert.equal(DEFAULT_CRUISE_ESCALATE_MIN_SCORE, 0.34);
  });

  it("falls back to escalate on an unknown choice", async () => {
    mockEvaluate.mockResolvedValue({
      status: "complete",
      model: "x",
      answers: { decision: { type: "choice", choice: "sideways" } },
    });
    assert.equal(await judgeCruiseControl(judgeInput(escalatePolicy())), "escalate");
  });
});

describe("cruise control judge failure fallbacks", () => {
  it("escalates when no model resolves", async () => {
    // policy has no model and config has no default
    const decision = await judgeCruiseControl(
      judgeInput(basePolicy({ model: undefined }), makeConfig()),
    );
    assert.equal(decision, "escalate");
    assert.equal(mockEvaluate.mock.calls.length, 0);
  });

  it("escalates when the decision call errors", async () => {
    mockEvaluate.mockResolvedValue({ status: "error", error: "boom" });
    assert.equal(
      await judgeCruiseControl(judgeInput(basePolicy({ model: "typesafe-main/jev-latest" }))),
      "escalate",
    );
  });

  it("escalates when the answer is missing", async () => {
    mockEvaluate.mockResolvedValue({ status: "complete", model: "x", answers: {} });
    assert.equal(
      await judgeCruiseControl(judgeInput(basePolicy({ model: "typesafe-main/jev-latest" }))),
      "escalate",
    );
  });

  it("escalates when decision providers are unconfigured", async () => {
    const decision = await judgeCruiseControl(
      judgeInput(basePolicy({ model: "p/m" }), makeConfig({ decision: undefined })),
    );
    assert.equal(decision, "escalate");
    assert.equal(mockEvaluate.mock.calls.length, 0);
  });
});

describe("cruise control decision banners", () => {
  it("renders the approved banner with the tool name when no command is present", () => {
    assert.equal(
      buildCruiseControlBanner({ decision: "approve", toolName: "builtin-write" }),
      "> 🚗✅ Cruise control **approved** `builtin-write`",
    );
  });

  it("renders the denied banner with the tool name and extracted command", () => {
    assert.equal(
      buildCruiseControlBanner({
        decision: "deny",
        toolName: "builtin-exec",
        command: "git status",
      }),
      "> 🚗❌ Cruise control **denied** `builtin-exec: git status`",
    );
  });

  it("renders the elevated banner with the tool name and extracted command", () => {
    assert.equal(
      buildCruiseControlBanner({
        decision: "escalate",
        toolName: "builtin-exec",
        command: "rm -rf /tmp/x",
      }),
      "> 🚗⬆️ Cruise control **elevated** `builtin-exec: rm -rf /tmp/x`",
    );
  });

  it("truncates long extracted commands", () => {
    const banner = buildCruiseControlBanner({
      decision: "approve",
      toolName: "builtin-exec",
      command: "x".repeat(200),
    });
    assert.ok(banner.includes("…"));
    assert.ok(!banner.includes("x".repeat(61)));
  });
});

describe("cruise control command extraction", () => {
  it("joins argv arrays into a space-separated command", () => {
    assert.equal(
      extractCruiseToolCommand(JSON.stringify({ argv: ["git", "status"] })),
      "git status",
    );
  });

  it("prefers argv over a command string", () => {
    assert.equal(
      extractCruiseToolCommand(JSON.stringify({ argv: ["ls"], command: "ignored" })),
      "ls",
    );
  });

  it("falls back to a command string", () => {
    assert.equal(extractCruiseToolCommand(JSON.stringify({ command: "npm test" })), "npm test");
  });

  it("strips backticks and collapses newlines so the banner span stays intact", () => {
    assert.equal(
      extractCruiseToolCommand(JSON.stringify({ command: "echo `hi`\nthere" })),
      "echo 'hi' there",
    );
  });

  it("returns undefined for unparseable args", () => {
    assert.equal(extractCruiseToolCommand("{nope"), undefined);
  });

  it("returns undefined when no command-shaped arg is present", () => {
    assert.equal(extractCruiseToolCommand("{}"), undefined);
    assert.equal(extractCruiseToolCommand(JSON.stringify({ argv: [] })), undefined);
    assert.equal(extractCruiseToolCommand(JSON.stringify({ command: "   " })), undefined);
    assert.equal(extractCruiseToolCommand(JSON.stringify({ command: 42 })), undefined);
  });
});
