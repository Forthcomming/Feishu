// 最小闭环用“可替换生成器”：先用启发式逻辑从用户输入生成 Doc blocks
// 后续把这里替换成真实 LLM + Tool + Memory 即可，但保持返回的 Document 结构不变。

function uniqueKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = String(x).trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function splitSentences(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/[;；]/g, "。")
    .split(/[。！？!\n]/g)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

function pickTitle(text) {
  const sents = splitSentences(text);
  if (sents.length) {
    const t = sents[0];
    return t.length > 26 ? t.slice(0, 26) + "…" : t;
  }
  const raw = String(text || "").trim();
  return raw ? (raw.length > 26 ? raw.slice(0, 26) + "…" : raw) : "未命名文档";
}

function pickSummary(text) {
  const sents = splitSentences(text);
  if (!sents.length) return "基于用户输入生成的文档摘要。";
  const first = sents.slice(0, 2).join("。");
  return first.length > 80 ? first.slice(0, 80) + "…" : first;
}

function pickRequirements(text) {
  const sents = splitSentences(text);
  if (!sents.length) return ["补充讨论内容后可生成更完整的需求要点。"];

  const keywords = ["需要", "希望", "要", "目标", "问题", "因此", "必须", "建议", "方案", "约束"];
  const matched = sents.filter((s) => keywords.some((k) => s.includes(k)));
  const base = matched.length ? matched : sents;

  const bullets = uniqueKeepOrder(base).slice(0, 6);
  if (!bullets.length) return ["从输入中未提取到明确需求要点。"];
  return bullets;
}

function pickConclusions(text) {
  const sents = splitSentences(text);
  if (!sents.length) return ["待补充：根据讨论形成关键结论。"];

  const conclusionKeywords = ["结论", "最终", "因此", "所以", "建议", "落地", "决定"];
  const matched = sents.filter((s) => conclusionKeywords.some((k) => s.includes(k)));
  const base = matched.length ? matched : sents.slice(-3);

  const bullets = uniqueKeepOrder(base).slice(-2);
  return bullets.length ? bullets : ["待补充：根据讨论形成关键结论。"];
}

function makeBlock({ blockId, blockType, content, version, lastUpdatedBy }) {
  return {
    blockId,
    blockType,
    content,
    version,
    lastUpdatedAt: Date.now(),
    lastUpdatedBy,
  };
}

function generateDocument({ docId, conversationId, userText }) {
  const title = pickTitle(userText);
  const summary = pickSummary(userText);
  const requirements = pickRequirements(userText);
  const conclusions = pickConclusions(userText);

  const blocks = {};
  const topLevelBlockIds = [];

  const titleId = `${docId}_b_title`;
  const summaryId = `${docId}_b_summary`;
  const reqId = `${docId}_b_requirements`;
  const concId = `${docId}_b_conclusion`;

  blocks[titleId] = makeBlock({
    blockId: titleId,
    blockType: "title",
    content: { text: title },
    version: 1,
    lastUpdatedBy: "agent_demo",
  });
  topLevelBlockIds.push(titleId);

  blocks[summaryId] = makeBlock({
    blockId: summaryId,
    blockType: "summary",
    content: { text: summary },
    version: 1,
    lastUpdatedBy: "agent_demo",
  });
  topLevelBlockIds.push(summaryId);

  blocks[reqId] = makeBlock({
    blockId: reqId,
    blockType: "requirements",
    content: { bullets: requirements },
    version: 1,
    lastUpdatedBy: "agent_demo",
  });
  topLevelBlockIds.push(reqId);

  blocks[concId] = makeBlock({
    blockId: concId,
    blockType: "conclusion",
    content: { bullets: conclusions },
    version: 1,
    lastUpdatedBy: "agent_demo",
  });
  topLevelBlockIds.push(concId);

  return {
    docId,
    conversationId,
    documentKind: "requirements",
    title,
    summary,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    blocks,
    topLevelBlockIds,
    version: 1,
    crdt: {
      algorithm: "custom",
      versionVector: {},
      lastAppliedOpId: "op_demo",
      hasUnresolvedConflicts: false,
    },
    // Demo 不做发布门控；字段保留给后续 PRD 扩展。
    publishGate: { requiresUserConfirm: false },
    sync: {
      clientId: "demo_client",
      actorId: "agent_demo",
      lamportTime: 1,
    },
  };
}

module.exports = { generateDocument };

