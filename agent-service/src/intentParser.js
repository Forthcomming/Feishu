const OUTPUT_TYPES = ["doc", "ppt"];
const DOC_TYPES = ["prd", "meeting_summary", "solution", "report", "brainstorm"];
const PPT_TYPES = ["review", "report", "proposal"];
const SCENARIOS = ["discussion", "review", "handoff", "brainstorm"];
const FALLBACK_DOC_TYPE = "meeting_summary";

const RE_SLIDES_URL = /https?:\/\/[^\s"']+\/slides\/[A-Za-z0-9_-]+/;
const RE_EXPLICIT_PPT = /(ppt|演示稿|幻灯片|slides|deck)/i;
const RE_NEGATED_PPT = /(不要|不需要|别(做|搞|生成)?|不是).{0,6}(ppt|幻灯片|演示稿|slides|deck)/i;
const RE_DOC_SUBTYPE_HIT =
  /会议纪要|会后纪要|会议总结|\bprd\b|需求文档|产品需求|需求说明|技术方案|方案设计|改造方案|周报|月报|头脑风暴|brainstorm|创意清单|汇报|报告/;

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

function normalizeIntentOutput(raw) {
  const output_type = OUTPUT_TYPES.includes(raw?.output_type) ? raw.output_type : "doc";
  const doc_type = DOC_TYPES.includes(raw?.doc_type) ? raw.doc_type : FALLBACK_DOC_TYPE;
  const ppt_type = PPT_TYPES.includes(raw?.ppt_type) ? raw.ppt_type : "report";
  const scenario = SCENARIOS.includes(raw?.scenario) ? raw.scenario : "discussion";
  const confidence = clamp01(Number(raw?.confidence ?? 0.5));
  const reasoning = typeof raw?.reasoning === "string" && raw.reasoning.trim() ? raw.reasoning.trim() : "命中默认规则。";
  return { output_type, doc_type, ppt_type, scenario, confidence, reasoning };
}

/**
 * 强约束规则：仅扫描用户输入；context 保留签名兼容，不参与推断。
 */
function parseIntent(input, context = {}) {
  void context;
  const raw = String(input || "");
  const text = normalizeText(input);
  const hasSlidesUrl = RE_SLIDES_URL.test(raw);
  const explicitPpt = RE_EXPLICIT_PPT.test(text);
  const negatedPpt = RE_NEGATED_PPT.test(text);
  const explicitPptIntent = explicitPpt && !negatedPpt;

  let output_type = "doc";
  if (hasSlidesUrl || explicitPptIntent) output_type = "ppt";

  let doc_type = FALLBACK_DOC_TYPE;
  if (/会议纪要|会后纪要|会议总结/.test(text)) doc_type = "meeting_summary";
  else if (/\bprd\b|需求文档|产品需求|需求说明/.test(text)) doc_type = "prd";
  else if (/技术方案|方案设计|改造方案/.test(text)) doc_type = "solution";
  else if (/头脑风暴|brainstorm|创意清单/.test(text)) doc_type = "brainstorm";
  else if (/周报|月报|汇报|报告/.test(text)) doc_type = "report";

  let ppt_type = "report";
  if (/评审|复盘|review/.test(text)) ppt_type = "review";
  else if (/提案|proposal|立项|方案汇报/.test(text)) ppt_type = "proposal";

  let scenario = "discussion";
  if (/评审|复盘|review|验收/.test(text)) scenario = "review";
  else if (/交接|周报|月报|汇报|发群里|同步给|handoff/.test(text)) scenario = "handoff";
  else if (/头脑风暴|brainstorm/.test(text)) scenario = "brainstorm";

  const explicitDocSubtype = RE_DOC_SUBTYPE_HIT.test(text);
  const explicitTypeHit = Boolean(hasSlidesUrl || explicitPptIntent || explicitDocSubtype);
  let explicitTypeKind = "none";
  if (explicitPptIntent || hasSlidesUrl) explicitTypeKind = "ppt";
  else if (explicitDocSubtype) explicitTypeKind = "doc_subtype";

  const confidence = explicitTypeHit ? 0.85 : 0.4;
  const reasoning = explicitTypeHit ? "命中强约束规则" : "未命中强约束，建议交由 LLM 判定";

  const normalized = normalizeIntentOutput({
    output_type,
    doc_type,
    ppt_type,
    scenario,
    confidence,
    reasoning,
  });
  return {
    ...normalized,
    meta: {
      explicitTypeHit,
      explicitTypeKind,
      hasSlidesUrl,
      negatedPpt,
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
