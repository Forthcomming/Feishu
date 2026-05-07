// In-memory workflow feedback (GUI / legacy POST /api/agent/workflow/feedback).
// For durable analytics use Redis via publishFeedbackEvent; this is for local dev & quick inspection.

const MAX_ITEMS = 1000;
const items = [];
const MAX_EVENTS = 3000;
const feedbackEvents = [];
const MAX_EXPERIENCE_CARDS = 1000;
const experienceCards = [];
const metrics = {
  feedback_publish_success_total: 0,
  feedback_publish_fail_total: 0,
  experience_retrieve_total: 0,
  experience_injection_hit_total: 0,
  reflect_run_total: 0,
  reflect_emit_total: 0,
};

function record(entry) {
  const e = {
    taskId: String(entry && entry.taskId ? entry.taskId : "").trim(),
    rating: entry && entry.rating === "down" ? "down" : "up",
    comment:
      typeof entry?.comment === "string" && entry.comment.length > 2000
        ? entry.comment.slice(0, 2000)
        : typeof entry?.comment === "string"
          ? entry.comment
          : "",
    at: typeof entry?.at === "number" && Number.isFinite(entry.at) ? entry.at : Date.now(),
  };
  if (!e.taskId) return;
  items.unshift(e);
  while (items.length > MAX_ITEMS) items.pop();
}

function listRecent(limit) {
  const n = Number(limit);
  const cap = Number.isFinite(n) ? Math.max(1, Math.min(500, Math.floor(n))) : 20;
  return items.slice(0, cap);
}

function recordFeedbackEvent(event) {
  const e = event && typeof event === "object" ? event : null;
  if (!e || typeof e.type !== "string") return;
  const payload = {
    ...e,
    taskId: typeof e.taskId === "string" ? e.taskId : "",
    conversationId: typeof e.conversationId === "string" ? e.conversationId : "",
    at: Number.isFinite(Number(e.at)) ? Number(e.at) : Date.now(),
  };
  feedbackEvents.unshift(payload);
  while (feedbackEvents.length > MAX_EVENTS) feedbackEvents.pop();
}

function listFeedbackEvents(limit) {
  const n = Number(limit);
  const cap = Number.isFinite(n) ? Math.max(1, Math.min(2000, Math.floor(n))) : 200;
  return feedbackEvents.slice(0, cap);
}

function recordExperienceCard(card) {
  const c = card && typeof card === "object" ? card : null;
  if (!c) return;
  const normalized = {
    scope: c.scope === "tenant" || c.scope === "global" ? c.scope : "conversation",
    conversationId: typeof c.conversationId === "string" ? c.conversationId : "",
    output_type: typeof c.output_type === "string" ? c.output_type : "",
    doc_type: typeof c.doc_type === "string" ? c.doc_type : "",
    ppt_type: typeof c.ppt_type === "string" ? c.ppt_type : "",
    scenario: typeof c.scenario === "string" ? c.scenario : "",
    when: typeof c.when === "string" ? c.when : "",
    tips: Array.isArray(c.tips) ? c.tips.slice(0, 8) : [],
    antiPatterns: Array.isArray(c.antiPatterns) ? c.antiPatterns.slice(0, 8) : [],
    confidence: Number.isFinite(Number(c.confidence)) ? Number(c.confidence) : 0,
    version: Number.isFinite(Number(c.version)) ? Number(c.version) : 1,
    updatedAt: Number.isFinite(Number(c.updatedAt)) ? Number(c.updatedAt) : Date.now(),
  };
  experienceCards.unshift(normalized);
  while (experienceCards.length > MAX_EXPERIENCE_CARDS) experienceCards.pop();
}

function listExperienceCards({ scope, conversationId, limit }) {
  const s = scope === "tenant" || scope === "global" ? scope : "conversation";
  const cid = typeof conversationId === "string" ? conversationId : "";
  const n = Number(limit);
  const cap = Number.isFinite(n) ? Math.max(1, Math.min(500, Math.floor(n))) : 50;
  if (s === "global") return experienceCards.slice(0, cap);
  if (s === "tenant") return experienceCards.filter((x) => x.scope !== "conversation").slice(0, cap);
  return experienceCards.filter((x) => !x.conversationId || x.conversationId === cid).slice(0, cap);
}

function incrementMetric(name, delta = 1) {
  const d = Number(delta);
  if (!Number.isFinite(d)) return;
  if (!Object.prototype.hasOwnProperty.call(metrics, name)) metrics[name] = 0;
  metrics[name] += d;
}

function getMetrics() {
  return { ...metrics };
}

module.exports = {
  record,
  listRecent,
  recordFeedbackEvent,
  listFeedbackEvents,
  recordExperienceCard,
  listExperienceCards,
  incrementMetric,
  getMetrics,
};
