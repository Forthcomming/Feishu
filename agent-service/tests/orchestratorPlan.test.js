const test = require("node:test");
const assert = require("node:assert/strict");

const { AgentOrchestrator } = require("../src/orchestrator");
const { TaskStore } = require("../src/taskStore");
const { planWorkflow } = require("../src/plannerAgent");
const { generateContentBundle } = require("../src/contentAgent");

function makeDeps({ events }) {
  return {
    parseIntentStub: () => ({ intent: { name: "doc", confidence: 0.9 } }),
    planWorkflow,
    generateContentBundle,
    buildDocsCreateArgs: (x) => ["docs", "+create", JSON.stringify(x)],
    buildSlidesCreateArgs: (x) => ["slides", "+create", JSON.stringify(x)],
    buildImMessagesSendArgs: (x) => ["im", "+messages-send", JSON.stringify(x)],
    runLarkCli: async (args) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      if (cmd.includes("docs") && cmd.includes("+create")) {
        return { stdout: JSON.stringify({ data: { document: { url: "https://example.com/docx/abc" } } }) };
      }
      if (cmd.includes("slides") && cmd.includes("+create")) {
        return { stdout: JSON.stringify({ data: { url: "https://example.com/slides/xyz" } }) };
      }
      return { stdout: JSON.stringify({ ok: true }) };
    },
    tryParseJson: (stdout) => {
      try {
        return { ok: true, value: JSON.parse(stdout) };
      } catch {
        return { ok: false, value: null };
      }
    },
    taskStore: new TaskStore(),
    publishTaskEvent: async (evt) => {
      events.push(evt);
    },
  };
}

test("orchestrator: planning 后 steps 被替换为 planner 输出（包含 8-12 步）", async () => {
  const events = [];
  const deps = makeDeps({ events });
  const orchestrator = new AgentOrchestrator(deps);

  const taskId = "task_test_1";
  const task = deps.taskStore.create({
    taskId,
    conversationId: "c1",
    state: "detecting",
    currentStepId: null,
    steps: [
      { stepId: "step_extract_intent", label: "提取意图", status: "pending" },
      { stepId: "step_planning", label: "生成执行计划", status: "pending" },
      { stepId: "step_create_doc", label: "创建文档", status: "pending" },
      { stepId: "step_send_delivery_message", label: "回 IM 交付", status: "pending" },
    ],
    artifacts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastError: null,
  });

  await orchestrator.runWorkflow(task.taskId, {
    taskId,
    conversationId: "c1",
    input: "请把讨论整理成需求文档并回传链接",
    contextSummary: "（测试上下文摘要）",
    targetArtifacts: ["doc"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: true, defaultIdentity: "user" },
  });

  const done = deps.taskStore.get(taskId);
  assert.equal(done.state, "completed");
  assert.ok(done.steps.length >= 8 && done.steps.length <= 13); // + extract_intent
  const ids = new Set(done.steps.map((s) => s.stepId));
  assert.ok(ids.has("step_fetch_context"));
  assert.ok(ids.has("step_risk_guard"));
  assert.ok(ids.has("step_create_doc"));
  assert.ok(ids.has("step_send_delivery_message"));
  assert.ok(done.artifacts.some((a) => a.kind === "doc"));
});

