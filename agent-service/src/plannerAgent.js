function envOptional(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeArtifacts(arr) {
  const raw = Array.isArray(arr) ? arr : [];
  const norm = raw
    .map((x) => String(x || "").toLowerCase().trim())
    .map((x) => (x === "ppt" ? "slides" : x))
    .filter((x) => x === "doc" || x === "slides");
  return Array.from(new Set(norm));
}

function toStepId(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^[a-zA-Z0-9_:-]{1,64}$/.test(s)) return s;
  // Best-effort sanitize
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .slice(0, 64);
}

function safeLabel(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

function ensureStepShape(step) {
  const stepId = toStepId(step?.id ?? step?.stepId);
  const label = safeLabel(step?.label);
  if (!stepId || !label) return null;
  const kind = typeof step?.kind === "string" ? step.kind.trim() : "";
  const tool = typeof step?.tool === "string" ? step.tool.trim() : "";
  const requiresConfirm = step?.requires_confirm === true || step?.requiresConfirm === true;
  return { stepId, label, status: "pending", kind: kind || undefined, tool: tool || undefined, requiresConfirm };
}

function parsePlanJson(s) {
  const text = String(s || "").trim();
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error("no json object found");
  const body = text.slice(jsonStart, jsonEnd + 1);
  const obj = JSON.parse(body);

  const planVersion = Number(obj?.plan_version ?? obj?.planVersion ?? 1);
  const stepsRaw = Array.isArray(obj?.steps) ? obj.steps : [];
  const steps = stepsRaw.map(ensureStepShape).filter(Boolean);
  const risksRaw = obj?.risks && typeof obj.risks === "object" ? obj.risks : {};
  const needsConfirm = risksRaw?.needs_confirm === true || risksRaw?.needsConfirm === true;
  const reason = typeof risksRaw?.reason === "string" ? risksRaw.reason.trim() : "";

  if (steps.length < 8 || steps.length > 12) throw new Error(`invalid steps length: ${steps.length}`);
  return { planVersion: Number.isFinite(planVersion) ? planVersion : 1, steps, risks: { needsConfirm, reason } };
}

function ruleBasedPlan({ targetArtifacts, dryRun }) {
  const artifacts = normalizeArtifacts(targetArtifacts);
  const wantsDoc = artifacts.includes("doc");
  const wantsSlides = artifacts.includes("slides");
  const needsConfirm = dryRun === false && (wantsDoc || wantsSlides);

  const steps = [];
  const push = (id, label, extra) => {
    const step = ensureStepShape({ id, label, ...extra });
    if (step) steps.push(step);
  };

  // 8-12 steps, keep deterministic order for demo.
  push("step_fetch_context", "拉取最近消息与上下文摘要", { kind: "logic" });
  push("step_summarize_context", "整理上下文：关键要点/结论/待确认/行动项", { kind: "llm" });
  push("step_extract_requirements", "抽取需求点、约束与关键决策", { kind: "llm" });
  push("step_identify_open_questions", "识别待确认问题并生成澄清清单", { kind: "llm" });
  push("step_make_outline", wantsDoc ? "生成需求文档大纲（可编辑）" : "生成演示稿大纲（可编辑）", { kind: "llm" });
  push("step_risk_guard", "风险检查与确认点（默认 dry-run）", { kind: "guard", requires_confirm: needsConfirm });

  if (wantsDoc) push("step_create_doc", "创建飞书文档", { kind: "tool", tool: "docs.create" });
  if (wantsSlides) push("step_create_slides", "创建飞书演示稿", { kind: "tool", tool: "slides.create" });

  // Make sure we always have enough steps even in slides-only mode.
  if (!wantsDoc && wantsSlides) push("step_link_inputs", "关联参考文档/讨论要点（供演示稿生成）", { kind: "logic" });

  push("step_send_delivery_message", "回 IM 交付链接", { kind: "tool", tool: "im.messages_send" });

  // Ensure 8-12 steps for demo stability.
  while (steps.length < 8) {
    push(`step_padding_${steps.length}`, "补全步骤（演示占位）", { kind: "logic" });
  }
  if (steps.length > 12) steps.splice(12);

  return {
    planVersion: 1,
    steps,
    risks: { needsConfirm, reason: needsConfirm ? "检测到非 dry-run 写操作，建议先确认再执行。" : "" },
  };
}

async function callDoubaoPlan({ text, contextSummary, targetArtifacts, dryRun, timeoutMs }) {
  const apiKey = envOptional("DOUBAO_API_KEY");
  const baseUrl = envOptional("DOUBAO_BASE_URL") ?? "https://ark.cn-beijing.volces.com/api/v3";
  const endpointId = envOptional("DOUBAO_PLANNER_ENDPOINT_ID") ?? envOptional("DOUBAO_ENDPOINT_ID");
  if (!apiKey || !endpointId) {
    throw new Error("missing DOUBAO_API_KEY or DOUBAO_PLANNER_ENDPOINT_ID/DOUBAO_ENDPOINT_ID");
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const artifacts = normalizeArtifacts(targetArtifacts);
    const wantsDoc = artifacts.includes("doc");
    const wantsSlides = artifacts.includes("slides");

    const system = [
      "你是一个任务规划器（Planner）。",
      "你的目标：把用户指令拆解成 8-12 个可执行步骤。",
      "请仅输出严格 JSON（不要代码块，不要多余解释）。",
      '输出 schema: {"plan_version":1,"steps":[{"id":"","label":"","kind":"logic|llm|guard|tool","tool":"","requires_confirm":false}],"risks":{"needs_confirm":false,"reason":""}}',
      "约束：",
      "- steps 数量必须在 8 到 12 之间；id 唯一且使用 step_ 前缀；label 用中文且简洁。",
      `- 目标产物：${wantsDoc ? "需要文档" : "不需要文档"}；${wantsSlides ? "需要演示稿" : "不需要演示稿"}。`,
      "- 若需要文档，steps 必须包含 id=step_create_doc 的 tool 步骤（tool=docs.create）。",
      "- 若需要演示稿，steps 必须包含 id=step_create_slides 的 tool 步骤（tool=slides.create）。",
      "- 必须包含回 IM 交付：id=step_send_delivery_message（tool=im.messages_send）。",
      "- 必须包含风险检查：id=step_risk_guard（kind=guard）。",
      "- 默认写操作是 dry-run；若 dryRun=false，则 risks.needs_confirm=true 并给出 reason。",
    ].join("\n");

    const user = [
      `用户指令：${String(text || "").trim()}`,
      `上下文摘要：${String(contextSummary || "").trim()}`,
      `执行模式：dryRun=${dryRun === false ? "false" : "true"}`,
    ].join("\n");

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: endpointId,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
      }),
      signal: controller.signal,
    });

    const raw = await resp.text();
    if (!resp.ok) throw new Error(raw || `doubao http ${resp.status}`);
    const parsed = JSON.parse(raw);
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("doubao returned empty content");
    return content.trim();
  } finally {
    clearTimeout(t);
  }
}

