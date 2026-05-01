const OUTPUT_TYPES = ["doc", "ppt"];
const DOC_TYPES = ["prd", "meeting_summary", "solution", "report", "brainstorm"];
const PPT_TYPES = ["review", "report", "proposal"];
const SCENARIOS = ["discussion", "review", "handoff", "brainstorm"];
const FALLBACK_DOC_TYPE = "meeting_summary";

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function scoreByKeywords(weightedTexts, keywords) {
  let score = 0;
  for (const { text, weight } of weightedTexts) {
    if (!text) continue;
    for (const k of keywords) {
      if (text.includes(k)) score += weight;
    }
  }
  return score;
}

function pickByPriority(scored, priorityOrder, fallback) {
  let bestKey = fallback;
  let bestScore = -1;
  for (const key of priorityOrder) {
    const v = Number(scored[key] || 0);
    if (v > bestScore) {
      bestScore = v;
      bestKey = key;
    }
  }
  return { key: bestKey, score: bestScore };
}

function normalizeIntentOutput(raw) {
  const output_type = OUTPUT_TYPES.includes(raw?.output_type) ? raw.output_type : "doc";
  const doc_type = DOC_TYPES.includes(raw?.doc_type) ? raw.doc_type : FALLBACK_DOC_TYPE;
  const ppt_type = PPT_TYPES.includes(raw?.ppt_type) ? raw.ppt_type : "report";
  const scenario = SCENARIOS.includes(raw?.scenario) ? raw.scenario : "discussion";
  const confidence = clamp01(Number(raw?.confidence ?? 0.5));
  const reasoning = typeof raw?.reasoning === "string" && raw.reasoning.trim() ? raw.reasoning.trim() : "命中默认规则。";
  return { output_type, doc_type, ppt_type, scenario, confidence, reasoning };
}

