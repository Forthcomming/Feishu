const { artifactEvent, errorEvent, stateEvent, stepEvent } = require("./taskEvents");
const { confirmRequiredEvent } = require("./taskEvents");
const { generateContentBundle } = require("./contentAgent");
const { generateSlidesXmlArray } = require("./contentAgent");
const { resolveDocTemplate, resolveSlidesTemplate } = require("./intentTemplates");

function makeStep(stepId, label) {
  return { stepId, label, status: "pending" };
}

function safeText(value, max = 240) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function summarizeForTrace(key, value) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return { len: 0, preview: "" };
  // Large inputs make notes unreadable; only keep length.
  if (key === "raw_messages" || key === "source_text") {
    return { len: s.length, preview: "" };
  }
  // Keep very short preview for readability.
  const preview = safeText(s.replace(/\s+/g, " "), 80);
  return { len: s.length, preview };
}

function extractTaskFromStep(stepId, taskDefsByStepId) {
  if (!stepId || !taskDefsByStepId || typeof taskDefsByStepId.get !== "function") return null;
  return taskDefsByStepId.get(stepId) || null;
}

function buildTaskInputMap({ taskDef, runtime, taskOutputsByField }) {
  const outputType = runtime?.intent?.output_type || "doc";
  const entries = Array.isArray(taskDef?.input_contract) ? taskDef.input_contract : [];
  const out = {};
  for (const key of entries) {
    if (key === "raw_messages" || key === "source_text") out[key] = runtime?.inputText || "";
    else if (key === "context_summary") out[key] = runtime?.contextSummary || "";
    else if (key === "ppt_type") out[key] = runtime?.intent?.ppt_type || "report";
    else if (key === "scenario") out[key] = runtime?.intent?.scenario || "discussion";
    else if (key === "output_type") out[key] = outputType;
    else out[key] = taskOutputsByField[key] || "";
  }
  return out;
}

function pickOutputSourceByTaskName(taskName, bundle, runtime) {
  const b = bundle || {};
  const name = String(taskName || "");
  if (name.includes("risk")) return b.clarifyMd || b.requirementsMd || b.summaryMd || "";
  if (name.includes("requirement") || name.includes("scope") || name.includes("milestone")) return b.requirementsMd || b.outlineMd || "";
  if (name.includes("outline") || name.includes("slide")) return b.outlineMd || b.summaryMd || "";
  if (name.includes("goal") || name.includes("background") || name.includes("problem") || name.includes("solution") || name.includes("architecture")) {
    return b.summaryMd || b.requirementsMd || "";
  }
  if (name.includes("action") || name.includes("decision") || name.includes("key_points")) return b.summaryMd || b.clarifyMd || "";
  return b.summaryMd || runtime?.inputText || "";
}

function buildTaskOutputMap({ taskDef, bundle, runtime }) {
  const outputs = {};
  const source = pickOutputSourceByTaskName(taskDef?.name, bundle, runtime);
  const outputKeys = Array.isArray(taskDef?.output_contract) ? taskDef.output_contract : [];
  for (const key of outputKeys) {
    outputs[key] = source;
  }
  return outputs;
}

function renderTaskTraceArtifact({ taskDef, stepId, inputs, outputs }) {
  const depends = Array.isArray(taskDef?.depends_on) ? taskDef.depends_on : [];
  const scopes = Array.isArray(taskDef?.extract_scope) ? taskDef.extract_scope : [];

  const inputLines = Object.entries(inputs || {}).map(([k, v]) => {
    const { len, preview } = summarizeForTrace(k, v);
    const suffix = preview ? `，预览：${preview}` : "";
    return `- ${k}（len=${len}）${suffix}`;
  });
  const outputLines = Object.entries(outputs || {}).map(([k, v]) => {
    const { len, preview } = summarizeForTrace(k, v);
    const suffix = preview ? `，预览：${preview}` : "";
    return `- ${k}（len=${len}）${suffix}`;
  });
  const title = [
    `DAG任务：${taskDef?.name || stepId}`,
    depends.length ? `依赖：${depends.join(",")}` : "依赖：无",
    scopes.length ? `Scope：${scopes.join(",")}` : "Scope：无",
    "",
    "输入：",
    inputLines.length ? inputLines.join("\n") : "- （无）",
    "",
    "输出：",
    outputLines.length ? outputLines.join("\n") : "- （无）",
  ].join("\n");
  return {
    artifactId: `dag_task_${Date.now()}_${String(stepId || "").slice(-18)}`,
    kind: "note",
    title,
    url: "",
  };
}