async function planWorkflow({ text, contextSummary, intent, targetArtifacts, execution }) {
  const timeoutMs = Number(envOptional("PLANNER_TIMEOUT_MS") ?? "8000");
  const dryRun = execution?.dryRun !== false;

  const artifacts = normalizeArtifacts(targetArtifacts);
  const wantsDoc = artifacts.includes("doc");
  const wantsSlides = artifacts.includes("slides");

  // If no Doubao config, go rule-based directly.
  const hasDoubao = Boolean(envOptional("DOUBAO_API_KEY") && (envOptional("DOUBAO_PLANNER_ENDPOINT_ID") || envOptional("DOUBAO_ENDPOINT_ID")));
  if (!hasDoubao) {
    return ruleBasedPlan({ targetArtifacts: artifacts, dryRun });
  }

  try {
    const content = await callDoubaoPlan({
      text,
      contextSummary,
      targetArtifacts: artifacts,
      dryRun,
      timeoutMs,
    });
    const planned = parsePlanJson(content);

    // Safety: enforce required tool steps presence; otherwise fallback.
    const ids = new Set(planned.steps.map((s) => s.stepId));
    if (!ids.has("step_risk_guard")) throw new Error("missing step_risk_guard");
    if (!ids.has("step_send_delivery_message")) throw new Error("missing step_send_delivery_message");
    if (wantsDoc && !ids.has("step_create_doc")) throw new Error("missing step_create_doc");
    if (wantsSlides && !ids.has("step_create_slides")) throw new Error("missing step_create_slides");

    const needsConfirm = planned.risks?.needsConfirm === true || planned.risks?.needs_confirm === true || planned.risks?.needsConfirm === true;
    const reason =
      typeof planned.risks?.reason === "string" && planned.risks.reason.trim()
        ? planned.risks.reason.trim()
        : dryRun
          ? ""
          : "检测到非 dry-run 写操作，建议先确认再执行。";

    return { planVersion: planned.planVersion, steps: planned.steps, risks: { needsConfirm: needsConfirm || dryRun === false, reason } };
  } catch {
    return ruleBasedPlan({ targetArtifacts: artifacts, dryRun });
  }
}

module.exports = { planWorkflow, parsePlanJson, ruleBasedPlan, normalizeArtifacts, clamp01 };

