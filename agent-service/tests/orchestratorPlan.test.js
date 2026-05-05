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
        confidence: 0.9,
        summaryMd: "## 上下文摘要\n- （测试）",
        requirementsMd: "## 需求点/约束/风险（抽取）\n- （测试）",
        clarifyMd: "## 待确认问题（澄清清单）\n- （测试）",
        outlineMd: "## 结构大纲（可编辑）\n- 背景与目标\n- 方案概述\n- 风险与权衡\n- 里程碑与回滚预案",
        restructuredMd: "## 元信息\n- 产物：文档\n\n## 背景与目标\n- （测试要点）\n\n## 风险\n- （测试要点）",
        docOutlineMd: wantsDoc ? "## 结构大纲（可编辑）\n- 背景与目标\n- 方案概述\n- 风险与权衡\n- 里程碑与回滚预案" : "",
        pptOutlineLines: wantsSlides ? ["背景与目标", "方案要点", "风险与待确认", "里程碑与下一步"] : [],
        rewrittenSlidesPlan: wantsSlides
          ? {
              confidence: 0.8,
              slides: [
                { title: "提案演示稿（封面）", bullets: ["目标与范围", "关键方案", "风险与里程碑"] },
                { title: "机会与目标", bullets: ["当前问题概述", "目标指标与收益", "适用范围与边界"] },
                { title: "提案概述", bullets: ["整体思路", "关键能力清单", "交互/流程要点"] },
                { title: "实施方案", bullets: ["模块拆分", "关键接口与依赖", "落地路径"] },
                { title: "风险与备选", bullets: ["主要风险", "缓解措施", "回滚/兜底"] },
                { title: "需要决策/支持", bullets: ["关键假设确认", "资源与排期确认", "评审结论与下一步"] },
              ],
            }
          : undefined,
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
  assert.equal(done.state, "idle");
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
  assert.equal(done.state, "idle");
  assert.ok(done.artifacts.some((a) => a.kind === "slides" && a.url));
  assert.ok(done.artifacts.some((a) => a.kind === "slides" && String(a.title || "").includes("提案")));
  const slidesInput = deps.getLastSlidesCreateInput();
  assert.ok(slidesInput);
  assert.ok(Array.isArray(slidesInput.slidesXmlArray));
  // We create deck first, then add pages via xml_presentation.slide.create (stdin), so +create keeps slides empty.
  assert.equal(slidesInput.slidesXmlArray.length, 0);
  assert.ok(deps.getCalls().some((c) => c.includes("xml_presentation.slide") && c.includes("create")));
});

test("orchestrator: CONTENT_CONFIDENCE_MIN 触发时跳过文档写入", async (t) => {
  t.after(() => {
    delete process.env.CONTENT_CONFIDENCE_MIN;
    delete process.env.REFLECTING_PHASE_MS;
  });
  process.env.CONTENT_CONFIDENCE_MIN = "0.95";
  process.env.REFLECTING_PHASE_MS = "0";

  const events = [];
  const deps = makeDeps({ events });
  deps.generateContentBundle = async ({ targetArtifacts }) => {
    const wantsDoc = Array.isArray(targetArtifacts) && targetArtifacts.includes("doc");
    const wantsSlides = Array.isArray(targetArtifacts) && targetArtifacts.includes("slides");
    return {
      source: "test_stub",
      confidence: 0.2,
      summaryMd: "## 上下文摘要\n- （测试）",
      requirementsMd: "## 需求点/约束/风险（抽取）\n- （测试）",
      clarifyMd: "## 待确认问题（澄清清单）\n- （测试）",
      outlineMd: "## 结构大纲（可编辑）\n- 背景与目标\n- 方案概述\n- 风险与权衡\n- 里程碑与回滚预案",
      restructuredMd: "## 元信息\n- 产物：文档\n\n## 背景与目标\n- （测试要点）\n\n## 风险\n- （测试要点）",
      docOutlineMd: wantsDoc ? "## 结构大纲（可编辑）\n- 背景与目标\n- 方案概述\n- 风险与权衡\n- 里程碑与回滚预案" : "",
      pptOutlineLines: wantsSlides ? ["背景与目标", "方案要点", "风险与待确认", "里程碑与下一步"] : [],
      rewrittenSlidesPlan: wantsSlides
        ? {
            confidence: 0.8,
            slides: [
              { title: "提案演示稿（封面）", bullets: ["目标与范围", "关键方案", "风险与里程碑"] },
              { title: "机会与目标", bullets: ["当前问题概述", "目标指标与收益", "适用范围与边界"] },
              { title: "提案概述", bullets: ["整体思路", "关键能力清单", "交互/流程要点"] },
              { title: "实施方案", bullets: ["模块拆分", "关键接口与依赖", "落地路径"] },
              { title: "风险与备选", bullets: ["主要风险", "缓解措施", "回滚/兜底"] },
              { title: "需要决策/支持", bullets: ["关键假设确认", "资源与排期确认", "评审结论与下一步"] },
            ],
          }
        : undefined,
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
  };

  const orchestrator = new AgentOrchestrator(deps);
  const taskId = "task_test_gate";
  const task = deps.taskStore.create({
    taskId,
    conversationId: "c_gate",
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

  setTimeout(() => {
    deps.taskStore.resolveConfirm(taskId, "step_risk_guard", true, null);
  }, 0);

  await orchestrator.runWorkflow(task.taskId, {
    taskId,
    conversationId: "c_gate",
    input: "请把讨论整理成需求文档并回传链接",
    contextSummary: "（测试上下文摘要）",
    targetArtifacts: ["doc"],
    delivery: { channel: "im_chat", chatId: "oc_x" },
    execution: { dryRun: false, defaultIdentity: "bot" },
  });

  const done = deps.taskStore.get(taskId);
  assert.equal(done.state, "idle");
  assert.ok(!done.artifacts.some((a) => a.kind === "doc"));
  assert.ok(done.artifacts.some((a) => a.kind === "note" && String(a.title || "").includes("置信度")));
  assert.ok(!deps.getCalls().some((c) => c.includes("docs") && c.includes("+create")));
  assert.ok(!deps.getCalls().some((c) => c.includes("im") && c.includes("+messages-send")));
});

