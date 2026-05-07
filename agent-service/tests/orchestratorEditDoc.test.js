const test = require("node:test");
const assert = require("node:assert/strict");

const { AgentOrchestrator } = require("../src/orchestrator");
const { TaskStore } = require("../src/taskStore");
const { resolveEditIntentRuleOnly } = require("./orchestratorResolveRule");

function makeBaseTask(taskStore, taskId) {
  taskStore.create({
    taskId,
    conversationId: "conv_edit_doc",
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
}

test("orchestrator: doc 细粒度编辑仅走 block_replace", async () => {
  const calls = [];
  let bundleCalls = 0;
  const taskStore = new TaskStore();
  const taskId = "task_edit_doc_1";
  makeBaseTask(taskStore, taskId);
  setTimeout(() => {
    taskStore.resolveConfirm(taskId, "step_risk_guard", true, null);
  }, 0);

  const orch = new AgentOrchestrator({
    parseIntent: () => ({ output_type: "doc", doc_type: "prd", ppt_type: "report", scenario: "discussion" }),
    parseEditIntent: () => ({
      isEdit: true,
      target: "doc",
      operation: "UPDATE_BLOCK",
      selector: { anchorText: "目标段" },
      payload: { to: "改后的内容" },
      confidence: 0.92,
      needsConfirm: false,
    }),
    resolveEditIntent: resolveEditIntentRuleOnly,
    buildEditPlan: ({ editIntent }) => ({
      ...editIntent,
      mode: "append",
      maxChanges: 1,
    }),
    planWorkflow: async () => ({
      planVersion: 1,
      steps: [{ stepId: "step_create_doc", label: "创建文档", status: "pending" }],
      tasks: [],
      risks: { needsConfirm: false, reason: "" },
    }),
    generateContentBundle: async () => {
      bundleCalls += 1;
      return {
        confidence: 0.9,
        summaryMd: "## 摘要\n- x",
        requirementsMd: "## 需求\n- x",
        clarifyMd: "## 澄清\n- x",
        outlineMd: "## 大纲\n- x",
        rewrittenMd: "## 正文\n- 旧内容",
      };
    },
    buildDocsCreateArgs: (x) => ["docs", "+create", JSON.stringify(x)],
    buildDocsUpdateArgs: (x) => ["docs", "+update", JSON.stringify(x)],
    buildDocsFetchArgs: (x) => ["docs", "+fetch", JSON.stringify(x)],
    buildSlidesCreateArgs: () => ["slides", "+create"],
    buildImMessagesSendArgs: () => ["im", "+messages-send"],
    runLarkCli: async (args, options = {}) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      calls.push({ cmd, stdin: options.stdin || "" });
      if (cmd.includes("docs") && cmd.includes("+fetch")) {
        return { stdout: JSON.stringify({ data: { blocks: [{ block_id: "blk_1", text: "目标段 原文" }] } }) };
      }
      if (cmd.includes("docs") && cmd.includes("+update")) {
        return { stdout: JSON.stringify({ ok: true, data: { code: 0, document: { url: "https://example.com/docx/abc" }, updated_blocks_count: 1 } }) };
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
    conversationId: "conv_edit_doc",
    input: "请把 https://example.com/docx/abc 里的目标段改成改后的内容",
    contextSummary: "",
    targetArtifacts: ["doc"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: false, defaultIdentity: "user", docIdentity: "user" },
  });

  const updateCall = calls.find((x) => x.cmd.includes("docs") && x.cmd.includes("+update"));
  assert.ok(updateCall);
  assert.match(updateCall.cmd, /block_replace/);
  assert.equal(updateCall.stdin, "改后的内容");
  assert.equal(calls.filter((c) => c.cmd.includes("+fetch")).length, 1, "block 模式必须先 fetch 定位 block_id");
  assert.equal(bundleCalls, 0, "编辑短路应跳过 generateContentBundle");
  const done = taskStore.get(taskId);
  assert.equal(done.state, "idle");
  assert.ok(done.artifacts.some((a) => a.kind === "note" && String(a.title).includes("编辑短路")));
  assert.ok(done.artifacts.some((a) => a.kind === "note" && String(a.title).includes("云文档编辑记录")));
});

test("orchestrator: 文档定位 fetch 不受 execution.dryRun 影响（始终真实读取）", async () => {
  const calls = [];
  const taskStore = new TaskStore();
  const taskId = "task_edit_doc_fetch_nodry_1";
  makeBaseTask(taskStore, taskId);

  const orch = new AgentOrchestrator({
    parseIntent: () => ({ output_type: "doc", doc_type: "prd", ppt_type: "report", scenario: "discussion" }),
    parseEditIntent: () => ({
      isEdit: true,
      target: "doc",
      operation: "INSERT_BLOCK",
      selector: { anchorText: "目标段 原文" },
      payload: { content: "新增风险：第三方限流；对策：队列与重试" },
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
    generateContentBundle: async () => ({
      confidence: 0.9,
      summaryMd: "",
      requirementsMd: "",
      clarifyMd: "",
      outlineMd: "",
      rewrittenMd: "",
    }),
    buildDocsCreateArgs: (x) => ["docs", "+create", JSON.stringify(x)],
    buildDocsUpdateArgs: (x) => ["docs", "+update", JSON.stringify(x)],
    buildDocsFetchArgs: (x) => ["docs", "+fetch", JSON.stringify(x)],
    buildSlidesCreateArgs: () => ["slides", "+create"],
    buildImMessagesSendArgs: () => ["im", "+messages-send"],
    runLarkCli: async (args) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      calls.push(cmd);
      if (cmd.includes("+fetch")) {
        return { stdout: JSON.stringify({ data: { blocks: [{ block_id: "blk_1", text: "目标段 原文" }] } }) };
      }
      if (cmd.includes("+update")) {
        return { stdout: JSON.stringify({ ok: true, data: { code: 0, updated_blocks_count: 1 } }) };
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
    conversationId: "conv_edit_doc",
    input: "在 https://example.com/docx/abc 的目标段 原文后面插入新增风险",
    contextSummary: "",
    targetArtifacts: ["doc"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: true, defaultIdentity: "user", docIdentity: "user" },
  });

  const fetchCmd = calls.find((x) => x.includes("+fetch")) || "";
  const updateCmd = calls.find((x) => x.includes("+update")) || "";
  assert.match(fetchCmd, /"dryRun":false/, "fetch 应固定真实读取以返回完整 block_id");
  assert.match(updateCmd, /"dryRun":true/, "写入命令仍应保留 execution.dryRun");
});

test("orchestrator: EDIT_SHORT_CIRCUIT_ENABLED=false 时编辑仍走全量 generateContentBundle", async (t) => {
  t.after(() => {
    delete process.env.EDIT_SHORT_CIRCUIT_ENABLED;
    delete process.env.REFLECTING_PHASE_MS;
  });
  process.env.EDIT_SHORT_CIRCUIT_ENABLED = "false";
  process.env.REFLECTING_PHASE_MS = "0";

  let bundleCalls = 0;
  const calls = [];
  const taskStore = new TaskStore();
  const taskId = "task_edit_doc_full_bundle";
  makeBaseTask(taskStore, taskId);

  const orch = new AgentOrchestrator({
    parseIntent: () => ({ output_type: "doc", doc_type: "prd", ppt_type: "report", scenario: "discussion" }),
    parseEditIntent: () => ({
      isEdit: true,
      target: "doc",
      operation: "UPDATE_BLOCK",
      selector: { anchorText: "目标段" },
      payload: { to: "改后的内容" },
      confidence: 0.92,
      needsConfirm: false,
    }),
    resolveEditIntent: resolveEditIntentRuleOnly,
    buildEditPlan: ({ editIntent }) => ({
      ...editIntent,
      mode: "append",
      maxChanges: 1,
    }),
    planWorkflow: async () => ({
      planVersion: 1,
      steps: [{ stepId: "step_create_doc", label: "创建文档", status: "pending" }],
      tasks: [],
      risks: { needsConfirm: false, reason: "" },
    }),
    generateContentBundle: async () => {
      bundleCalls += 1;
      return {
        confidence: 0.9,
        summaryMd: "## 摘要\n- x",
        requirementsMd: "## 需求\n- x",
        clarifyMd: "## 澄清\n- x",
        outlineMd: "## 大纲\n- x",
        rewrittenMd: "## 正文\n- 旧内容",
      };
    },
    buildDocsCreateArgs: (x) => ["docs", "+create", JSON.stringify(x)],
    buildDocsUpdateArgs: (x) => ["docs", "+update", JSON.stringify(x)],
    buildDocsFetchArgs: (x) => ["docs", "+fetch", JSON.stringify(x)],
    buildSlidesCreateArgs: () => ["slides", "+create"],
    buildImMessagesSendArgs: () => ["im", "+messages-send"],
    runLarkCli: async (args, options = {}) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      calls.push({ cmd, stdin: options.stdin || "" });
      if (cmd.includes("docs") && cmd.includes("+fetch")) {
        return { stdout: JSON.stringify({ data: { blocks: [{ block_id: "blk_1", text: "目标段 原文" }] } }) };
      }
      if (cmd.includes("docs") && cmd.includes("+update")) {
        return { stdout: JSON.stringify({ ok: true, data: { code: 0, document: { url: "https://example.com/docx/abc" }, updated_blocks_count: 1 } }) };
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
    conversationId: "conv_edit_doc",
    input: "请把 https://example.com/docx/abc 里的目标段改成改后的内容",
    contextSummary: "",
    targetArtifacts: ["doc"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: false, defaultIdentity: "user", docIdentity: "user" },
  });

  assert.equal(bundleCalls, 1);
  const done = taskStore.get(taskId);
  assert.equal(done.state, "idle");
  assert.ok(!done.artifacts.some((a) => a.kind === "note" && String(a.title).includes("编辑短路")));
});

test("orchestrator: 文档编辑但全文无 docx 定位时失败且不调用 docs create", async (t) => {
  t.after(() => {
    delete process.env.REFLECTING_PHASE_MS;
  });
  const calls = [];
  process.env.REFLECTING_PHASE_MS = "0";
  const taskStore = new TaskStore();
  const taskId = "task_edit_doc_no_target";
  makeBaseTask(taskStore, taskId);

  const orch = new AgentOrchestrator({
    parseIntent: () => ({ output_type: "doc", doc_type: "meeting_summary", ppt_type: "report", scenario: "discussion" }),
    parseEditIntent: () => ({
      isEdit: true,
      target: "doc",
      operation: "INSERT_BLOCK",
      selector: { anchorText: "待确认问题" },
      payload: { content: "新增风险说明" },
      confidence: 0.85,
      needsConfirm: false,
    }),
    resolveEditIntent: resolveEditIntentRuleOnly,
    buildEditPlan: ({ editIntent }) => ({
      ...editIntent,
      mode: "append",
      maxChanges: 1,
      needsConfirm: false,
    }),
    planWorkflow: async () => ({
      planVersion: 1,
      steps: [{ stepId: "step_create_doc", label: "创建文档", status: "pending" }],
      tasks: [],
      risks: { needsConfirm: false, reason: "" },
    }),
    generateContentBundle: async () => ({
      confidence: 0.9,
      summaryMd: "## 摘要\n- x",
      requirementsMd: "## 需求\n- x",
      clarifyMd: "## 澄清\n- x",
      outlineMd: "## 大纲\n- x",
      rewrittenMd: "## 正文\n- 旧内容",
    }),
    buildDocsCreateArgs: (x) => {
      calls.push("create");
      return ["docs", "+create", JSON.stringify(x)];
    },
    buildDocsUpdateArgs: (x) => ["docs", "+update", JSON.stringify(x)],
    buildSlidesCreateArgs: () => ["slides", "+create"],
    buildImMessagesSendArgs: () => ["im", "+messages-send"],
    runLarkCli: async () => ({ stdout: "{}" }),
    tryParseJson: () => ({ ok: false, value: null }),
    taskStore,
    publishTaskEvent: async () => {},
  });

  await orch.runWorkflow(taskId, {
    taskId,
    conversationId: "conv_edit_doc",
    input: "在会议纪要「待确认问题」后面插入：新增风险",
    contextSummary: "",
    recentMessages: [],
    docTarget: "",
    targetArtifacts: ["doc"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: false, defaultIdentity: "user", docIdentity: "user" },
  });

  const done = taskStore.get(taskId);
  assert.equal(done.state, "failed");
  assert.match(String(done.lastError || ""), /未解析到要编辑的飞书文档/);
  assert.equal(calls.length, 0);
});

