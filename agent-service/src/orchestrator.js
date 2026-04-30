const { artifactEvent, errorEvent, stateEvent, stepEvent } = require("./taskEvents");
const { confirmRequiredEvent } = require("./taskEvents");
const { generateContentBundle } = require("./contentAgent");

function makeStep(stepId, label) {
  return { stepId, label, status: "pending" };
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

function pickSlidesUrlFromCliOutput(stdout) {
  const s = String(stdout || "");
  // Prefer explicit slides links if present.
  const m = s.match(/https?:\/\/[^\s"']+\/slides\/[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

class AgentOrchestrator {
  constructor(deps) {
    this.parseIntentStub = deps.parseIntentStub;
    this.planWorkflow = deps.planWorkflow;
    this.generateContentBundle = deps.generateContentBundle || generateContentBundle;
    this.buildDocsCreateArgs = deps.buildDocsCreateArgs;
    this.buildSlidesCreateArgs = deps.buildSlidesCreateArgs;
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
      const intent = this.parseIntentStub({ input: input.input });
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
      const normalizedPlannedSteps = plannedSteps
        .map((s) => (s && typeof s === "object" ? { stepId: s.stepId, label: s.label, status: "pending", kind: s.kind, tool: s.tool, requiresConfirm: s.requiresConfirm } : null))
        .filter(Boolean);

      // Keep extract_intent as completed + inject planned steps right after.
      const nextSteps = [
        { ...existingExtract, status: "completed" },
        ...normalizedPlannedSteps.map((s) => ({ ...s })),
      ];
      task = this.taskStore.update(taskId, { steps: nextSteps, currentStepId: null });

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

      let docUrl = "";
      let contentBundle = null;
      const ensureBundle = async () => {
        if (contentBundle) return contentBundle;
        contentBundle = await this.generateContentBundle({
          text: input.input,
          contextSummary: input.contextSummary || "",
          targetArtifacts: input.targetArtifacts || [],
        });
        return contentBundle;
      };

      // Execute planned steps in order (skip extract_intent which is already completed).
      for (const s of task.steps) {
        if (!s || s.stepId === "step_extract_intent") continue;
        if (this.taskStore.isCancelled(taskId)) throw new Error("task cancelled");

        task = this.updateStep(task, s.stepId, "running");
        await this.emit(stepEvent(taskId, task.steps.find((x) => x.stepId === s.stepId)));

        if (s.stepId === "step_risk_guard") {
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
        } else if (
          s.stepId === "step_summarize_context" ||
          s.stepId === "step_extract_requirements" ||
          s.stepId === "step_identify_open_questions" ||
          s.stepId === "step_make_outline"
        ) {
          await ensureBundle();
        } else if (s.stepId === "step_create_doc" && wantsDoc) {
          const b = await ensureBundle().catch(() => null);
          const summaryMd = b?.summaryMd ? String(b.summaryMd).trim() : "";
          const requirementsMd = b?.requirementsMd ? String(b.requirementsMd).trim() : "";
          const clarifyMd = b?.clarifyMd ? String(b.clarifyMd).trim() : "";
          const outlineMd = b?.outlineMd ? String(b.outlineMd).trim() : "";
          const planLines = task.steps
            .filter((x) => x && typeof x.stepId === "string")
            .map((x, i) => `- ${i + 1}. ${x.label || x.stepId}（${x.stepId}）`)
            .slice(0, 20)
            .join("\n");
          const docMarkdown = [
            "# 需求文档（Agent）",
            "",
            "## 任务指令",
            String(input.input || "").trim(),
            "",
            "## 意图",
            `- ${intent.intent.name}`,
            "",
            summaryMd || "## 上下文摘要\n- （暂无）",
            "",
            requirementsMd || "## 需求点/约束/风险（抽取）\n- （暂无）",
            "",
            clarifyMd || "## 待确认问题（澄清清单）\n- （暂无）",
            "",
            outlineMd || "## 结构大纲（可编辑）\n- （暂无）",
            "",
            "## 执行计划（Planner）",
            planLines || "- （暂无）",
          ].join("\n");
          const docArgs = this.buildDocsCreateArgs({
            as: input.execution?.defaultIdentity ?? execIdentity,
            title: "需求文档（Agent）",
            markdown: docMarkdown,
            dryRun: input.execution?.dryRun ?? execDryRun,
          });
          const docResp = await this.runLarkCli(docArgs, { timeoutMs: 60_000 });
          const parsedDoc = this.tryParseJson(docResp.stdout);
          docUrl = pickDocsCreateUrl(parsedDoc.ok ? parsedDoc.value : null) || "";
          const artifact = {
            artifactId: `doc_${Date.now()}`,
            kind: "doc",
            title: "需求文档",
            url: docUrl,
          };
          task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, artifact] });
          await this.emit(artifactEvent(taskId, artifact));
        } else if (s.stepId === "step_create_slides" && wantsSlides) {
          const slidesTitle = "评审演示稿（Agent）";
          const slidesArgs = this.buildSlidesCreateArgs({
            as: input.execution?.defaultIdentity ?? "bot",
            title: slidesTitle,
            slidesXmlArray: [],
            dryRun: input.execution?.dryRun ?? execDryRun,
          });
          const slidesResp = await this.runLarkCli(slidesArgs, { timeoutMs: 60_000 });
          const parsedSlides = this.tryParseJson(slidesResp.stdout);
          const slidesUrl =
            (parsedSlides.ok ? pickDocUrl(parsedSlides.value) : null) || pickSlidesUrlFromCliOutput(slidesResp.stdout) || "";
          const slidesArtifact = {
            artifactId: `slides_${Date.now()}`,
            kind: "slides",
            title: "评审演示稿",
            url: slidesUrl || "",
          };
          task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, slidesArtifact] });
          await this.emit(artifactEvent(taskId, slidesArtifact));
        } else if (s.stepId === "step_send_delivery_message") {
          if (input.delivery?.chatId) {
            const slides = task.artifacts.find((a) => a.kind === "slides");
            const docLink = typeof docUrl === "string" ? docUrl.trim() : "";
            const slidesLink = typeof slides?.url === "string" ? slides.url.trim() : "";
            let message = "任务已完成，产物已创建（当前未提取到 URL，可在后台结果中查看）。";
            if (docLink && !slidesLink) {
              message = `任务已完成，文档链接：${docLink}`;
            } else if (docLink && slidesLink) {
              message = `任务已完成，文档：${docLink}；演示稿：${slidesLink}`;
            } else if (!docLink && slidesLink) {
              message = `任务已完成，演示稿链接：${slidesLink}`;
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
      const msg = err && err.message ? err.message : String(err);
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

