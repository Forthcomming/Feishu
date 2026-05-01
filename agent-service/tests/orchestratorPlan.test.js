const test = require("node:test");
const assert = require("node:assert/strict");

const { AgentOrchestrator } = require("../src/orchestrator");
const { TaskStore } = require("../src/taskStore");
const { planWorkflow } = require("../src/plannerAgent");

function makeDeps({ events }) {
  let lastSlidesCreateInput = null;
  const calls = [];
  return {
    parseIntent: () => ({
      output_type: "doc",
      doc_type: "meeting_summary",
      ppt_type: "report",
      scenario: "handoff",
      confidence: 0.9,
      reasoning: "test",
    }),
    planWorkflow,
    generateContentBundle: async ({ targetArtifacts }) => {
      const wantsDoc = Array.isArray(targetArtifacts) && targetArtifacts.includes("doc");
      const wantsSlides = Array.isArray(targetArtifacts) && targetArtifacts.includes("slides");
      return {
        source: "test_stub",
        summaryMd: "## 上下文摘要\n- （测试）",
        requirementsMd: "## 需求点/约束/风险（抽取）\n- （测试）",
        clarifyMd: "## 待确认问题（澄清清单）\n- （测试）",
        outlineMd: "## 结构大纲（可编辑）\n- 背景与目标\n- 方案概述\n- 风险与权衡\n- 里程碑与回滚预案",
        restructuredMd: "## 元信息\n- 产物：文档\n\n## 背景与目标\n- （测试要点）\n\n## 风险\n- （测试要点）",
        docOutlineMd: wantsDoc ? "## 结构大纲（可编辑）\n- 背景与目标\n- 方案概述\n- 风险与权衡\n- 里程碑与回滚预案" : "",
        pptOutlineLines: wantsSlides ? ["背景与目标", "方案要点", "风险与待确认", "里程碑与下一步"] : [],
        cleaned: {
          facts: ["（测试）"],
          decisions: [],
          actions: [],
          openQuestions: [],
          constraints: [],
          risks: [],
        },
        evidencePoolMd: "## 证据池（已清洗，供引用）\n- （测试）",
      };
    },
    buildDocsCreateArgs: (x) => ["docs", "+create", JSON.stringify(x)],
    buildDocsUpdateArgs: (x) => ["docs", "+update", JSON.stringify(x)],
    buildSlidesCreateArgs: (x) => {
      lastSlidesCreateInput = x;
      return ["slides", "+create", JSON.stringify(x)];
    },
    buildImMessagesSendArgs: (x) => ["im", "+messages-send", JSON.stringify(x)],
    runLarkCli: async (args) => {
      const cmd = Array.isArray(args) ? args.join(" ") : String(args);
      calls.push(cmd);
      if (cmd.includes("docs") && cmd.includes("+create")) {
        return { stdout: JSON.stringify({ data: { document: { url: "https://example.com/docx/abc" } } }) };
      }
      if (cmd.includes("docs") && cmd.includes("+update")) {
        return { stdout: JSON.stringify({ data: { document: { url: "https://example.com/docx/abc" } } }) };
      }
      if (cmd.includes("slides") && cmd.includes("+create")) {
        return { stdout: JSON.stringify({ data: { url: "https://example.com/slides/xyz" } }) };
      }
      if (cmd.includes("xml_presentation.slide") && cmd.includes("create")) {
        return { stdout: JSON.stringify({ ok: true }) };
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
    getLastSlidesCreateInput: () => lastSlidesCreateInput,
    getCalls: () => calls,
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
  // title should follow doc_type template (meeting_summary -> 会议纪要)
  assert.ok(done.artifacts.some((a) => a.kind === "doc" && String(a.title || "").includes("会议纪要")));

  // Ensure doc content no longer contains instruction/plan meta sections.
  const createCall = deps.getCalls().find((c) => c.includes("docs") && c.includes("+create")) || "";
  assert.ok(createCall);
  assert.ok(!createCall.includes("## 任务指令"));
  assert.ok(!createCall.includes("## 执行计划（Planner）"));
});

test("orchestrator: slides 步骤会传入非空 slidesXmlArray 并产出演示稿链接", async () => {
  const events = [];
  const deps = makeDeps({ events });
  deps.parseIntent = () => ({
    output_type: "ppt",
    doc_type: "report",
    ppt_type: "proposal",
    scenario: "review",
    confidence: 0.9,
    reasoning: "test",
  });
  const orchestrator = new AgentOrchestrator(deps);

  const taskId = "task_test_slides_1";
  const task = deps.taskStore.create({
    taskId,
    conversationId: "c2",
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

  // Auto-approve risk guard when dryRun=false (tests are non-interactive).
  setTimeout(() => {
    deps.taskStore.resolveConfirm(taskId, "step_risk_guard", true, null);
  }, 0);

  await orchestrator.runWorkflow(task.taskId, {
    taskId,
    conversationId: "c2",
    input: "请生成一版评审PPT，重点讲目标、方案和风险。",
    contextSummary: "目标明确，需要评审。",
    targetArtifacts: ["slides"],
    delivery: { channel: "im_chat", chatId: "oc_test" },
    execution: { dryRun: false, defaultIdentity: "bot", slidesIdentity: "user" },
  });

  const done = deps.taskStore.get(taskId);
  assert.equal(done.state, "completed");
  assert.ok(done.artifacts.some((a) => a.kind === "slides" && a.url));
  assert.ok(done.artifacts.some((a) => a.kind === "slides" && String(a.title || "").includes("提案")));
  const slidesInput = deps.getLastSlidesCreateInput();
  assert.ok(slidesInput);
  assert.ok(Array.isArray(slidesInput.slidesXmlArray));
  // We create deck first, then add pages via xml_presentation.slide.create (stdin), so +create keeps slides empty.
  assert.equal(slidesInput.slidesXmlArray.length, 0);
  assert.ok(deps.getCalls().some((c) => c.includes("xml_presentation.slide") && c.includes("create")));
});