function pickDocUrl(result) {
  if (!result || typeof result !== "object") return null;
  const stack = [result];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    for (const [k, v] of Object.entries(cur)) {
      if (typeof v === "string") {
        const key = k.toLowerCase();
        if ((key.includes("url") || key.includes("link")) && /^https?:\/\//.test(v)) return v;
      } else if (v && typeof v === "object") {
        stack.push(v);
      }
    }
  }
  return null;
}

function pickDocsCreateUrl(parsedValue) {
  // Prefer explicit known shapes from lark-cli docs +create output.
  const v = parsedValue && typeof parsedValue === "object" ? parsedValue : null;
  const urlCandidates = [
    v?.data?.document?.url,
    v?.document?.url,
    v?.result?.data?.document?.url,
    v?.data?.url,
    v?.url,
  ];
  for (const c of urlCandidates) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) return c;
  }
  return pickDocUrl(v);
}

function pickDocUrlFromText(stdout) {
  const s = String(stdout || "");
  // Feishu docx link shape: /docx/<token>
  const m = s.match(/https?:\/\/[^\s"']+\/docx\/[A-Za-z0-9]+/);
  return m ? m[0] : "";
}

function pickDocTargetFromInput(text) {
  const s = String(text || "");
  const urlMatch = s.match(/https?:\/\/[^\s"']+\/docx\/[A-Za-z0-9]+/);
  if (urlMatch) return urlMatch[0];
  const tokenMatch = s.match(/(?:^|[^A-Za-z0-9])docx\/([A-Za-z0-9]+)(?:$|[^A-Za-z0-9])/);
  if (tokenMatch && tokenMatch[1]) return tokenMatch[1];
  return "";
}

function pickSlidesUrlFromCliOutput(stdout) {
  const s = String(stdout || "");
  // Prefer explicit slides links if present.
  const m = s.match(/https?:\/\/[^\s"']+\/slides\/[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

function pickSlidesCreateUrl(parsedValue) {
  const v = parsedValue && typeof parsedValue === "object" ? parsedValue : null;
  const candidates = [
    v?.data?.slide?.url,
    v?.data?.slides?.url,
    v?.data?.url,
    v?.slide?.url,
    v?.slides?.url,
    v?.url,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) return c;
  }
  return pickDocUrl(v);
}

function normalizeErrorMessage(msg) {
  const s = String(msg || "").trim();
  if (!s) return "未知错误";
  if (s.includes("�")) {
    return "命令执行失败（错误信息编码异常，可能是超时或权限问题，请稍后重试）";
  }
  return s;
}

function shouldFallbackToEmptySlides(err) {
  const s = String(err && err.message ? err.message : err || "")
    .toLowerCase()
    .trim();
  if (!s) return false;
  // Only fallback on explicit XML parsing/validation errors.
  return s.includes("此时不应有 <") || s.includes("unexpected token <") || s.includes("xml");
}

function extractSlidesTokenFromUrl(url) {
  const s = String(url || "").trim();
  const m = s.match(/\/slides\/([A-Za-z0-9]+)/);
  return m ? m[1] : "";
}

function makeSlidesPageCreateArgs({ as, xmlPresentationId, beforeSlideId, dryRun }) {
  const identity = as === "bot" ? "bot" : "user";
  const safeId = String(xmlPresentationId || "").trim();
  const params = { xml_presentation_id: safeId };
  const before = String(beforeSlideId || "").trim();
  if (before) params.before_slide_id = before;
  const args = ["slides", "xml_presentation.slide", "create", "--as", identity, "--params", JSON.stringify(params), "--data", "-"];
  // xml_presentation.slide.create is marked as high-risk-write; require explicit yes when executing.
  args.push("--yes");
  if (dryRun !== false) args.push("--dry-run");
  return args;
}

function pickSlidesTargetFromInput(text) {
  const s = String(text || "");
  const urlMatch = s.match(/https?:\/\/[^\s"']+\/slides\/[A-Za-z0-9]+/);
  if (urlMatch) return urlMatch[0];
  const tokenMatch = s.match(/(?:^|[^A-Za-z0-9])slides\/([A-Za-z0-9]+)(?:$|[^A-Za-z0-9])/);
  if (tokenMatch && tokenMatch[1]) return tokenMatch[1];
  return "";
}

function pickSlidesPageIndexFromInput(text) {
  const s = String(text || "");
  const m1 = s.match(/第\s*(\d{1,3})\s*页/);
  const m2 = s.match(/页码\s*(\d{1,3})/);
  const m3 = s.match(/\bpage\s*(\d{1,3})\b/i);
  const raw = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]) || "";
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const idx = Math.max(1, Math.min(200, Math.floor(n)));
  return idx;
}

function extractSlideIdsFromCliOutput(stdout, tryParseJson) {
  const s = String(stdout || "");
  const parsed = typeof tryParseJson === "function" ? tryParseJson(s) : { ok: false, value: null };
  const ids = [];
  const seen = new Set();
  const push = (id) => {
    const t = String(id || "").trim();
    if (!t) return;
    if (seen.has(t)) return;
    seen.add(t);
    ids.push(t);
  };

  const scanObject = (root) => {
    const stack = [root];
    const visited = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (visited.has(cur)) continue;
      visited.add(cur);
      if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
        continue;
      }
      for (const [k, v] of Object.entries(cur)) {
        const key = String(k || "").toLowerCase();
        if (typeof v === "string" && (key === "slide_id" || key === "slideid")) push(v);
        else if (v && typeof v === "object") stack.push(v);
      }
    }
  };

  if (parsed.ok && parsed.value) scanObject(parsed.value);

  // Fallback to regex scanning (xml or non-json output).
  const re = /(?:slide_id|slideId)\s*[:=]\s*["']([A-Za-z0-9_-]{6,})["']/g;
  let m;
  while ((m = re.exec(s))) push(m[1]);

  return ids;
}

class AgentOrchestrator {
  constructor(deps) {
    this.parseIntent = deps.parseIntent;
    this.planWorkflow = deps.planWorkflow;
    this.generateContentBundle = deps.generateContentBundle || generateContentBundle;
    this.buildDocsCreateArgs = deps.buildDocsCreateArgs;
    this.buildDocsUpdateArgs = deps.buildDocsUpdateArgs;
    this.buildSlidesCreateArgs = deps.buildSlidesCreateArgs;
    this.buildSlidesXmlPresentationsGetArgs = deps.buildSlidesXmlPresentationsGetArgs;
    this.buildSlidesXmlPresentationSlideDeleteArgs = deps.buildSlidesXmlPresentationSlideDeleteArgs;
    this.buildImMessagesSendArgs = deps.buildImMessagesSendArgs;
    this.runLarkCli = deps.runLarkCli;
    this.tryParseJson = deps.tryParseJson;
    this.taskStore = deps.taskStore;
    this.publishTaskEvent = deps.publishTaskEvent;
  }

  async emit(event) {
    await this.publishTaskEvent(event);
  }

  updateStep(task, stepId, status) {
    const nextSteps = task.steps.map((s) => (s.stepId === stepId ? { ...s, status } : s));
    return this.taskStore.update(task.taskId, { steps: nextSteps, currentStepId: status === "running" ? stepId : task.currentStepId });
  }

  async startWorkflow(input) {
    const taskId = input.taskId;
    const now = Date.now();
    const wantsDoc = Array.isArray(input.targetArtifacts) && input.targetArtifacts.includes("doc");
    const wantsSlides = Array.isArray(input.targetArtifacts) && input.targetArtifacts.includes("slides");
    const task = this.taskStore.create({
      taskId,
      conversationId: input.conversationId,
      state: "detecting",
      currentStepId: null,
      steps: [
        makeStep("step_extract_intent", "提取意图"),
        // planning 阶段会用 Planner 输出的 steps 替换这部分列表；这里先给一个最小占位，保证任务面板可见。
        makeStep("step_planning", "生成执行计划"),
        ...(wantsDoc ? [makeStep("step_create_doc", "创建文档")] : []),
        ...(wantsSlides ? [makeStep("step_create_slides", "创建演示稿")] : []),
        makeStep("step_send_delivery_message", "回 IM 交付"),
      ],
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      lastError: null,
    });

    await this.emit(stateEvent(taskId, "detecting"));
    void this.runWorkflow(taskId, input);
    return task;
  }

  async runWorkflow(taskId, input) {
    let task = this.taskStore.get(taskId);
    if (!task) return;
    try {
      if (this.taskStore.isCancelled(taskId)) {
        this.taskStore.update(taskId, { state: "cancelled", currentStepId: null });
        await this.emit(stateEvent(taskId, "cancelled"));
        return;
      }
      task = this.taskStore.update(taskId, { state: "intent" });
      await this.emit(stateEvent(taskId, "intent"));

      task = this.updateStep(task, "step_extract_intent", "running");
      await this.emit(stepEvent(taskId, task.steps.find((s) => s.stepId === "step_extract_intent")));
      const intent = this.parseIntent(input.input, {
        contextSummary: input.contextSummary || "",
        recentMessages: Array.isArray(input.recentMessages) ? input.recentMessages : [],
      });
      task = this.updateStep(task, "step_extract_intent", "completed");
      await this.emit(stepEvent(taskId, task.steps.find((s) => s.stepId === "step_extract_intent")));

      task = this.taskStore.update(taskId, { state: "planning" });
      await this.emit(stateEvent(taskId, "planning"));

      // Build a real plan (Scenario B). Always fallback to deterministic rule plan.
      const planned = this.planWorkflow
        ? await this.planWorkflow({
            text: input.input,
            contextSummary: input.contextSummary || "",
            intent,
            targetArtifacts: input.targetArtifacts,
            execution: input.execution || {},
          })
        : null;

      const existingExtract = task.steps.find((s) => s.stepId === "step_extract_intent") || makeStep("step_extract_intent", "提取意图");
      const plannedSteps = Array.isArray(planned?.steps) ? planned.steps : [];
      const plannedTasks = Array.isArray(planned?.tasks) ? planned.tasks : [];
      const normalizedPlannedSteps = plannedSteps
        .map((s) => (s && typeof s === "object" ? { stepId: s.stepId, label: s.label, status: "pending", kind: s.kind, tool: s.tool, requiresConfirm: s.requiresConfirm } : null))
        .filter(Boolean);

      // Keep extract_intent as completed + inject planned steps right after.
      const nextSteps = [
        { ...existingExtract, status: "completed" },
        ...normalizedPlannedSteps.map((s) => ({ ...s })),
      ];
      task = this.taskStore.update(taskId, {
        steps: nextSteps,
        currentStepId: null,
        taskPlan: {
          tasks: plannedTasks,
          meta: planned?.taskPlanMeta || {},
        },
      });

      // Emit pending steps so GUI can render the whole plan immediately.
      for (const s of normalizedPlannedSteps) {
        await this.emit(stepEvent(taskId, { stepId: s.stepId, label: s.label, status: "pending" }));
      }

      // Optional confirm gate: only when planner says so OR any step requests confirmation.
      // Defer confirm gate to step_risk_guard for better observability (step status reflects waiting).
      const preNeedsConfirm = planned?.risks?.needsConfirm === true || normalizedPlannedSteps.some((s) => s.requiresConfirm === true);
      const preReason =
        typeof planned?.risks?.reason === "string" && planned.risks.reason.trim()
          ? planned.risks.reason.trim()
          : "该任务包含写操作。为避免误操作，请先确认再执行。";
      input.confirmGate = preNeedsConfirm ? { needed: true, reason: preReason, stepId: "step_risk_guard" } : { needed: false, reason: "", stepId: "" };

      task = this.taskStore.update(taskId, { state: "executing" });
      await this.emit(stateEvent(taskId, "executing"));

      const wantsDoc = Array.isArray(input.targetArtifacts) && input.targetArtifacts.includes("doc");
      const wantsSlides = Array.isArray(input.targetArtifacts) && input.targetArtifacts.includes("slides");
      const execDryRun = input.execution?.dryRun ?? true;
      const execIdentity = input.execution?.defaultIdentity ?? "user";
      const taskDefsByStepId = new Map(
        plannedTasks
          .filter((t) => t && typeof t === "object" && typeof t.name === "string")
          .map((t) => [`step_${t.name}`, t]),
      );
      const completedTaskIds = new Set();
      const taskOutputsByField = {};
      const runtimeForTasks = {
        inputText: input.input,
        contextSummary: input.contextSummary || "",
        intent,
      };

      let docUrl = "";
      let contentBundle = null;
      let emittedContentArtifact = false;
      const ensureBundle = async () => {
        if (contentBundle) return contentBundle;
        contentBundle = await this.generateContentBundle({
          text: input.input,
          contextSummary: input.contextSummary || "",
          targetArtifacts: input.targetArtifacts || [],
          intent,
        });

        // Emit a human-readable artifact so the frontend can show intermediate results
        // without requiring users to open the generated doc.
        if (!emittedContentArtifact) {
          emittedContentArtifact = true;
          const safe = (s, max) => {
            const t = String(s || "").trim();
            if (!t) return "";
            if (t.length <= max) return t;
            return `${t.slice(0, max - 3)}...`;
          };
          const structured = safe(contentBundle.rewrittenMd, 2600);
          const summary = safe(contentBundle.summaryMd, 1200);
          const reqs = safe(contentBundle.requirementsMd, 1200);
          const clarify = safe(contentBundle.clarifyMd, 900);
          const outline = safe(contentBundle.docOutlineMd || contentBundle.outlineMd, 900);
          // UX: prefer a single structured preview; avoid repeating legacy sections unless needed.
          const body = structured || [summary, reqs, clarify, outline].filter(Boolean).join("\n\n");
          const artifact = {
            artifactId: `note_${Date.now()}`,
            kind: "note",
            title: body ? `规划产物（预览）\n\n${body}` : "规划产物（预览）",
            url: "",
          };
          task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, artifact] });
          await this.emit(artifactEvent(taskId, artifact));
        }

        return contentBundle;
      };

      // Execute planned steps in order (skip extract_intent which is already completed).
      for (const s of task.steps) {
        if (!s || s.stepId === "step_extract_intent") continue;
        if (this.taskStore.isCancelled(taskId)) throw new Error("task cancelled");

        task = this.updateStep(task, s.stepId, "running");
        await this.emit(stepEvent(taskId, task.steps.find((x) => x.stepId === s.stepId)));

        const taskDef = extractTaskFromStep(s.stepId, taskDefsByStepId);
        if (taskDef) {
          const deps = Array.isArray(taskDef.depends_on) ? taskDef.depends_on : [];
          const unsatisfied = deps.filter((depId) => !completedTaskIds.has(depId));
          if (unsatisfied.length > 0) {
            throw new Error(`dag dependency not satisfied: ${taskDef.name} <- ${unsatisfied.join(",")}`);
          }
          const b = await ensureBundle();
          const taskInputs = buildTaskInputMap({ taskDef, runtime: runtimeForTasks, taskOutputsByField });
          const taskOutputs = buildTaskOutputMap({ taskDef, bundle: b, runtime: runtimeForTasks });
          for (const [k, v] of Object.entries(taskOutputs)) taskOutputsByField[k] = v;
          completedTaskIds.add(taskDef.id);

          const traceArtifact = renderTaskTraceArtifact({
            taskDef,
            stepId: s.stepId,
            inputs: taskInputs,
            outputs: taskOutputs,
          });
          task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, traceArtifact] });
          await this.emit(artifactEvent(taskId, traceArtifact));
        } else if (s.stepId === "step_risk_guard") {
          const gate = input.confirmGate && input.confirmGate.needed ? input.confirmGate : null;
          const dryRunNow = input.execution?.dryRun !== false;
          if (gate && gate.needed && dryRunNow === false) {
            await this.emit(
              confirmRequiredEvent(taskId, gate.stepId || "step_risk_guard", gate.reason || "需要确认后继续执行。", {
                approveEndpoint: "/api/agent/workflow/confirm",
                cancelEndpoint: "/api/agent/workflow/cancel",
              }),
            );
            const confirm = await this.taskStore.waitForConfirm(taskId, gate.stepId || "step_risk_guard");
            if (!confirm?.approved) {
              this.taskStore.update(taskId, { state: "cancelled", currentStepId: null });
              await this.emit(stateEvent(taskId, "cancelled"));
              return;
            }
            if (confirm.override) {
              input.execution = { ...(input.execution || {}), ...(confirm.override || {}) };
            }
          }
        } else if (s.stepId === "step_summarize_context" || s.stepId === "step_extract_requirements" || s.stepId === "step_identify_open_questions" || s.stepId === "step_make_outline") {
          await ensureBundle();
        } else if (s.stepId === "step_create_doc" && wantsDoc) {
          const b = await ensureBundle().catch(() => null);
          const summaryMd = b?.summaryMd ? String(b.summaryMd).trim() : "";
          const requirementsMd = b?.requirementsMd ? String(b.requirementsMd).trim() : "";
          const clarifyMd = b?.clarifyMd ? String(b.clarifyMd).trim() : "";
          const outlineMd = b?.outlineMd ? String(b.outlineMd).trim() : "";
          const rewrittenMd = b?.rewrittenMd ? String(b.rewrittenMd).trim() : "";
          const docTpl = resolveDocTemplate(intent);
          const fallbackBody = [summaryMd, requirementsMd, clarifyMd, outlineMd].filter(Boolean).join("\n\n").trim();
          const bodyMd = rewrittenMd || fallbackBody || "## 内容\n- （暂无）";
          const docMarkdown = ["# " + docTpl.h1, "", bodyMd].join("\n\n");
          const docTarget = pickDocTargetFromInput(input.input);
          const canUpdate = Boolean(docTarget && typeof this.buildDocsUpdateArgs === "function");

          if (canUpdate) {
            const updateMarkdown = [
              "",
              `## 本次更新（${new Date().toISOString().slice(0, 19).replace("T", " ")}）`,
              "",
              bodyMd,
            ].join("\n");
            const docArgs = this.buildDocsUpdateArgs({
              as: input.execution?.docIdentity ?? input.execution?.defaultIdentity ?? execIdentity,
              doc: docTarget,
              apiVersion: "v2",
              mode: "append",
              markdown: updateMarkdown,
              dryRun: input.execution?.dryRun ?? execDryRun,
            });
            const docResp = await this.runLarkCli(docArgs, { timeoutMs: 120_000, stdin: updateMarkdown });
            const parsedDoc = this.tryParseJson(docResp.stdout);
            docUrl =
              pickDocsCreateUrl(parsedDoc.ok ? parsedDoc.value : null) ||
              pickDocUrlFromText(docResp.stdout) ||
              (docTarget.startsWith("http") ? docTarget : "");
          } else {
            const docArgs = this.buildDocsCreateArgs({
              as: input.execution?.docIdentity ?? input.execution?.defaultIdentity ?? execIdentity,
              title: docTpl.title,
              apiVersion: "v2",
              markdown: docMarkdown,
              dryRun: input.execution?.dryRun ?? execDryRun,
            });
            const docResp = await this.runLarkCli(docArgs, { timeoutMs: 120_000, stdin: docMarkdown });
            const parsedDoc = this.tryParseJson(docResp.stdout);
            docUrl = pickDocsCreateUrl(parsedDoc.ok ? parsedDoc.value : null) || pickDocUrlFromText(docResp.stdout) || "";
          }
          const artifact = {
            artifactId: `doc_${Date.now()}`,
            kind: "doc",
            title: docTpl.title.replace("（Agent）", ""),
            url: docUrl,
          };
          task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, artifact] });
          await this.emit(artifactEvent(taskId, artifact));
        } else if (s.stepId === "step_create_slides" && wantsSlides) {
          const b = await ensureBundle().catch(() => null);
          const slidesTpl = resolveSlidesTemplate(intent);
          const slidesTitle = slidesTpl.deckTitle;
          const slidesXmlArray = generateSlidesXmlArray({ bundle: b, text: input.input, intent });
          let usedFallbackEmptySlides = false;
          let slidesArgs = this.buildSlidesCreateArgs({
            as: input.execution?.slidesIdentity ?? "user",
            title: slidesTitle,
            // Avoid pushing large slides JSON via CLI args on Windows.
            // Create deck first, then add pages via xml_presentation.slide.create (stdin).
            slidesXmlArray: [],
            dryRun: input.execution?.dryRun ?? execDryRun,
          });
          let slidesResp;
          try {
            slidesResp = await this.runLarkCli(slidesArgs, { timeoutMs: 120_000 });
          } catch (e) {
            if (!shouldFallbackToEmptySlides(e)) throw e;
            // Some cli/server combinations reject inline slides XML. Fallback to empty deck creation.
            usedFallbackEmptySlides = true;
            slidesArgs = this.buildSlidesCreateArgs({
              as: input.execution?.slidesIdentity ?? "user",
              title: slidesTitle,
              slidesXmlArray: [],
              dryRun: input.execution?.dryRun ?? execDryRun,
            });
            slidesResp = await this.runLarkCli(slidesArgs, { timeoutMs: 120_000 });
          }
          const parsedSlides = this.tryParseJson(slidesResp.stdout);
          const slidesUrl =
            (parsedSlides.ok ? pickSlidesCreateUrl(parsedSlides.value) : null) || pickSlidesUrlFromCliOutput(slidesResp.stdout) || "";

          // Best-effort: fill pages via xml_presentation.slide.create to avoid Windows argv limits.
          const dryRunNow = input.execution?.dryRun ?? execDryRun;
          const maybeSlidesTarget = pickSlidesTargetFromInput(input.input);
          const maybeSlidesPageIndex = pickSlidesPageIndexFromInput(input.input);
          const editSlidesToken =
            maybeSlidesTarget && String(maybeSlidesTarget).startsWith("http")
              ? extractSlidesTokenFromUrl(maybeSlidesTarget)
              : String(maybeSlidesTarget || "");

          // Edit mode: replace a specific page in an existing deck (whole-slide replace: delete + create).
          // If no pageIndex is provided, fallback to append new pages.
          if (
            !dryRunNow &&
            editSlidesToken &&
            maybeSlidesPageIndex &&
            typeof this.buildSlidesXmlPresentationsGetArgs === "function" &&
            typeof this.buildSlidesXmlPresentationSlideDeleteArgs === "function" &&
            Array.isArray(slidesXmlArray) &&
            slidesXmlArray.length > 0
          ) {
            const pageIndex = maybeSlidesPageIndex;
            const trace = {
              artifactId: `note_slides_edit_${Date.now()}`,
              kind: "note",
              title: `PPT编辑：目标 slides=${editSlidesToken}，页码=${pageIndex}（整页替换：delete+create）`,
              url: "",
            };
            task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, trace] });
            await this.emit(artifactEvent(taskId, trace));

            const getArgs = this.buildSlidesXmlPresentationsGetArgs({
              as: input.execution?.slidesIdentity ?? "user",
              xmlPresentationId: editSlidesToken,
              dryRun: dryRunNow,
            });
            const getResp = await this.runLarkCli(getArgs, { timeoutMs: 120_000 });
            const slideIds = extractSlideIdsFromCliOutput(getResp.stdout, this.tryParseJson);
            const idx0 = Math.max(0, pageIndex - 1);
            const targetSlideId = slideIds[idx0] || "";
            const beforeSlideId = slideIds[idx0 + 1] || "";
            if (!targetSlideId) {
              usedFallbackEmptySlides = true;
            } else {
              const delArgs = this.buildSlidesXmlPresentationSlideDeleteArgs({
                as: input.execution?.slidesIdentity ?? "user",
                xmlPresentationId: editSlidesToken,
                slideId: targetSlideId,
                dryRun: dryRunNow,
              });
              await this.runLarkCli(delArgs, { timeoutMs: 120_000 });

              // Replace with the first generated slide (single-page edit).
              const slideXml = slidesXmlArray[0];
              const data = JSON.stringify({ slide: { content: String(slideXml || "") } });
              const pageArgs = makeSlidesPageCreateArgs({
                as: input.execution?.slidesIdentity ?? "user",
                xmlPresentationId: editSlidesToken,
                beforeSlideId,
                dryRun: dryRunNow,
              });
              await this.runLarkCli(pageArgs, { timeoutMs: 120_000, stdin: data });
            }
          } else if (!dryRunNow && slidesUrl && Array.isArray(slidesXmlArray) && slidesXmlArray.length > 0) {
            // Create mode: fill pages in the newly created deck.
            const xmlPresentationId = extractSlidesTokenFromUrl(slidesUrl);
            if (xmlPresentationId) {
              for (const slideXml of slidesXmlArray) {
                const data = JSON.stringify({ slide: { content: String(slideXml || "") } });
                const pageArgs = makeSlidesPageCreateArgs({
                  as: input.execution?.slidesIdentity ?? "user",
                  xmlPresentationId,
                  beforeSlideId: "",
                  dryRun: dryRunNow,
                });
                await this.runLarkCli(pageArgs, { timeoutMs: 120_000, stdin: data });
              }
            } else {
              usedFallbackEmptySlides = true;
            }
          }
          const slidesArtifact = {
            artifactId: `slides_${Date.now()}`,
            kind: "slides",
            title: slidesTitle.replace("（Agent）", ""),
            url: slidesUrl || (editSlidesToken ? `https://www.feishu.cn/slides/${editSlidesToken}` : ""),
          };
          task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, slidesArtifact] });
          await this.emit(artifactEvent(taskId, slidesArtifact));

          if (usedFallbackEmptySlides) {
            const hint = {
              artifactId: `note_slides_fallback_${Date.now()}`,
              kind: "note",
              title:
                "提示：本次演示稿内容填充未完成（已创建演示稿但页面可能为空）。" +
                "为避免 Windows 命令行参数长度/转义问题，系统会优先“先建稿再逐页写入”。" +
                "若仍为空，请检查：1) 当前是否 dry-run 2) slides 链接 token 是否可解析 3) slide XML 是否被服务端拒绝。",
              url: "",
            };
            task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, hint] });
            await this.emit(artifactEvent(taskId, hint));
          }
        } else if (s.stepId === "step_send_delivery_message") {
          if (input.delivery?.chatId) {
            const slides = task.artifacts.find((a) => a.kind === "slides");
            const docLink = typeof docUrl === "string" ? docUrl.trim() : "";
            const slidesLink = typeof slides?.url === "string" ? slides.url.trim() : "";
            let message = "任务已完成，产物已创建（当前未提取到 URL，可在后台结果中查看）。";
            if (docLink && !slidesLink) {
              message = `任务已完成，文档链接：${docLink}`;
            } else if (docLink && slidesLink) {
              message = `任务已完成，文档：${docLink}；演示稿：${slidesLink}（打开后可在飞书内放映/排练）`;
            } else if (!docLink && slidesLink) {
              message = `任务已完成，演示稿链接：${slidesLink}（打开后可在飞书内放映/排练）`;
            }
            const sendArgs = this.buildImMessagesSendArgs({
              as: input.execution?.defaultIdentity ?? execIdentity,
              chatId: input.delivery.chatId,
              text: message,
              dryRun: input.execution?.dryRun ?? execDryRun,
            });
            await this.runLarkCli(sendArgs, { timeoutMs: 30_000 });
          }
        } else {
          // other logic steps: no-op, but kept for observability.
        }

        task = this.updateStep(task, s.stepId, "completed");
        await this.emit(stepEvent(taskId, task.steps.find((x) => x.stepId === s.stepId)));
      }

      this.taskStore.update(taskId, { state: "completed", currentStepId: null });
      await this.emit(stateEvent(taskId, "completed"));
    } catch (err) {
      const rawMsg = err && err.message ? err.message : String(err);
      const msg = normalizeErrorMessage(rawMsg);
      this.taskStore.update(taskId, { state: "failed", lastError: msg, currentStepId: null });
      await this.emit(
        errorEvent(taskId, this.taskStore.get(taskId)?.currentStepId || "unknown", {
          code: "WORKFLOW_EXECUTION_ERROR",
          message: msg,
          retryable: true,
        }),
      );
      // Best-effort: report failure back to IM (safe with IMEntry sender filters).
      try {
        if (input?.delivery?.chatId) {
          const sendArgs = this.buildImMessagesSendArgs({
            as: input.execution?.defaultIdentity ?? "bot",
            chatId: input.delivery.chatId,
            text: `任务失败：${msg}`,
            dryRun: input.execution?.dryRun ?? true,
          });
          await this.runLarkCli(sendArgs, { timeoutMs: 30_000 });
        }
      } catch {
        // ignore
      }
      await this.emit(stateEvent(taskId, "failed"));
    }
  }
}

module.exports = { AgentOrchestrator };

