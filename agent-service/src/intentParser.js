function scoreByKeywords(text, keywords) {
  let hits = 0;
  for (const k of keywords) {
    if (text.includes(k)) hits += 1;
  }
  return hits;
}

function clamp01(n) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function parseIntentStub({ input }) {
  const text = String(input || "");
  const normalized = text.trim();
  const lower = normalized.toLowerCase();

  const ruleDoc = {
    name: "generate_requirements_doc",
    // lower 里只有英文会变化，所以这里的缩写关键词也使用小写形式
    keywords: ["需求文档", "prd", "需求要点", "需求点", "需求摘要", "需求整理"],
    outputKind: "doc",
    slot: {
      documentKind: "requirements",
    },
  };

  const rulePpt = {
    name: "generate_review_ppt",
    keywords: ["ppt", "评审ppt", "评审", "汇报ppt", "演示"],
    outputKind: "ppt",
    slot: {
      pptKind: "review",
    },
  };

  const ruleSummary = {
    name: "summarize_conversation",
    keywords: ["总结", "结论", "关键结论", "给出总结", "汇总", "提炼", "概括"],
    outputKind: "summary",
    slot: {
      wantsConclusion: true,
    },
  };

  const hitsDoc = scoreByKeywords(lower, ruleDoc.keywords);
  const hitsPpt = scoreByKeywords(lower, rulePpt.keywords);
  const hitsSummary = scoreByKeywords(lower, ruleSummary.keywords);

  // 选择命中最高的意图；若完全没命中，走 unknown。
  const candidates = [
    { ...ruleDoc, hits: hitsDoc, base: 0.82 },
    { ...rulePpt, hits: hitsPpt, base: 0.78 },
    { ...ruleSummary, hits: hitsSummary, base: 0.75 },
  ];

  candidates.sort((a, b) => b.hits - a.hits);
  const best = candidates[0];
  const totalHits = hitsDoc + hitsPpt + hitsSummary;

  let intent;
  if (!best || best.hits === 0 || totalHits === 0) {
    intent = { name: "unknown", confidence: 0.3 };
  } else {
    const confidence = clamp01(best.base + best.hits * 0.06);
    intent = { name: best.name, confidence };
  }

  const outputKinds = [];
  if (hitsDoc > 0) outputKinds.push("doc");
  if (hitsPpt > 0) outputKinds.push("ppt");
  if (hitsSummary > 0) outputKinds.push("summary");
  if (outputKinds.length === 0) outputKinds.push("unknown");

  const slots = {
    outputKinds,
    wantsUserConfirm: lower.includes("确认") || lower.includes("需要确认"),
    ...((hitsDoc > 0 && ruleDoc.slot) || {}),
    ...((hitsPpt > 0 && rulePpt.slot) || {}),
    ...((hitsSummary > 0 && ruleSummary.slot) || {}),
  };

  const entities = [];
  if (hitsDoc > 0) entities.push({ type: "documentKind", value: ruleDoc.slot.documentKind });
  if (hitsPpt > 0) entities.push({ type: "pptKind", value: rulePpt.slot.pptKind });
  if (hitsSummary > 0) entities.push({ type: "conclusion", value: true });

  return {
    intent,
    slots,
    entities,
    meta: {
      inputLength: normalized.length,
    },
  };
}

module.exports = { parseIntentStub };

