const test = require("node:test");
const assert = require("node:assert/strict");

const { AgentOrchestrator } = require("../src/orchestrator");
const { TaskStore } = require("../src/taskStore");
const { resolveEditIntentRuleOnly } = require("./orchestratorResolveRule");

function makeBaseTask(taskStore, taskId, stepId, label) {
  taskStore.create({
    taskId,
    conversationId: "conv_contract",
    state: "detecting",
    currentStepId: null,
    steps: [
      { stepId: "step_extract_intent", label: "提取意图", status: "pending" },
      { stepId: "step_planning", label: "生成执行计划", status: "pending" },
      { stepId, label, status: "pending" },
    ],
    artifacts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastError: null,
  });
}

test("contract: doc 编辑不允许 str_replace / append / overwrite", async () => {
  const calls = [];
  const taskStore = new TaskStore();
  const taskId = "task_contract_doc";
  makeBaseTask(taskStore, taskId, "step_create_doc", "创建文档");
  setTimeout(() => {
    taskStore.resolveConfirm(taskId, "step_risk_guard", true, null);
  }, 0);

  const orch = new AgentOrchestrator({
    parseIntent: () => ({ output_type: "doc" }),
    parseEditIntent: () => ({
      isEdit: true,
      target: "doc",
      operation: "UPDATE_BLOCK",
      selector: { anchorText: "里程碑" },
      payload: { to: "下周一发布" },
      confidence: 0.9,
      needsConfirm: false,
    }),
    resolveEditIntent: resolveEditIntentRuleOnly,
    buildEditPlan: ({ editIntent }) => ({ ...editIntent, mode: "append", maxChanges: 1 }),
    planWorkflow: async () => ({
      planVersion: 1,
      steps: [{ stepId: "step_create_doc", label: "创建文档", status: "pending" }],
      tasks: [],
      risks: { needsConfirm: false, reason: "" },
    }),
    buildDocsCreateArgs: () => ["docs", "+create"],
    buildDocsUpdateArgs: (x) => ["docs", "+update", JSON.stringify(x)],
    buildDocsFetchArgs: (x) => ["docs", "+fetch", JSON.stringify(x)],
    buildSlidesCreateArgs: () => ["slides", "+create"],
    buildImMessagesSendArgs: () => ["im", "+messages-send"],
    runLarkCli: async (args, options = {}) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      calls.push({ cmd, stdin: options.stdin || "" });
      if (cmd.includes("+fetch")) return { stdout: JSON.stringify({ data: { blocks: [{ block_id: "blk_1", text: "里程碑" }] } }) };
      return { stdout: JSON.stringify({ ok: true, data: { code: 0, updated_blocks_count: 1, document: { url: "https://x/docx/a" } } }) };
    },
    tryParseJson: (s) => {
      try {
        return { ok: true, value: JSON.parse(s) };
      } catch {
        return { ok: false, value: null };
      }
    },
    taskStore,
    publishTaskEvent: async () => {},
  });

  await orch.runWorkflow(taskId, {
    taskId,
    conversationId: "conv_contract",
    input: "把 https://example.com/docx/abc 里程碑改为下周一发布",
    contextSummary: "",
    targetArtifacts: ["doc"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: false, defaultIdentity: "user", docIdentity: "user" },
  });

  const all = calls.map((x) => x.cmd).join("\n");
  assert.ok(!/str_replace/.test(all));
  assert.ok(!/overwrite/.test(all));
  assert.ok(!/\"command\":\"append\"/.test(all));
});

test("contract: slides UPDATE_BLOCK 不允许 delete+create 回退", async () => {
  const calls = [];
  const taskStore = new TaskStore();
  const taskId = "task_contract_slides";
  makeBaseTask(taskStore, taskId, "step_create_slides", "创建演示稿");
  setTimeout(() => {
    taskStore.resolveConfirm(taskId, "step_risk_guard", true, null);
  }, 0);

  const orch = new AgentOrchestrator({
    parseIntent: () => ({ output_type: "ppt" }),
    parseEditIntent: () => ({
      isEdit: true,
      target: "slides",
      operation: "UPDATE_BLOCK",
      selector: { pageIndex: 1 },
      payload: { from: "旧标题", to: "新标题", title: "新标题" },
      confidence: 0.9,
      needsConfirm: false,
    }),
    resolveEditIntent: resolveEditIntentRuleOnly,
    buildEditPlan: ({ editIntent }) => ({ ...editIntent, mode: "append", maxChanges: 1 }),
    planWorkflow: async () => ({
      planVersion: 1,
      steps: [{ stepId: "step_create_slides", label: "创建演示稿", status: "pending" }],
      tasks: [],
      risks: { needsConfirm: false, reason: "" },
    }),
    buildDocsCreateArgs: () => ["docs", "+create"],
    buildDocsUpdateArgs: () => ["docs", "+update"],
    buildSlidesCreateArgs: () => ["slides", "+create"],
    buildSlidesXmlPresentationsGetArgs: () => ["slides", "xml_presentations", "get"],
    buildSlidesXmlPresentationSlideDeleteArgs: () => ["slides", "xml_presentation.slide", "delete"],
    buildSlidesXmlPresentationSlideGetArgs: () => ["slides", "xml_presentation.slide", "get"],
    buildSlidesXmlPresentationSlideReplaceArgs: () => ["slides", "xml_presentation.slide", "replace"],
    buildImMessagesSendArgs: () => ["im", "+messages-send"],
    runLarkCli: async (args, options = {}) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      calls.push({ cmd, stdin: options.stdin || "" });
      if (cmd.includes("xml_presentations") && cmd.includes("get")) {
        return { stdout: JSON.stringify({ data: { slides: [{ slide_id: "s1" }] } }) };
      }
      if (cmd.includes("xml_presentation.slide replace")) {
        return { stdout: JSON.stringify({ ok: true, data: { code: 0 } }) };
      }
      return { stdout: JSON.stringify({ ok: true }) };
    },
    tryParseJson: (s) => {
      try {
        return { ok: true, value: JSON.parse(s) };
      } catch {
        return { ok: false, value: null };
      }
    },
    taskStore,
    publishTaskEvent: async () => {},
  });

  await orch.runWorkflow(taskId, {
    taskId,
    conversationId: "conv_contract",
    input: "把 https://example.com/slides/abc 第1页旧标题改成新标题",
    contextSummary: "",
    targetArtifacts: ["slides"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: false, defaultIdentity: "user", slidesIdentity: "user" },
  });

  const all = calls.map((x) => x.cmd).join("\n");
  assert.ok(/xml_presentation\.slide replace/.test(all));
  assert.ok(!/xml_presentation\.slide delete/.test(all));
  assert.ok(!/xml_presentation\.slide create/.test(all));
});
