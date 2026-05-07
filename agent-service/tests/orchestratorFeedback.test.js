const test = require("node:test");
const assert = require("node:assert/strict");

const { AgentOrchestrator } = require("../src/orchestrator");
const { TaskStore } = require("../src/taskStore");
const { resolveEditIntentRuleOnly } = require("./orchestratorResolveRule");

function makeMinimalDeps({ feedbackEvents }) {
  return {
    parseIntent: () => ({}),
    planWorkflow: async () => ({ planVersion: 1, steps: [], tasks: [], risks: { needsConfirm: false, reason: "" } }),
    buildDocsCreateArgs: () => [],
    buildDocsUpdateArgs: () => [],
    buildSlidesCreateArgs: () => [],
    buildImMessagesSendArgs: () => [],
    runLarkCli: async () => ({ stdout: "{}" }),
    tryParseJson: (s) => {
      try {
        return { ok: true, value: JSON.parse(s) };
      } catch {
        return { ok: false, value: null };
      }
    },
    taskStore: new TaskStore(),
    publishTaskEvent: async () => {},
    publishFeedbackEvent: async (evt) => {
      feedbackEvents.push(evt);
    },
    resolveEditIntent: resolveEditIntentRuleOnly,
  };
}

test("orchestrator: 提前 cancelled 时也会发出 feedback.task_completed 事件", async () => {
  const feedbackEvents = [];
  const deps = makeMinimalDeps({ feedbackEvents });
  const orch = new AgentOrchestrator(deps);

  const taskId = "task_fb_cancel";
  deps.taskStore.create({
    taskId,
    conversationId: "conv_fb_1",
    state: "detecting",
    currentStepId: null,
    steps: [{ stepId: "step_extract_intent", label: "提取意图", status: "pending" }],
    artifacts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastError: null,
  });
  deps.taskStore.cancel(taskId);

  await orch.runWorkflow(taskId, {
    taskId,
    conversationId: "conv_fb_1",
    input: "请整理成需求文档（含敏感原文：不应记录）",
    contextSummary: "（敏感上下文：不应记录）",
    targetArtifacts: ["doc"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: true, defaultIdentity: "user" },
    intentMeta: { source: "rule", confidence: 0.9, output_type: "doc" },
  });

  assert.equal(feedbackEvents.length, 1);
  const evt = feedbackEvents[0];
  assert.equal(evt.type, "feedback.task_completed");
  assert.equal(evt.taskId, taskId);
  assert.equal(evt.conversationId, "conv_fb_1");
  assert.equal(evt.state, "cancelled");
  assert.equal(evt.intent.source, "rule");
  assert.equal(evt.intent.confidence, 0.9);
  assert.ok(typeof evt.inputLen === "number" && evt.inputLen > 0);
  const serialized = JSON.stringify(evt);
  assert.ok(!serialized.includes("敏感原文"));
  assert.ok(!serialized.includes("敏感上下文"));
});

test("orchestrator: publishFeedbackEvent 抛错不会阻断主流程", async () => {
  const deps = makeMinimalDeps({ feedbackEvents: [] });
  deps.publishFeedbackEvent = async () => {
    throw new Error("boom");
  };
  const orch = new AgentOrchestrator(deps);

  const taskId = "task_fb_throw";
  deps.taskStore.create({
    taskId,
    conversationId: "conv_fb_2",
    state: "detecting",
    currentStepId: null,
    steps: [],
    artifacts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastError: null,
  });
  deps.taskStore.cancel(taskId);

  await assert.doesNotReject(async () => {
    await orch.runWorkflow(taskId, {
      taskId,
      conversationId: "conv_fb_2",
      input: "x",
      targetArtifacts: ["doc"],
      delivery: { channel: "im_chat", chatId: "" },
      execution: { dryRun: true },
    });
  });

  const t = deps.taskStore.get(taskId);
  assert.equal(t.state, "cancelled");
});

test("orchestrator: completed 后进入 reflecting 时触发 reflectJob（失败不阻断）", async () => {
  const feedbackEvents = [];
  const deps = makeMinimalDeps({ feedbackEvents });
  let reflectCalls = 0;
  deps.parseIntent = () => ({ output_type: "doc", doc_type: "meeting_summary", ppt_type: "report", scenario: "discussion" });
  deps.planWorkflow = async () => ({
    planVersion: 1,
    steps: [{ stepId: "step_make_outline", label: "生成大纲", status: "pending" }],
    tasks: [],
    risks: { needsConfirm: false, reason: "" },
  });
  deps.generateContentBundle = async () => ({
    summaryMd: "## 上下文摘要\n- x",
    requirementsMd: "## 需求\n- x",
    clarifyMd: "## 澄清\n- x",
    outlineMd: "## 大纲\n- x",
    confidence: 0.9,
  });
  deps.runReflectJob = async () => {
    reflectCalls += 1;
    throw new Error("reflect failed");
  };
  const orch = new AgentOrchestrator(deps);
  const taskId = "task_reflect_trigger";
  deps.taskStore.create({
    taskId,
    conversationId: "conv_reflect",
    state: "detecting",
    currentStepId: null,
    steps: [{ stepId: "step_extract_intent", label: "提取意图", status: "pending" }],
    artifacts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastError: null,
  });

  const prevReflectMs = process.env.REFLECTING_PHASE_MS;
  process.env.REFLECTING_PHASE_MS = "0";
  try {
    await orch.runWorkflow(taskId, {
      taskId,
      conversationId: "conv_reflect",
      input: "请整理成文档",
      contextSummary: "",
      targetArtifacts: ["doc"],
      delivery: { channel: "im_chat", chatId: "" },
      execution: { dryRun: true },
    });
  } finally {
    if (prevReflectMs == null) delete process.env.REFLECTING_PHASE_MS;
    else process.env.REFLECTING_PHASE_MS = prevReflectMs;
  }

  assert.equal(reflectCalls, 1);
  const t = deps.taskStore.get(taskId);
  assert.equal(t.state, "idle");
});