function parseIntent(input, context = {}) {
  const inputText = normalizeText(input);
  const contextSummary = normalizeText(context?.contextSummary || "");
  const recentMessages = Array.isArray(context?.recentMessages) ? context.recentMessages.map((x) => normalizeText(x)).filter(Boolean) : [];
  const recentText = recentMessages.slice(-20).join("\n");

  const weightedTexts = [
    { text: inputText, weight: 3 },
    { text: contextSummary, weight: 2 },
    { text: recentText, weight: 1 },
  ];

  const scenarioKeywords = {
    review: ["评审", "review", "复盘", "过会", "验收", "评估"],
    handoff: ["交接", "同步给", "给老板汇报", "handoff", "发群里", "汇报给", "周报", "月报"],
    brainstorm: ["头脑风暴", "brainstorm", "发散", "创意", "想法", "灵感"],
    discussion: ["讨论", "梳理", "整理", "对齐", "沟通", "分析"],
  };
  const scenarioScores = {
    review: scoreByKeywords(weightedTexts, scenarioKeywords.review),
    handoff: scoreByKeywords(weightedTexts, scenarioKeywords.handoff),
    brainstorm: scoreByKeywords(weightedTexts, scenarioKeywords.brainstorm),
    discussion: scoreByKeywords(weightedTexts, scenarioKeywords.discussion),
  };
  const scenarioPicked = pickByPriority(scenarioScores, ["review", "handoff", "brainstorm", "discussion"], "discussion");
  const scenario = scenarioPicked.score > 0 ? scenarioPicked.key : "discussion";

  const outputTypeKeywords = {
    ppt: ["ppt", "演示稿", "汇报页", "幻灯片", "deck", "slides"],
    doc: ["文档", "纪要", "方案", "prd", "需求", "报告", "总结"],
  };
  const outputTypeScores = {
    ppt: scoreByKeywords(weightedTexts, outputTypeKeywords.ppt),
    doc: scoreByKeywords(weightedTexts, outputTypeKeywords.doc),
  };
  const hasSlidesLink = scoreByKeywords(weightedTexts, ["slides/"]) > 0;
  const explicitPptScore = scoreByKeywords([{ text: inputText, weight: 3 }], ["ppt", "演示稿", "幻灯片", "slides", "deck"]);
  let output_type = "doc";
  if (hasSlidesLink) {
    output_type = "ppt";
  } else if (outputTypeScores.ppt > outputTypeScores.doc && outputTypeScores.ppt > 0) {
    output_type = "ppt";
  } else if (outputTypeScores.doc > 0) {
    output_type = "doc";
  } else if (scenario === "review" && scoreByKeywords(weightedTexts, ["评审材料", "汇报材料"]) > 0) {
    output_type = "ppt";
  }

  const domainScores = {
    product: scoreByKeywords(weightedTexts, ["产品", "需求", "用户故事", "优先级", "版本计划", "roadmap", "prd"]),
    meeting: scoreByKeywords(weightedTexts, ["会议", "参会", "议题", "行动项", "待办", "纪要", "会后", "同步"]),
    tech: scoreByKeywords(weightedTexts, ["技术", "架构", "接口", "性能", "改造", "重构", "稳定性", "方案设计"]),
  };
  const organizeAsked = scoreByKeywords([{ text: inputText, weight: 3 }], ["整理一下", "整理下", "梳理一下", "梳理下", "整理", "梳理"]) > 0;
  const explicitDocTypeScores = {
    prd: scoreByKeywords([{ text: inputText, weight: 3 }], ["prd", "需求文档", "产品需求", "需求说明"]),
    meeting_summary: scoreByKeywords([{ text: inputText, weight: 3 }], ["会议纪要", "会后纪要", "会议总结", "纪要"]),
    solution: scoreByKeywords([{ text: inputText, weight: 3 }], ["技术方案", "方案设计", "改造方案", "方案"]),
    report: scoreByKeywords([{ text: inputText, weight: 3 }], ["汇报", "周报", "月报", "报告"]),
    brainstorm: scoreByKeywords([{ text: inputText, weight: 3 }], ["头脑风暴", "brainstorm", "创意清单"]),
  };
  const explicitPicked = pickByPriority(explicitDocTypeScores, ["prd", "meeting_summary", "solution", "report", "brainstorm"], "");

  let doc_type = FALLBACK_DOC_TYPE;
  let docTypeResolvedByOrganizeRule = false;
  if (output_type === "doc") {
    // Explicit doc-type words in user input should override context-based organize rules.
    if (explicitPicked.score > 0 && DOC_TYPES.includes(explicitPicked.key)) {
      doc_type = explicitPicked.key;
    } else if (organizeAsked) {
      const domainPicked = pickByPriority(domainScores, ["product", "meeting", "tech"], "meeting");
      if (domainPicked.score > 0) {
        if (domainPicked.key === "product") doc_type = "prd";
        else if (domainPicked.key === "tech") doc_type = "solution";
        else doc_type = "meeting_summary";
        docTypeResolvedByOrganizeRule = true;
      }
    }
    if (doc_type === FALLBACK_DOC_TYPE && !docTypeResolvedByOrganizeRule) {
      if (scoreByKeywords(weightedTexts, ["prd", "需求文档", "需求说明", "产品需求"]) > 0) doc_type = "prd";
      else if (scoreByKeywords(weightedTexts, ["方案", "技术方案", "改造方案"]) > 0) doc_type = "solution";
      else if (scoreByKeywords(weightedTexts, ["头脑风暴", "brainstorm", "创意"]) > 0 || scenario === "brainstorm") doc_type = "brainstorm";
      else if (scoreByKeywords(weightedTexts, ["报告", "周报", "月报", "汇报"]) > 0 || scenario === "handoff") doc_type = "report";
      else if (scoreByKeywords(weightedTexts, ["会议", "会议纪要", "会后"]) > 0) doc_type = "meeting_summary";
    }
  }

  let ppt_type = "report";
  if (scenario === "review" || scoreByKeywords(weightedTexts, ["评审", "复盘", "review"]) > 0) {
    ppt_type = "review";
  } else if (scoreByKeywords(weightedTexts, ["提案", "proposal", "方案汇报", "立项"]) > 0) {
    ppt_type = "proposal";
  }

  if (output_type !== "ppt" && !DOC_TYPES.includes(doc_type)) {
    doc_type = FALLBACK_DOC_TYPE;
  }
  if (!DOC_TYPES.includes(doc_type)) doc_type = FALLBACK_DOC_TYPE;

  const signalTotal =
    outputTypeScores.ppt +
    outputTypeScores.doc +
    scenarioScores.review +
    scenarioScores.handoff +
    scenarioScores.brainstorm +
    scenarioScores.discussion;
  const mainSignal = Math.max(outputTypeScores.ppt, outputTypeScores.doc, scenarioPicked.score, 0);
  const confidenceBase = signalTotal > 0 ? 0.55 + Math.min(0.4, mainSignal / Math.max(6, signalTotal + 1)) : 0.52;
  const confidence = Number(clamp01(confidenceBase).toFixed(2));

  const reasoningParts = [`场景=${scenario}`];
  reasoningParts.push(`输出=${output_type}`);
  reasoningParts.push(output_type === "ppt" ? `ppt_type=${ppt_type}` : `doc_type=${doc_type}`);
  if (organizeAsked) reasoningParts.push("命中“整理一下”上下文分流规则");
  const explicitTypeKind = explicitPptScore > 0 ? "ppt" : explicitPicked.score > 0 ? "doc_subtype" : "none";
  const explicitTypeHit = explicitTypeKind !== "none";

  const normalized = normalizeIntentOutput({
    output_type,
    doc_type,
    ppt_type,
    scenario,
    confidence,
    reasoning: reasoningParts.join("；"),
  });
  return {
    ...normalized,
    meta: {
      explicitTypeHit,
      explicitTypeKind,
    },
  };
}

module.exports = {
  OUTPUT_TYPES,
  DOC_TYPES,
  PPT_TYPES,
  SCENARIOS,
  FALLBACK_DOC_TYPE,
  normalizeIntentOutput,
  parseIntent,
};

