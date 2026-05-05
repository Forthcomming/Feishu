/**
 * IM 上下文流水线：[召回 lines] → rerank → Top-K → structured Markdown
 * 纯函数，便于单测；不依赖 extractImTextLines（由 server 先产出 lines）。
 */

function envInt(name, defaultVal) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return defaultVal;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : defaultVal;
}

/** CONTEXT_RERANK_TOP_K 默认 6，夹在 5–8 */
function readRerankTopK() {
  const k = envInt("CONTEXT_RERANK_TOP_K", 6);
  return Math.min(8, Math.max(5, k));
}

function tokenizeForOverlap(text) {
  const s = String(text || "").toLowerCase();
  const tokens = new Set();
  const words = s.match(/[a-z0-9]{2,}/g) || [];
  for (const w of words) tokens.add(w);
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch)) tokens.add(ch);
  }
  for (let i = 0; i < s.length - 1; i++) {
    const pair = s.slice(i, i + 2);
    if (/[\u4e00-\u9fff]{2}/.test(pair)) tokens.add(pair);
  }
  return tokens;
}

function overlapScore(line, triggerTokens) {
  if (!triggerTokens.size) return 0;
  const lineTokens = tokenizeForOverlap(line);
  let hit = 0;
  for (const t of lineTokens) {
    if (triggerTokens.has(t)) hit += 1;
  }
  return hit / triggerTokens.size;
}

function keywordBonus(line) {
  const l = String(line || "");
  let b = 0;
  if (/决定|结论|定了|就这么办|OK|同意|通过/.test(l)) b += 0.15;
  if (/吗\??$|？$|是否|要不要|能不能|怎么|为什么/.test(l)) b += 0.08;
  if (/TODO|待办|下一步|行动|安排|需要|请/.test(l)) b += 0.12;
  if (/需求|文档|ppt|演示稿|幻灯片|prd|方案|报告|纪要/.test(l)) b += 0.1;
  return b;
}

function rerankPickLines(lines, triggerText, k) {
  const n = lines.length;
  if (n === 0) return [];
  const kk = Math.min(k, n);
  const triggerTokens = tokenizeForOverlap(String(triggerText || "").trim());
  const items = lines.map((line, idx) => {
    let score = overlapScore(line, triggerTokens);
    score += keywordBonus(line);
    score += n <= 1 ? 0 : (idx / (n - 1)) * 0.05;
    return { idx, score, line };
  });
  items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.idx - b.idx;
  });
  const picked = items.slice(0, kk);
  picked.sort((a, b) => a.idx - b.idx);
  return picked.map((x) => x.line);
}

function truncateLine(s, max) {
  const t = String(s || "").trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 3)}...`;
}

function buildStructuredContext(topLines) {
  const lines = Array.isArray(topLines) ? topLines : [];
  const decision = lines.filter((l) => /决定|结论|定了|就这么办|OK|同意|通过/.test(l));
  const questions = lines.filter((l) => /吗\??$|？$|是否|要不要|能不能|怎么|为什么/.test(l));
  const actions = lines.filter((l) => /TODO|待办|下一步|行动|安排|需要|请/.test(l));
  const used = new Set([...decision, ...questions, ...actions]);
  const other = lines.filter((l) => !used.has(l));

  const bullets = (arr, max) =>
    arr
      .map((s) => truncateLine(s, 200))
      .filter(Boolean)
      .slice(0, max)
      .map((s) => `- ${s}`)
      .join("\n");

  const quoteMax = 200;
  const quoteBlock = (s) => `> ${truncateLine(s, quoteMax)}`;

  const parts = [];
  parts.push("## 结构化上下文");
  parts.push("### 决策/结论");
  parts.push(bullets(decision, 8) || "- （暂无）");
  parts.push("\n### 待确认");
  parts.push(bullets(questions, 8) || "- （暂无）");
  parts.push("\n### 行动项");
  parts.push(bullets(actions, 8) || "- （暂无）");
  parts.push("\n### 其他要点");
  parts.push(bullets(other, 8) || "- （暂无）");
  parts.push("\n### 选用原文（Top-K，按时间序）");
  parts.push(lines.map(quoteBlock).join("\n") || "> （暂无）");
  return parts.join("\n");
}

/**
 * @param {string[]} lines - 已噪音过滤、时间升序的消息文本
 * @param {string} triggerText - 当前用户触发句（勿传 enrichedInput）
 * @param {{ topK?: number }} [options]
 * @returns {{ topMessages: string[], structuredContext: string, topK: number }}
 */
function buildContextFromLines(lines, triggerText, options = {}) {
  const configuredK = typeof options.topK === "number" && Number.isFinite(options.topK) ? Math.floor(options.topK) : readRerankTopK();
  const k = Math.min(8, Math.max(5, configuredK));
  const safeLines = Array.isArray(lines) ? lines.map((s) => String(s).trim()).filter(Boolean) : [];
  const topMessages = rerankPickLines(safeLines, triggerText, k);
  const structuredContext = buildStructuredContext(topMessages);
  return { topMessages, structuredContext, topK: topMessages.length };
}

module.exports = {
  readRerankTopK,
  buildContextFromLines,
  rerankPickLines,
  buildStructuredContext,
  tokenizeForOverlap,
};
