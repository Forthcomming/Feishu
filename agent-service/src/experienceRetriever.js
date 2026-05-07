const {
  listExperienceCards,
  incrementMetric,
} = require("./feedbackStore");

function envOptional(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function readEnabled() {
  const raw = envOptional("EXPERIENCE_INJECTION_ENABLED");
  if (!raw) return false;
  const s = raw.toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function readTopK() {
  const n = Number(envOptional("EXPERIENCE_TOP_K") || "3");
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(8, Math.floor(n)));
}

function readScope() {
  const s = String(envOptional("EXPERIENCE_SCOPE") || "conversation").trim().toLowerCase();
  if (s === "tenant" || s === "global") return s;
  return "conversation";
}

function safeIntent(intent) {
  const i = intent && typeof intent === "object" ? intent : {};
  return {
    output_type: typeof i.output_type === "string" ? i.output_type : "doc",
    doc_type: typeof i.doc_type === "string" ? i.doc_type : "",
    ppt_type: typeof i.ppt_type === "string" ? i.ppt_type : "",
    scenario: typeof i.scenario === "string" ? i.scenario : "",
  };
}

function scoreCard(card, key) {
  const c = card && typeof card === "object" ? card : {};
  let s = 0;
  if (c.output_type && c.output_type === key.output_type) s += 4;
  if (c.doc_type && key.doc_type && c.doc_type === key.doc_type) s += 2;
  if (c.ppt_type && key.ppt_type && c.ppt_type === key.ppt_type) s += 2;
  if (c.scenario && key.scenario && c.scenario === key.scenario) s += 2;
  const conf = Number(c.confidence);
  if (Number.isFinite(conf)) s += Math.max(0, Math.min(1, conf));
  return s;
}

async function retrieveExperienceCards({ conversationId, intent }) {
  if (!readEnabled()) return [];
  const key = safeIntent(intent);
  const topK = readTopK();
  const scope = readScope();
  const cards = listExperienceCards({
    scope,
    conversationId: typeof conversationId === "string" ? conversationId : "",
    limit: 200,
  });
  incrementMetric("experience_retrieve_total", 1);
  const ranked = cards
    .map((c) => ({ card: c, score: scoreCard(c, key) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.card);
  if (ranked.length > 0) incrementMetric("experience_injection_hit_total", 1);
  return ranked;
}

module.exports = {
  retrieveExperienceCards,
  readExperienceInjectionEnabled: readEnabled,
};
