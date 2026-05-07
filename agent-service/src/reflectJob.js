const {
  listFeedbackEvents,
  recordExperienceCard,
  incrementMetric,
} = require("./feedbackStore");

function envOptional(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function readEnabled() {
  const raw = envOptional("EXPERIENCE_REFLECT_ENABLED");
  if (!raw) return false;
  const s = raw.toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function readScope() {
  const s = String(envOptional("EXPERIENCE_SCOPE") || "conversation").trim().toLowerCase();
  if (s === "tenant" || s === "global") return s;
  return "conversation";
}

function groupKey(evt) {
  const i = evt && evt.intent && typeof evt.intent === "object" ? evt.intent : {};
  return [i.output_type || "", i.doc_type || "", i.ppt_type || "", i.scenario || ""].join("|");
}

function toExperienceCards(events, { conversationId }) {
  const byKey = new Map();
  for (const evt of events) {
    if (!evt || evt.type !== "feedback.task_completed") continue;
    const key = groupKey(evt);
    if (!key) continue;
    const row = byKey.get(key) || {
      done: 0,
      fail: 0,
      cancel: 0,
      withConfirm: 0,
      output_type: evt.intent?.output_type || "",
      doc_type: evt.intent?.doc_type || "",
      ppt_type: evt.intent?.ppt_type || "",
      scenario: evt.intent?.scenario || "",
    };
    if (evt.state === "completed") row.done += 1;
    else if (evt.state === "failed") row.fail += 1;
    else if (evt.state === "cancelled") row.cancel += 1;
    if (evt.confirms?.required) row.withConfirm += 1;
    byKey.set(key, row);
  }

  const cards = [];
  for (const row of byKey.values()) {
    const total = row.done + row.fail + row.cancel;
    if (total <= 0) continue;
    const failRate = row.fail / total;
    const cancelRate = row.cancel / total;
    const tips = [];
    const antiPatterns = [];
    if (row.withConfirm > 0) tips.push("高风险步骤建议先确认再执行，减少误操作。");
    if (row.done >= 2 && failRate < 0.3) tips.push("优先沿用当前结构化模板与产物顺序。");
    if (failRate >= 0.4) antiPatterns.push("该场景失败率偏高，避免直接落地写入，优先输出预览。");
    if (cancelRate >= 0.4) antiPatterns.push("该场景取消率偏高，建议先补充澄清问题。");
    const confidence = Math.max(0, Math.min(1, row.done / Math.max(1, total)));
    cards.push({
      scope: readScope(),
      conversationId: conversationId || "",
      output_type: row.output_type,
      doc_type: row.doc_type,
      ppt_type: row.ppt_type,
      scenario: row.scenario,
      when: `output_type=${row.output_type || "doc"} doc_type=${row.doc_type || "-"} ppt_type=${row.ppt_type || "-"} scenario=${row.scenario || "-"}`,
      tips,
      antiPatterns,
      confidence,
      version: 1,
      updatedAt: Date.now(),
    });
  }
  return cards;
}

async function runReflectJob({ conversationId }) {
  if (!readEnabled()) return { ok: true, skipped: true, reason: "disabled" };
  incrementMetric("reflect_run_total", 1);
  const events = listFeedbackEvents(600);
  const cards = toExperienceCards(events, { conversationId });
  for (const c of cards) {
    recordExperienceCard(c);
    incrementMetric("reflect_emit_total", 1);
  }
  return { ok: true, skipped: false, emitted: cards.length };
}

module.exports = { runReflectJob, toExperienceCards };
