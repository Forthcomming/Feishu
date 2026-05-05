// Feedback events for self-evolution Phase 1.
// Privacy: only emit metadata (kinds/lengths/IDs/URLs), never raw chat or artifact body.
// Stability: events are versioned via `v`; schema must stay backward-compatible.

const FEEDBACK_SCHEMA_VERSION = 1;

function envOptional(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function lenOf(value) {
  return typeof value === "string" ? value.length : 0;
}

function clampNote(value, max = 500) {
  if (typeof value !== "string") return "";
  const s = value.trim();
  return s.length > max ? s.slice(0, max) : s;
}

async function publishFeedbackEvent(event) {
  const url = envOptional("REALTIME_FEEDBACK_PUBLISH_URL") || "http://localhost:3003/api/feedback-events";
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(event),
    });
  } catch {
    // Realtime 不可用时不阻断主流程
  }
}

function buildTaskCompletedFeedback({ task, input, intentMeta, templateInfo, startedAt }) {
  const t = task && typeof task === "object" ? task : {};
  const steps = Array.isArray(t.steps) ? t.steps : [];
  const artifacts = Array.isArray(t.artifacts) ? t.artifacts : [];
  const im = intentMeta && typeof intentMeta === "object" ? intentMeta : {};
  const tpl = templateInfo && typeof templateInfo === "object" ? templateInfo : {};
  const inp = input && typeof input === "object" ? input : {};

  const approvedSteps = steps.filter((s) => s && s.status === "completed").map((s) => s.stepId);
  const cancelledSteps = steps
    .filter((s) => s && (s.status === "cancelled" || s.status === "failed"))
    .map((s) => s.stepId);
  const requiredSteps = steps
    .filter((s) => s && s.requiresConfirm === true)
    .map((s) => s.stepId);

  return {
    v: FEEDBACK_SCHEMA_VERSION,
    type: "feedback.task_completed",
    taskId: t.taskId || "",
    conversationId: t.conversationId || "",
    at: Date.now(),
    state: t.state || "",
    durationMs: typeof startedAt === "number" && Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0,
    intent: {
      source: typeof im.source === "string" ? im.source : "",
      decisionPath: typeof im.decisionPath === "string" ? im.decisionPath : "",
      confidence: typeof im.confidence === "number" && Number.isFinite(im.confidence) ? im.confidence : 0,
      thresholds: im.thresholds && typeof im.thresholds === "object" ? im.thresholds : null,
      output_type: typeof im.output_type === "string" ? im.output_type : tpl.kind || "",
      doc_type: typeof im.doc_type === "string" ? im.doc_type : "",
      ppt_type: typeof im.ppt_type === "string" ? im.ppt_type : "",
      scenario: typeof im.scenario === "string" ? im.scenario : "",
    },
    template: {
      kind: typeof tpl.kind === "string" ? tpl.kind : "",
      title: typeof tpl.title === "string" ? tpl.title : "",
      sectionsOrder: Array.isArray(tpl.sectionsOrder) ? tpl.sectionsOrder.slice(0, 32) : [],
    },
    artifacts: artifacts.map((a) => ({
      artifactId: a && a.artifactId ? String(a.artifactId) : "",
      kind: a && a.kind ? String(a.kind) : "",
      title: a && typeof a.title === "string" ? a.title : "",
      urlPresent: !!(a && typeof a.url === "string" && a.url.length > 0),
      contentLen: lenOf(a && a.title) + lenOf(a && a.url),
    })),
    confirms: {
      required: requiredSteps.length > 0,
      requiredSteps,
      approvedSteps,
      cancelledSteps,
    },
    errorCode: t.lastError ? "WORKFLOW_EXECUTION_ERROR" : "",
    inputLen: lenOf(inp.input),
    contextLen: lenOf(inp.contextSummary),
  };
}

function buildUserRatingFeedback({ taskId, conversationId, artifactId, rating, note, tags }) {
  const safeRating = rating === "down" ? "down" : "up";
  const safeTags = Array.isArray(tags)
    ? tags
        .filter((t) => typeof t === "string" && t.trim())
        .map((t) => t.trim().slice(0, 32))
        .slice(0, 10)
    : [];
  return {
    v: FEEDBACK_SCHEMA_VERSION,
    type: "feedback.user_rating",
    taskId: typeof taskId === "string" ? taskId : "",
    conversationId: typeof conversationId === "string" ? conversationId : "",
    at: Date.now(),
    artifactId: typeof artifactId === "string" ? artifactId : "",
    rating: safeRating,
    note: clampNote(note),
    tags: safeTags,
  };
}

module.exports = {
  FEEDBACK_SCHEMA_VERSION,
  publishFeedbackEvent,
  buildTaskCompletedFeedback,
  buildUserRatingFeedback,
};
