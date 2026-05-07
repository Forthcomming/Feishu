function envOptional(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function safeText(v, max) {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function readMaxChars() {
  const n = Number(envOptional("EXPERIENCE_MAX_CHARS") || "1200");
  if (!Number.isFinite(n)) return 1200;
  return Math.max(300, Math.min(5000, Math.floor(n)));
}

function sanitizeCard(card) {
  const c = card && typeof card === "object" ? card : {};
  const tips = Array.isArray(c.tips)
    ? c.tips.map((x) => safeText(x, 120)).filter(Boolean).slice(0, 4)
    : [];
  const anti = Array.isArray(c.antiPatterns)
    ? c.antiPatterns.map((x) => safeText(x, 120)).filter(Boolean).slice(0, 3)
    : [];
  return {
    when: safeText(c.when, 120),
    tips,
    antiPatterns: anti,
    confidence: Number.isFinite(Number(c.confidence)) ? Number(c.confidence) : null,
    updatedAt: Number.isFinite(Number(c.updatedAt)) ? Number(c.updatedAt) : 0,
  };
}

function renderExperienceInjection(cards) {
  const arr = Array.isArray(cards) ? cards.map(sanitizeCard).filter((x) => x.when || x.tips.length > 0 || x.antiPatterns.length > 0) : [];
  if (arr.length === 0) return "";
  const maxChars = readMaxChars();
  const lines = [];
  lines.push("## 历史经验建议（可能不完整，以当前指令为准）");
  arr.forEach((c, i) => {
    lines.push(`### 经验 ${i + 1}`);
    if (c.when) lines.push(`- 适用场景：${c.when}`);
    if (c.tips.length > 0) lines.push(`- 建议：${c.tips.join("；")}`);
    if (c.antiPatterns.length > 0) lines.push(`- 避免：${c.antiPatterns.join("；")}`);
    if (c.confidence != null) lines.push(`- 经验置信度：${c.confidence.toFixed(2)}`);
  });
  return safeText(lines.join("\n"), maxChars);
}

module.exports = { renderExperienceInjection };
