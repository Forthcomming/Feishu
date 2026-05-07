const test = require("node:test");
const assert = require("node:assert/strict");

const { AgentOrchestrator } = require("../src/orchestrator");
const { TaskStore } = require("../src/taskStore");
const { planWorkflow } = require("../src/plannerAgent");
const { resolveEditIntentRuleOnly } = require("./orchestratorResolveRule");

function makeBaseTask(taskStore, taskId) {
  taskStore.create({
    taskId,
    conversationId: "conv_edit_slides",
    state: "detecting",
    currentStepId: null,
    steps: [
      { stepId: "step_extract_intent", label: "提取意图", status: "pending" },
      { stepId: "step_planning", label: "生成执行计划", status: "pending" },
      { stepId: "step_create_slides", label: "创建演示稿", status: "pending" },
      { stepId: "step_send_delivery_message", label: "回 IM 交付", status: "pending" },
    ],
    artifacts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastError: null,
  });
}

test("orchestrator: slides UPDATE_BLOCK 在已有稿上走 slide replace，不做 delete+create", async () => {
  const calls = [];
  let bundleCalls = 0;
  const taskStore = new TaskStore();
  const taskId = "task_edit_slides_1";
  makeBaseTask(taskStore, taskId);
  setTimeout(() => {
    taskStore.resolveConfirm(taskId, "step_risk_guard", true, null);
  }, 0);

  const orch = new AgentOrchestrator({
    parseIntent: () => ({ output_type: "ppt", doc_type: "report", ppt_type: "review", scenario: "review" }),
    parseEditIntent: () => ({
      isEdit: true,
      target: "slides",
      operation: "UPDATE_BLOCK",
      selector: { pageIndex: 2 },
      payload: { from: "旧标题", title: "阶段复盘", to: "本周风险收敛与下一步" },
      confidence: 0.9,
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
      steps: [{ stepId: "step_create_slides", label: "创建演示稿", status: "pending" }],
      tasks: [],
      risks: { needsConfirm: false, reason: "" },
    }),
    generateContentBundle: async () => {
      bundleCalls += 1;
      return {
        confidence: 0.9,
        rewrittenSlidesPlan: {
          slides: [{ title: "旧标题", bullets: ["旧内容A", "旧内容B"] }],
        },
        summaryMd: "## 摘要\n- x",
        requirementsMd: "## 需求\n- x",
        clarifyMd: "## 澄清\n- x",
        outlineMd: "## 大纲\n- x",
      };
    },
    buildDocsCreateArgs: () => ["docs", "+create"],
    buildDocsUpdateArgs: () => ["docs", "+update"],
    buildSlidesCreateArgs: (x) => ["slides", "+create", JSON.stringify(x)],
    buildSlidesXmlPresentationsGetArgs: () => ["slides", "xml_presentations", "get"],
    buildSlidesXmlPresentationSlideDeleteArgs: () => ["slides", "xml_presentation.slide", "delete"],
    buildSlidesXmlPresentationSlideGetArgs: () => ["slides", "xml_presentation.slide", "get"],
    buildSlidesXmlPresentationSlideReplaceArgs: () => ["slides", "xml_presentation.slide", "replace"],
    buildImMessagesSendArgs: () => ["im", "+messages-send"],
    runLarkCli: async (args, options = {}) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      calls.push({ cmd, stdin: options.stdin || "" });
      if (cmd.includes("slides +create")) {
        return { stdout: JSON.stringify({ data: { url: "https://example.com/slides/xyz" } }) };
      }
      if (cmd.includes("xml_presentations") && cmd.includes("get")) {
        return { stdout: JSON.stringify({ data: { slides: [{ slide_id: "s1" }, { slide_id: "s2" }, { slide_id: "s3" }] } }) };
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
    conversationId: "conv_edit_slides",
    input: "请把 https://example.com/slides/xyz 第2页标题改为阶段复盘，并替换成最新结论",
    contextSummary: "",
    targetArtifacts: ["slides"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: false, defaultIdentity: "user", slidesIdentity: "user" },
  });

  assert.ok(calls.some((x) => x.cmd.includes("xml_presentation.slide replace")));
  assert.ok(!calls.some((x) => x.cmd.includes("xml_presentation.slide delete")));
  assert.ok(!calls.some((x) => x.cmd.includes("slides +create")), "编辑已有稿不应先新建空白演示文稿");
  const rep = calls.find((x) => x.cmd.includes("xml_presentation.slide replace"));
  assert.ok(rep && rep.stdin.includes("本周风险收敛与下一步"));
  assert.equal(bundleCalls, 0, "编辑短路应跳过 generateContentBundle");
  const done = taskStore.get(taskId);
  assert.equal(done.state, "idle");
  assert.ok(done.artifacts.some((a) => a.kind === "note" && String(a.title).includes("编辑短路")));
  assert.ok(done.artifacts.some((a) => a.kind === "note" && String(a.title).includes("PPT编辑")));
});

test("orchestrator: slides UPDATE_BLOCK 在提供 from/to 时走 xml_presentation.slide replace", async () => {
  const calls = [];
  const taskStore = new TaskStore();
  const taskId = "task_edit_slides_replace_1";
  makeBaseTask(taskStore, taskId);
  setTimeout(() => {
    taskStore.resolveConfirm(taskId, "step_risk_guard", true, null);
  }, 0);

  const orch = new AgentOrchestrator({
    parseIntent: () => ({ output_type: "ppt", doc_type: "report", ppt_type: "review", scenario: "review" }),
    parseEditIntent: () => ({
      isEdit: true,
      target: "slides",
      operation: "UPDATE_BLOCK",
      selector: { pageIndex: 2 },
      payload: { from: "旧标题", to: "新标题", title: "阶段复盘" },
      confidence: 0.9,
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
      steps: [{ stepId: "step_create_slides", label: "创建演示稿", status: "pending" }],
      tasks: [],
      risks: { needsConfirm: false, reason: "" },
    }),
    generateContentBundle: async () => ({
      confidence: 0.9,
      rewrittenSlidesPlan: { slides: [{ title: "x", bullets: ["a"] }] },
      summaryMd: "",
      requirementsMd: "",
      clarifyMd: "",
      outlineMd: "",
    }),
    buildDocsCreateArgs: () => ["docs", "+create"],
    buildDocsUpdateArgs: () => ["docs", "+update"],
    buildSlidesCreateArgs: (x) => ["slides", "+create", JSON.stringify(x)],
    buildSlidesXmlPresentationsGetArgs: () => ["slides", "xml_presentations", "get"],
    buildSlidesXmlPresentationSlideDeleteArgs: () => ["slides", "xml_presentation.slide", "delete"],
    buildSlidesXmlPresentationSlideGetArgs: () => ["slides", "xml_presentation.slide", "get"],
    buildSlidesXmlPresentationSlideReplaceArgs: () => ["slides", "xml_presentation.slide", "replace"],
    buildImMessagesSendArgs: () => ["im", "+messages-send"],
    runLarkCli: async (args, options = {}) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      calls.push({ cmd, stdin: options.stdin || "" });
      if (cmd.includes("slides +create")) {
        return { stdout: JSON.stringify({ data: { url: "https://example.com/slides/xyz" } }) };
      }
      if (cmd.includes("xml_presentations") && cmd.includes("get") && !cmd.includes("slide get")) {
        return { stdout: JSON.stringify({ data: { slides: [{ slide_id: "s1" }, { slide_id: "s2" }, { slide_id: "s3" }] } }) };
      }
      if (cmd.includes("xml_presentation.slide replace")) {
        return { stdout: JSON.stringify({ ok: true, data: {} }) };
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
    conversationId: "conv_edit_slides",
    input: "请把 https://example.com/slides/xyz 第2页里旧标题改成新标题",
    contextSummary: "",
    targetArtifacts: ["slides"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: false, defaultIdentity: "user", slidesIdentity: "user" },
  });

  assert.ok(calls.some((x) => x.cmd.includes("xml_presentation.slide replace")));
  assert.ok(!calls.some((x) => x.cmd.includes("xml_presentation.slide delete")));
  const rep = calls.find((x) => x.cmd.includes("replace"));
  assert.ok(rep.stdin.includes("旧标题") && rep.stdin.includes("新标题"));
  assert.ok(!calls.some((x) => x.cmd.includes("slides +create")), "replace 已有稿不应先新建空白演示文稿");
});

test("orchestrator: 删除最后一页仅操作原稿且不新建空白演示稿", async () => {
  const calls = [];
  const taskStore = new TaskStore();
  const taskId = "task_edit_slides_del_last_1";
  makeBaseTask(taskStore, taskId);
  setTimeout(() => {
    taskStore.resolveConfirm(taskId, "step_risk_guard", true, null);
  }, 0);

  const orch = new AgentOrchestrator({
    parseIntent: () => ({ output_type: "ppt", doc_type: "report", ppt_type: "review", scenario: "review" }),
    parseEditIntent: () => ({
      isEdit: true,
      target: "slides",
      operation: "DELETE_BLOCK",
      selector: { lastPage: true },
      payload: {},
      confidence: 0.85,
      needsConfirm: true,
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
      steps: [{ stepId: "step_create_slides", label: "创建演示稿", status: "pending" }],
      tasks: [],
      risks: { needsConfirm: false, reason: "" },
    }),
    generateContentBundle: async () => ({
      confidence: 0.9,
      rewrittenSlidesPlan: { slides: [{ title: "x", bullets: ["a"] }] },
      summaryMd: "",
      requirementsMd: "",
      clarifyMd: "",
      outlineMd: "",
    }),
    buildDocsCreateArgs: () => ["docs", "+create"],
    buildDocsUpdateArgs: () => ["docs", "+update"],
    buildSlidesCreateArgs: (x) => ["slides", "+create", JSON.stringify(x)],
    buildSlidesXmlPresentationsGetArgs: () => ["slides", "xml_presentations", "get"],
    buildSlidesXmlPresentationSlideDeleteArgs: () => ["slides", "xml_presentation.slide", "delete"],
    buildSlidesXmlPresentationSlideGetArgs: () => ["slides", "xml_presentation.slide", "get"],
    buildSlidesXmlPresentationSlideReplaceArgs: () => ["slides", "xml_presentation.slide", "replace"],
    buildImMessagesSendArgs: () => ["im", "+messages-send"],
    runLarkCli: async (args, options = {}) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      calls.push({ cmd, stdin: options.stdin || "" });
      if (cmd.includes("xml_presentations") && cmd.includes("get") && !cmd.includes("slide get")) {
        return {
          stdout: JSON.stringify({
            data: { slides: [{ slide_id: "s1" }, { slide_id: "s2" }, { slide_id: "sLast" }] },
          }),
        };
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
    conversationId: "conv_edit_slides",
    input: "删除最后一页",
    contextSummary: "链接 https://example.com/slides/xyz",
    targetArtifacts: ["slides"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: false, defaultIdentity: "user", slidesIdentity: "user" },
  });

  assert.ok(!calls.some((x) => x.cmd.includes("slides +create")), "纯删除最后一页不应新建演示稿");
  assert.ok(calls.some((x) => x.cmd.includes("xml_presentation.slide delete")));
  const done = taskStore.get(taskId);
  assert.equal(done.state, "idle");
  const slidesArt = done.artifacts.find((a) => a.kind === "slides");
  assert.ok(slidesArt && String(slidesArt.url).includes("example.com/slides/xyz"));
});

test("orchestrator: slides INSERT_BLOCK 在目标页后新增一页", async () => {
  const calls = [];
  const taskStore = new TaskStore();
  const taskId = "task_edit_slides_insert_1";
  makeBaseTask(taskStore, taskId);
  setTimeout(() => {
    taskStore.resolveConfirm(taskId, "step_risk_guard", true, null);
  }, 0);

  const orch = new AgentOrchestrator({
    parseIntent: () => ({ output_type: "ppt", doc_type: "report", ppt_type: "review", scenario: "review" }),
    parseEditIntent: () => ({
      isEdit: true,
      target: "slides",
      operation: "INSERT_BLOCK",
      selector: { pageIndex: 2 },
      payload: { title: "新增风险页", content: "风险A/风险B" },
      confidence: 0.9,
      needsConfirm: false,
    }),
    resolveEditIntent: resolveEditIntentRuleOnly,
    buildEditPlan: ({ editIntent }) => ({ ...editIntent, mode: "append", maxChanges: 1, needsConfirm: false }),
    planWorkflow: async () => ({
      planVersion: 1,
      steps: [{ stepId: "step_create_slides", label: "创建演示稿", status: "pending" }],
      tasks: [],
      risks: { needsConfirm: false, reason: "" },
    }),
    generateContentBundle: async () => ({ confidence: 0.9, rewrittenSlidesPlan: { slides: [{ title: "x", bullets: ["a"] }] } }),
    buildDocsCreateArgs: () => ["docs", "+create"],
    buildDocsUpdateArgs: () => ["docs", "+update"],
    buildSlidesCreateArgs: (x) => ["slides", "+create", JSON.stringify(x)],
    buildSlidesXmlPresentationsGetArgs: () => ["slides", "xml_presentations", "get"],
    buildSlidesXmlPresentationSlideDeleteArgs: () => ["slides", "xml_presentation.slide", "delete"],
    buildSlidesXmlPresentationSlideGetArgs: () => ["slides", "xml_presentation.slide", "get"],
    buildSlidesXmlPresentationSlideReplaceArgs: () => ["slides", "xml_presentation.slide", "replace"],
    buildImMessagesSendArgs: () => ["im", "+messages-send"],
    runLarkCli: async (args, options = {}) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      calls.push({ cmd, stdin: options.stdin || "" });
      if (cmd.includes("xml_presentations") && cmd.includes("get")) {
        return { stdout: JSON.stringify({ data: { slides: [{ slide_id: "s1" }, { slide_id: "s2" }, { slide_id: "s3" }] } }) };
      }
      return { stdout: JSON.stringify({ ok: true, data: { code: 0 } }) };
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
    conversationId: "conv_edit_slides",
    input: "在 https://example.com/slides/xyz 第2页后新增一页，标题新增风险页",
    contextSummary: "",
    targetArtifacts: ["slides"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: false, defaultIdentity: "user", slidesIdentity: "user" },
  });

  assert.ok(calls.some((x) => x.cmd.includes("xml_presentation.slide create")));
  assert.ok(!calls.some((x) => x.cmd.includes("xml_presentation.slide delete")));
});

test("orchestrator: slides INSERT_BLOCK 合并上下文含「最后一页」时仍以显式第N页定位 before_slide_id", async () => {
  const calls = [];
  const taskStore = new TaskStore();
  const taskId = "task_edit_slides_insert_lastpage_ctx_1";
  makeBaseTask(taskStore, taskId);
  setTimeout(() => {
    taskStore.resolveConfirm(taskId, "step_risk_guard", true, null);
  }, 0);

  const orch = new AgentOrchestrator({
    parseIntent: () => ({ output_type: "ppt", doc_type: "report", ppt_type: "review", scenario: "review" }),
    parseEditIntent: () => ({
      isEdit: true,
      target: "slides",
      operation: "INSERT_BLOCK",
      selector: { pageIndex: 2, lastPage: true },
      payload: { title: "插页", content: "a；b" },
      confidence: 0.9,
      needsConfirm: false,
    }),
    resolveEditIntent: resolveEditIntentRuleOnly,
    buildEditPlan: ({ editIntent }) => ({ ...editIntent, mode: "append", maxChanges: 1, needsConfirm: false }),
    planWorkflow: async () => ({
      planVersion: 1,
      steps: [{ stepId: "step_create_slides", label: "创建演示稿", status: "pending" }],
      tasks: [],
      risks: { needsConfirm: false, reason: "" },
    }),
    generateContentBundle: async () => ({ confidence: 0.9, rewrittenSlidesPlan: { slides: [{ title: "x", bullets: ["a"] }] } }),
    buildDocsCreateArgs: () => ["docs", "+create"],
    buildDocsUpdateArgs: () => ["docs", "+update"],
    buildSlidesCreateArgs: (x) => ["slides", "+create", JSON.stringify(x)],
    buildSlidesXmlPresentationsGetArgs: () => ["slides", "xml_presentations", "get"],
    buildSlidesXmlPresentationSlideDeleteArgs: () => ["slides", "xml_presentation.slide", "delete"],
    buildSlidesXmlPresentationSlideGetArgs: () => ["slides", "xml_presentation.slide", "get"],
    buildSlidesXmlPresentationSlideReplaceArgs: () => ["slides", "xml_presentation.slide", "replace"],
    buildImMessagesSendArgs: () => ["im", "+messages-send"],
    runLarkCli: async (args, options = {}) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      calls.push({ cmd, stdin: options.stdin || "" });
      if (cmd.includes("xml_presentations") && cmd.includes("get")) {
        return { stdout: JSON.stringify({ data: { slides: [{ slide_id: "s1" }, { slide_id: "s2" }, { slide_id: "s3" }] } }) };
      }
      return { stdout: JSON.stringify({ ok: true, data: { code: 0 } }) };
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
    conversationId: "conv_edit_slides",
    input: "在 https://example.com/slides/xyz 第2页后新增一页",
    contextSummary: "另：待办删除最后一页旧备份",
    targetArtifacts: ["slides"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: false, defaultIdentity: "user", slidesIdentity: "user" },
  });

  const createCall = calls.find((x) => x.cmd.includes("xml_presentation.slide create"));
  assert.ok(createCall);
  const afterParams = createCall.cmd.split("--params ").pop() || "";
  const paramsJson = afterParams.split(" --data")[0];
  const params = JSON.parse(paramsJson);
  assert.ok(!params.before_slide_id, "before_slide_id 必须在 --data body，不能放在 --params");
  const stdinObj = JSON.parse(String(createCall.stdin || "{}"));
  assert.equal(stdinObj.before_slide_id, "s3");
  assert.ok(String(stdinObj.slide?.content || "").includes("a") && String(stdinObj.slide?.content || "").includes("b"));
});

test("orchestrator: slides UPDATE_BLOCK 条件不足时失败，不走 delete+create", async () => {
  const calls = [];
  const taskStore = new TaskStore();
  const taskId = "task_edit_slides_patch_miss_1";
  makeBaseTask(taskStore, taskId);
  setTimeout(() => {
    taskStore.resolveConfirm(taskId, "step_risk_guard", true, null);
  }, 0);

  const orch = new AgentOrchestrator({
    parseIntent: () => ({ output_type: "ppt", doc_type: "report", ppt_type: "review", scenario: "review" }),
    parseEditIntent: () => ({
      isEdit: true,
      target: "slides",
      operation: "UPDATE_BLOCK",
      selector: { pageIndex: 1 },
      payload: { from: "口头旧文案不会出现在XML", to: "应用新结论", title: "定制页标题" },
      confidence: 0.9,
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
      steps: [{ stepId: "step_create_slides", label: "创建演示稿", status: "pending" }],
      tasks: [],
      risks: { needsConfirm: false, reason: "" },
    }),
    generateContentBundle: async () => ({
      confidence: 0.9,
      rewrittenSlidesPlan: { slides: [{ title: "x", bullets: ["a"] }] },
      summaryMd: "",
      requirementsMd: "",
      clarifyMd: "",
      outlineMd: "",
    }),
    buildDocsCreateArgs: () => ["docs", "+create"],
    buildDocsUpdateArgs: () => ["docs", "+update"],
    buildSlidesCreateArgs: (x) => ["slides", "+create", JSON.stringify(x)],
    buildSlidesXmlPresentationsGetArgs: () => ["slides", "xml_presentations", "get"],
    buildSlidesXmlPresentationSlideDeleteArgs: () => ["slides", "xml_presentation.slide", "delete"],
    buildSlidesXmlPresentationSlideGetArgs: () => ["slides", "xml_presentation.slide", "get"],
    buildSlidesXmlPresentationSlideReplaceArgs: () => ["slides", "xml_presentation.slide", "replace"],
    buildImMessagesSendArgs: () => ["im", "+messages-send"],
    runLarkCli: async (args, options = {}) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      calls.push({ cmd, stdin: options.stdin || "" });
      if (cmd.includes("xml_presentation.slide replace")) return { stdout: JSON.stringify({}) };
      if (cmd.includes("xml_presentation.slide") && cmd.includes("get") && !cmd.includes("xml_presentations")) {
        return {
          stdout: JSON.stringify({
            data: { slide: { content: "<slide><p>服务端返回的片段</p></slide>" } },
          }),
        };
      }
      if (cmd.includes("xml_presentations") && cmd.includes("get")) {
        return { stdout: JSON.stringify({ data: { slides: [{ slide_id: "s1" }] } }) };
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
    conversationId: "conv_edit_slides",
    input: "请改 https://example.com/slides/abc 第1页",
    contextSummary: "",
    targetArtifacts: ["slides"],
    delivery: { channel: "im_chat", chatId: "" },
    execution: { dryRun: false, defaultIdentity: "user", slidesIdentity: "user" },
  });

  assert.ok(!calls.some((x) => x.cmd.includes("xml_presentation.slide create")));
  const done = taskStore.get(taskId);
  assert.equal(done.state, "failed");
});

test("orchestrator: slides 编辑短路时任务面板为精简步骤（不展示整稿大纲链路）", async () => {
  const calls = [];
  const taskStore = new TaskStore();
  const taskId = "task_edit_slides_min_plan_ui_1";
  makeBaseTask(taskStore, taskId);
  setTimeout(() => {
    taskStore.resolveConfirm(taskId, "step_risk_guard", true, null);
  }, 0);

  let bundleCalls = 0;
  const orch = new AgentOrchestrator({
    parseIntent: () => ({ output_type: "ppt", doc_type: "report", ppt_type: "review", scenario: "review" }),
    resolveEditIntent: resolveEditIntentRuleOnly,
    planWorkflow,
    generateContentBundle: async () => {
      bundleCalls += 1;
      throw new Error("编辑短路不应调用全量 generateContentBundle");
    },
    buildDocsCreateArgs: () => ["docs", "+create"],
    buildDocsUpdateArgs: () => ["docs", "+update"],
    buildSlidesCreateArgs: (x) => ["slides", "+create", JSON.stringify(x)],
    buildSlidesXmlPresentationsGetArgs: () => ["slides", "xml_presentations", "get"],
    buildSlidesXmlPresentationSlideDeleteArgs: () => ["slides", "xml_presentation.slide", "delete"],
    buildSlidesXmlPresentationSlideGetArgs: () => ["slides", "xml_presentation.slide", "get"],
    buildSlidesXmlPresentationSlideReplaceArgs: () => ["slides", "xml_presentation.slide", "replace"],
    buildImMessagesSendArgs: () => ["im", "+messages-send"],
    runLarkCli: async (args, options = {}) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      calls.push({ cmd, stdin: options.stdin || "" });
      if (cmd.includes("xml_presentations") && cmd.includes("get")) {
        return { stdout: JSON.stringify({ data: { slides: [{ slide_id: "s1" }, { slide_id: "s2" }, { slide_id: "s3" }] } }) };
      }
      return { stdout: JSON.stringify({ ok: true, data: { code: 0 } }) };
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
    conversationId: "conv_edit_slides",
    input:
      "在 https://example.com/slides/xyz 第2页后新增一页，标题「风险清单」，内容「风险A；风险B」",
    contextSummary: "（不应影响编辑解析）整稿生成大纲与澄清",
    targetArtifacts: ["slides"],
    delivery: { channel: "im_chat", chatId: "c1" },
    execution: { dryRun: false, defaultIdentity: "user", slidesIdentity: "user" },
  });

  const done = taskStore.get(taskId);
  assert.equal(done.state, "idle");
  assert.equal(bundleCalls, 0);
  const ids = done.steps.map((s) => s.stepId);
  assert.ok(!ids.includes("step_make_outline"), "不应出现整稿大纲步骤");
  assert.ok(!ids.includes("step_fetch_context"), "编辑短路不应拉取长上下文规划步骤");
  assert.ok(ids.includes("step_create_slides"));
  const slideStep = done.steps.find((s) => s.stepId === "step_create_slides");
  assert.ok(slideStep && String(slideStep.label).includes("按页编辑"));
  assert.ok(done.taskPlan?.meta?.edit_short_circuit === true);
});

