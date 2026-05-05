const DEFAULT_INTENT = Object.freeze({
  output_type: "doc",
  doc_type: "meeting_summary",
  ppt_type: "report",
  scenario: "discussion",
});

function safeIntent(intent) {
  const i = intent && typeof intent === "object" ? intent : {};
  const output_type = i.output_type === "ppt" ? "ppt" : "doc";
  const doc_type =
    i.doc_type === "prd" || i.doc_type === "meeting_summary" || i.doc_type === "solution" || i.doc_type === "report" || i.doc_type === "brainstorm"
      ? i.doc_type
      : DEFAULT_INTENT.doc_type;
  const ppt_type = i.ppt_type === "review" || i.ppt_type === "report" || i.ppt_type === "proposal" ? i.ppt_type : DEFAULT_INTENT.ppt_type;
  const scenario = i.scenario === "discussion" || i.scenario === "review" || i.scenario === "handoff" || i.scenario === "brainstorm" ? i.scenario : DEFAULT_INTENT.scenario;
  return { output_type, doc_type, ppt_type, scenario };
}

function resolveDocTemplate(intent) {
  const i = safeIntent(intent);
  const typeToTitle = {
    prd: "PRD",
    meeting_summary: "会议纪要",
    solution: "技术方案",
    report: "汇报报告",
    brainstorm: "头脑风暴纪要",
  };
  const baseTitle = typeToTitle[i.doc_type] || "会议纪要";

  const sectionsOrderByType = {
    prd: ["task", "intent", "summary", "requirements", "outline", "clarify", "plan"],
    meeting_summary: ["task", "intent", "summary", "clarify", "outline", "plan"],
    solution: ["task", "intent", "summary", "requirements", "outline", "clarify", "plan"],
    report: ["task", "intent", "summary", "requirements", "outline", "clarify", "plan"],
    brainstorm: ["task", "intent", "summary", "outline", "clarify", "plan"],
  };

  const outlineSeedByType = {
    prd: [
      "背景与目标",
      "范围（包含/不包含）",
      "用户画像与使用场景",
      "需求列表（P0/P1/P2）",
      "流程与交互（可配图）",
      "数据与埋点",
      "验收标准",
      "风险与待确认",
      "里程碑与排期",
    ],
    meeting_summary: ["会议主题与参会人", "议题与关键讨论点", "结论/决定", "行动项（owner/ddl）", "待确认问题"],
    solution: ["背景与目标", "现状与问题", "方案概述", "架构/模块拆分", "接口/数据结构", "风险与权衡", "里程碑与回滚预案"],
    report: ["核心结论", "关键数据与指标", "问题与原因分析", "建议与下一步", "风险与待确认"],
    brainstorm: ["问题定义", "发散想法清单", "聚类与主题", "候选方案对比", "下一步实验/验证计划"],
  };

  const toneByScenario = {
    review: "偏评审：强调结论、风险与决策点",
    handoff: "偏交付：强调行动项、owner 与截止时间",
    brainstorm: "偏发散：鼓励多方案、标记待验证假设",
    discussion: "偏讨论：结构清晰、便于继续补充",
  };

  return {
    title: `${baseTitle}（Agent）`,
    h1: `${baseTitle}（Agent）`,
    sectionsOrder: sectionsOrderByType[i.doc_type] || sectionsOrderByType.meeting_summary,
    outlineSeed: outlineSeedByType[i.doc_type] || outlineSeedByType.meeting_summary,
    tone: toneByScenario[i.scenario] || toneByScenario.discussion,
    constraints: [
      "输出必须结构化、可执行",
      "信息不足时保持占位但不要编造事实",
      i.scenario === "handoff" ? "行动项必须包含 owner 与 ddl（若未知用 待定）" : "",
    ].filter(Boolean),
  };
}

// 飞书 SML：渐变须用 rgba + 百分比停靠点（与 lark-slides xml-schema-quick-ref 一致）
const VISUAL_THEMES = Object.freeze({
  review: {
    coverBg: "linear-gradient(135deg,rgba(15,23,42,1) 0%,rgba(56,97,140,1) 100%)",
    contentBg: "rgb(248,250,252)",
    closingBg: "linear-gradient(135deg,rgba(30,41,59,1) 0%,rgba(71,85,105,1) 100%)",
    accentRgb: "rgb(59,130,246)",
    onDark: "rgb(255,255,255)",
    onLightTitle: "rgb(15,23,42)",
    onLightBody: "rgb(30,41,59)",
  },
  report: {
    coverBg: "linear-gradient(135deg,rgba(30,60,114,1) 0%,rgba(59,130,246,1) 100%)",
    contentBg: "rgb(248,250,252)",
    closingBg: "linear-gradient(135deg,rgba(30,60,114,1) 0%,rgba(45,90,180,1) 100%)",
    accentRgb: "rgb(59,130,246)",
    onDark: "rgb(255,255,255)",
    onLightTitle: "rgb(30,60,114)",
    onLightBody: "rgb(15,23,42)",
  },
  proposal: {
    coverBg: "linear-gradient(135deg,rgba(88,28,135,1) 0%,rgba(190,24,93,1) 100%)",
    contentBg: "rgb(255,255,255)",
    closingBg: "linear-gradient(135deg,rgba(88,28,135,1) 0%,rgba(157,23,77,1) 100%)",
    accentRgb: "rgb(168,85,247)",
    onDark: "rgb(255,255,255)",
    onLightTitle: "rgb(88,28,135)",
    onLightBody: "rgb(51,65,85)",
  },
});

function resolveSlidesTemplate(intent) {
  const i = safeIntent(intent);
  const typeToDeck = {
    review: "评审演示稿",
    report: "汇报演示稿",
    proposal: "提案演示稿",
  };
  const deckBase = typeToDeck[i.ppt_type] || "汇报演示稿";

  const outlineByType = {
    review: ["背景与目标", "方案要点", "关键对比/权衡", "风险与待确认", "决策点与下一步"],
    report: ["概览与结论", "关键数据与进展", "问题与风险", "下一步计划", "需要支持/资源"],
    proposal: ["机会与目标", "提案概述", "实施方案", "收益评估", "风险与备选", "里程碑与资源"],
  };

  const visualTheme = VISUAL_THEMES[i.ppt_type] || VISUAL_THEMES.report;

  return {
    deckTitle: `${deckBase}（Agent）`,
    coverTitle: `${deckBase}（${i.scenario}）`,
    sectionOutline: outlineByType[i.ppt_type] || outlineByType.report,
    visualTheme,
  };
}

module.exports = { resolveDocTemplate, resolveSlidesTemplate, safeIntent };

