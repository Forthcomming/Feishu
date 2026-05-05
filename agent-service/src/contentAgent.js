function envOptional(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const { resolveDocTemplate, resolveSlidesTemplate } = require("./intentTemplates");
const { buildSlideXml, slideRoleForIndex } = require("./slideTemplates");
const { restructureContent, evaluateDocQuality } = require("./contentRestructure");
const { callChatCompletions } = require("./llmChat");

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function bullets(lines, max) {
  const arr = Array.isArray(lines) ? lines : [];
  return arr
    .map((s) => String(s || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, max)
    .map((s) => `- ${s}`)
    .join("\n");
}

function pickLinesFromInput(text, { maxLines = 20 } = {}) {
  const s = String(text || "");
  const lines = s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  // Keep only quoted IM lines or recent plain lines
  const quoted = lines.filter((l) => l.startsWith("> ")).map((l) => l.slice(2).trim());
  const base = quoted.length > 0 ? quoted : lines;
  return base.slice(-maxLines);
}

function ruleSummarize({ text, contextSummary }) {
  const lines = pickLinesFromInput(text, { maxLines: 18 });
  const picked = lines.slice(-10);
  const decision = picked.filter((l) => /决定|结论|定了|就这么办|OK|同意|通过/.test(l));
  const questions = picked.filter((l) => /吗\??$|？$|是否|要不要|能不能|怎么|为什么/.test(l));
  const actions = picked.filter((l) => /TODO|待办|下一步|行动|安排|需要|请/.test(l));

  const parts = [];
  parts.push("## 上下文摘要");
  parts.push("### 关键要点");
  parts.push(bullets(picked, 8) || "- （暂无）");
  parts.push("\n### 决策/结论");
  parts.push(bullets(decision, 5) || "- （暂无明确结论）");
  parts.push("\n### 待确认问题");
  parts.push(bullets(questions, 6) || "- （暂无）");
  parts.push("\n### 行动项");
  parts.push(bullets(actions, 6) || "- （暂无）");
  if (typeof contextSummary === "string" && contextSummary.trim()) {
    parts.push("\n---\n");
    parts.push("### 已有摘要（来自入口）");
    parts.push(contextSummary.trim());
  }
  return parts.join("\n");
}

function ruleExtractRequirements({ text, docType }) {
  const lines = pickLinesFromInput(text, { maxLines: 24 });
  const reqRe =
    docType === "solution"
      ? /方案|实现|接口|架构|改造|性能|稳定性|重构|模块/
      : docType === "meeting_summary"
        ? /决定|结论|行动项|待办|owner|ddl|纪要|议题/
        : docType === "report"
          ? /数据|指标|进展|复盘|问题|结论|建议/
          : docType === "brainstorm"
            ? /想法|点子|备选|方案|假设|验证/
            : /需求|要做|希望|支持|实现|功能|场景|prd/;
  const req = lines.filter((l) => reqRe.test(l));
  const constraints = lines.filter((l) => /不(能|要)|限制|必须|仅|默认|权限|安全|合规|依赖|成本/.test(l));
  const risks = lines.filter((l) => /风险|问题|阻塞|不确定|可能|需要确认|冲突|延期/.test(l));

  const parts = [];
  parts.push(docType === "solution" ? "## 方案要点/约束/风险（抽取）" : "## 需求点/约束/风险（抽取）");
  parts.push(docType === "meeting_summary" ? "### 关键事项" : "### 要点");
  parts.push(bullets(req, 10) || "- （待补充）");
  parts.push("\n### 约束/假设");
  parts.push(bullets(constraints, 8) || "- （待补充）");
  parts.push("\n### 风险点");
  parts.push(bullets(risks, 8) || "- （待补充）");
  return parts.join("\n");
}

function ruleClarifyQuestions({ text, docType, scenario }) {
  const lines = pickLinesFromInput(text, { maxLines: 18 });
  const qs = lines.filter((l) => /吗\??$|？$|是否|要不要|能不能|怎么|为什么|确认/.test(l));
  const defaults =
    docType === "meeting_summary"
      ? ["会议主题与时间是什么？", "结论是否已确认？", "行动项分别由谁负责（owner）与截止时间（ddl）？", "是否需要同步给其他群/同事？"]
      : docType === "solution"
        ? ["方案目标与约束是什么？", "关键接口/数据结构是否已定稿？", "风险与回滚预案是否需要补充？", "里程碑与负责人是谁？"]
        : docType === "prd"
          ? ["目标用户与使用场景是什么？", "范围（包含/不包含）是否明确？", "验收标准是什么？", "是否需要埋点与数据指标？"]
          : ["目标与使用场景是什么？", "产出需要包含哪些模块（背景/目标/范围/流程/风险/里程碑）？", "是否有明确的截止时间与里程碑？"];
  const scenarioHint =
    scenario === "handoff" ? ["需要同步给谁？是否需要一段可直接转发的摘要？"] : scenario === "review" ? ["本次评审的决策点是什么？"] : [];
  const picked = qs.length > 0 ? qs.map((x) => x.replace(/^[\-*]+\s*/g, "")) : defaults;
  return ["## 待确认问题（澄清清单）", bullets([...picked, ...scenarioHint], 9) || "- （暂无）"].join("\n");
}

function ruleOutline({ wantsDoc, wantsSlides, template, pptTemplate }) {
  const parts = [];
  parts.push("## 结构大纲（可编辑）");
  if (wantsDoc) {
    const h = typeof template?.h1 === "string" && template.h1.trim() ? template.h1.trim() : "文档";
    parts.push(`### ${h}大纲`);
    const seed = Array.isArray(template?.outlineSeed) ? template.outlineSeed : [];
    parts.push(bullets(seed, 14) || "- （待补充）");
  }
  if (wantsSlides) {
    const deck = typeof pptTemplate?.deckTitle === "string" && pptTemplate.deckTitle.trim() ? pptTemplate.deckTitle.trim() : "演示稿";
    parts.push(`\n### ${deck}大纲`);
    const outline = Array.isArray(pptTemplate?.sectionOutline) ? pptTemplate.sectionOutline : [];
    parts.push(bullets(outline, 12) || "- （待补充）");
  }
  return parts.join("\n");
}

function stripMdPrefix(line) {
  return String(line || "")
    .replace(/^\s{0,3}[-*+]\s+/, "")
    .replace(/^\s{0,3}\d+[.)]\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .trim();
}

function pickSlideLinesFromMarkdown(md, max) {
  const lines = String(md || "")
    .split(/\r?\n/)
    .map(stripMdPrefix)
    .filter(Boolean);
  return lines.slice(0, max);
}

function chunk(arr, size) {
  const out = [];
  const n = Number.isFinite(size) && size > 0 ? Math.floor(size) : 5;
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function normalizeSlideText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/^[\-*]+\s*/g, "")
    .trim();
}

function evaluateSlidesPlanQuality(plan) {
  const reasons = [];
  const slides = Array.isArray(plan?.slides) ? plan.slides : [];
  const confidence = Number(plan?.confidence ?? 0.7);
  if (slides.length < 6 || slides.length > 10) reasons.push("slides_count_out_of_range");

  const genericTitleRe = /^(概览|总结|要点|核心要点|结论|背景|方案|风险|下一步|计划)\s*$/;
  const allBullets = [];

  for (const s of slides) {
    const title = normalizeSlideText(s?.title);
    if (!title) reasons.push("empty_title");
    if (title && genericTitleRe.test(title)) reasons.push("generic_title");

    const bulletsArr = Array.isArray(s?.bullets) ? s.bullets.map(normalizeSlideText).filter(Boolean) : [];
    if (bulletsArr.length < 3 || bulletsArr.length > 5) reasons.push("bullets_count_out_of_range");
    allBullets.push(...bulletsArr);
  }

  // Repetition check across all bullets.
  const normBullets = allBullets.map((x) => x.toLowerCase()).filter(Boolean);
  const seen = new Set();
  let dup = 0;
  for (const b of normBullets) {
    if (seen.has(b)) dup += 1;
    else seen.add(b);
  }
  if (normBullets.length >= 12 && dup / Math.max(1, normBullets.length) > 0.25) reasons.push("too_repetitive");

  return { ok: reasons.length === 0, reasons, confidence };
}

async function callLlmRewriteSlidesPlan({ text, contextSummary, intent, slidesTemplate, cleaned, timeoutMs }) {
  const pptType = intent && typeof intent === "object" ? intent.ppt_type : "report";
  const scenario = intent && typeof intent === "object" ? intent.scenario : "discussion";
  const system = [
    "你是一个演示稿（PPT）结构与文案生成器。",
    "任务：根据用户指令与已清洗要点，生成“叙事连贯、可直接上屏”的 PPT 页计划（slides plan）。",
    "硬性要求：",
    "- 输出严格 JSON（不要代码块，不要多余解释）。",
    '- schema: {"slides":[{"title":"","bullets":[""]}],"confidence":0-1}',
    "- slides 总页数必须在 6-10 页（含封面与附录）。",
    "- 除封面外，每页 bullets 必须 3-5 条，短句，避免重复。",
    "输出风格：中文；标题要具体，不要空泛。",
    `当前意图：ppt_type=${String(pptType)} scenario=${String(scenario)}`,
    `推荐章节顺序：${Array.isArray(slidesTemplate?.sectionOutline) ? slidesTemplate.sectionOutline.join(" | ") : ""}`,
  ].join("\n");

  const user = [
    `用户指令：${String(text || "").trim()}`,
    `上下文摘要：${String(contextSummary || "").trim()}`,
    "",
    "已清洗要点（按桶）：",
    `- facts: ${(Array.isArray(cleaned?.facts) ? cleaned.facts : []).slice(0, 18).join(" | ")}`,
    `- decisions: ${(Array.isArray(cleaned?.decisions) ? cleaned.decisions : []).slice(0, 12).join(" | ")}`,
    `- actions: ${(Array.isArray(cleaned?.actions) ? cleaned.actions : []).slice(0, 12).join(" | ")}`,
    `- risks: ${(Array.isArray(cleaned?.risks) ? cleaned.risks : []).slice(0, 12).join(" | ")}`,
    `- constraints: ${(Array.isArray(cleaned?.constraints) ? cleaned.constraints : []).slice(0, 12).join(" | ")}`,
    `- openQuestions: ${(Array.isArray(cleaned?.openQuestions) ? cleaned.openQuestions : []).slice(0, 12).join(" | ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  const content = await callLlm({ system, user, timeoutMs, temperature: 0.2, purpose: "content" });
  const jsonStart = content.indexOf("{");
  const jsonEnd = content.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error("slides plan returned no json");
  const obj = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
  const plan = {
    slides: Array.isArray(obj.slides) ? obj.slides : [],
    confidence: clamp01(Number(obj.confidence ?? 0.7)),
  };
  return plan;
}

function generateSlidesXmlArray({ bundle, text, intent }) {
  const slidesTemplate = resolveSlidesTemplate(intent);
  const b = bundle && typeof bundle === "object" ? bundle : {};
  const rewrittenPlan = b?.rewrittenSlidesPlan;
  if (rewrittenPlan && typeof rewrittenPlan === "object") {
    const slides = Array.isArray(rewrittenPlan.slides) ? rewrittenPlan.slides : [];
    const n = slides.length;
    const visualTheme = slidesTemplate.visualTheme;
    const xml = [];
    for (let i = 0; i < slides.length; i += 1) {
      const s = slides[i];
      const title = normalizeSlideText(s?.title) || "未命名";
      const bulletsArr = Array.isArray(s?.bullets) ? s.bullets.map(normalizeSlideText).filter(Boolean) : [];
      const role = slideRoleForIndex(i, n);
      xml.push(buildSlideXml({ title, bullets: bulletsArr.slice(0, 6), role, visualTheme }));
    }
    return xml.slice(0, 10);
  }
  // Fail-fast: PPT must have rewritten slides plan for readability.
  if (slidesTemplate && intent && intent.output_type === "ppt") {
    throw new Error("missing rewrittenSlidesPlan");
  }

  const structuredLines = Array.isArray(b.pptOutlineLines) ? b.pptOutlineLines.filter(Boolean).map((x) => String(x).trim()).filter(Boolean) : [];
  const outlineLines = pickSlideLinesFromMarkdown(b.outlineMd, 24);
  const summaryLines = pickSlideLinesFromMarkdown(b.summaryMd, 20);
  const requirementLines = pickSlideLinesFromMarkdown(b.requirementsMd, 20);
  const fallbackLines = pickLinesFromInput(text, { maxLines: 12 }).map(stripMdPrefix).filter(Boolean);

  const core =
    structuredLines.length > 0
      ? structuredLines
      : outlineLines.length > 0
        ? outlineLines
        : summaryLines.length > 0
          ? summaryLines
          : requirementLines;
  const all = core.length > 0 ? core : fallbackLines;
  const groups = chunk(all, 5).slice(0, 8);

  const visualTheme = slidesTemplate.visualTheme;
  const slides = [];
  const coverBullets = all.slice(0, 4).length > 0 ? all.slice(0, 4) : ["根据讨论内容自动生成"];
  slides.push(
    buildSlideXml({
      title: slidesTemplate.coverTitle,
      bullets: coverBullets,
      role: "cover",
      visualTheme,
    }),
  );
  const sectionTitles = Array.isArray(slidesTemplate.sectionOutline) ? slidesTemplate.sectionOutline : [];
  const totalPlanned = 1 + groups.length;
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    const title = sectionTitles[i] ? sectionTitles[i] : `核心要点 ${i + 1}`;
    const idx = i + 1;
    const role = slideRoleForIndex(idx, totalPlanned);
    slides.push(buildSlideXml({ title, bullets: g, role, visualTheme }));
  }
  return slides.slice(0, 10);
}

async function callLlm({ system, user, timeoutMs, temperature, purpose }) {
  return callChatCompletions({ system, user, timeoutMs, temperature, purpose });
}

function parseBoolEnv(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!s) return null;
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return null;
}

async function callDoubaoRewriteDoc({
  text,
  contextSummary,
  intent,
  template,
  cleaned,
  evidencePoolMd,
  outlineMd,
  timeoutMs,
}) {
  const docType = intent && typeof intent === "object" ? intent.doc_type : "meeting_summary";
  const scenario = intent && typeof intent === "object" ? intent.scenario : "discussion";
  const system = [
    "你是一个技术方案文档编辑器。",
    "任务：把“已清洗的要点”综合重写为一份可讨论的技术方案文档正文（不是原句堆砌）。",
    "要求：",
    "- 严格按 markdown 输出，并且必须包含多个二级标题（##）。",
    "- 每个二级标题下给出 3-7 条要点（- 列表）。",
    "- 每个二级标题末尾必须包含一个“### 证据引用”小节，列 1-3 条来自证据池的短句（必须原样引用，不要改写）。",
    "- 信息不足时允许写“待定/需确认”，但必须写到“待决问题/澄清清单”里，禁止编造事实。",
    "- 禁止输出：元信息/对话原文/‘对上述讨论进行整理’/空壳占位。",
    "请输出严格 JSON（不要代码块，不要多余解释）。",
    'schema: {"rewritten_md":"","confidence":0-1}',
    `当前意图：doc_type=${String(docType)} scenario=${String(scenario)}`,
    `文档标题：${String(template?.h1 || "").trim()}`,
    `大纲种子：${Array.isArray(template?.outlineSeed) ? template.outlineSeed.join(" | ") : ""}`,
  ].join("\n");

  const user = [
    `用户指令：${String(text || "").trim()}`,
    `上下文摘要：${String(contextSummary || "").trim()}`,
    `结构大纲（可编辑）：\n${String(outlineMd || "").trim()}`,
    "",
    "已清洗要点（按桶）：",
    `- facts: ${(Array.isArray(cleaned?.facts) ? cleaned.facts : []).slice(0, 16).join(" | ")}`,
    `- decisions: ${(Array.isArray(cleaned?.decisions) ? cleaned.decisions : []).slice(0, 12).join(" | ")}`,
    `- actions: ${(Array.isArray(cleaned?.actions) ? cleaned.actions : []).slice(0, 12).join(" | ")}`,
    `- risks: ${(Array.isArray(cleaned?.risks) ? cleaned.risks : []).slice(0, 12).join(" | ")}`,
    `- constraints: ${(Array.isArray(cleaned?.constraints) ? cleaned.constraints : []).slice(0, 12).join(" | ")}`,
    `- openQuestions: ${(Array.isArray(cleaned?.openQuestions) ? cleaned.openQuestions : []).slice(0, 12).join(" | ")}`,
    "",
    String(evidencePoolMd || "").trim(),
  ]
    .filter(Boolean)
    .join("\n");

  const content = await callLlm({ system, user, timeoutMs, temperature: 0.2, purpose: "content" });
  const jsonStart = content.indexOf("{");
  const jsonEnd = content.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error("no json found");
  const obj = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
  const rewrittenMd = typeof obj.rewritten_md === "string" ? obj.rewritten_md.trim() : "";
  const confidence = clamp01(Number(obj.confidence ?? 0.7));
  if (!rewrittenMd) throw new Error("missing rewritten_md");
  return { rewrittenMd, confidence };
}

async function generateContentBundle({ text, contextSummary, targetArtifacts, intent }) {
  const wantsDoc = Array.isArray(targetArtifacts) && targetArtifacts.includes("doc");
  const wantsSlides = Array.isArray(targetArtifacts) && targetArtifacts.includes("slides");
  const timeoutMs = Number(envOptional("CONTENT_TIMEOUT_MS") ?? "8000");
  const hasAnyLlm = Boolean(envOptional("DOUBAO_API_KEY") || envOptional("DEEPSEEK_API_KEY"));
  const docTemplate = resolveDocTemplate(intent);
  const slidesTemplate = resolveSlidesTemplate(intent);
  const docType = intent && typeof intent === "object" ? intent.doc_type : "meeting_summary";
  const scenario = intent && typeof intent === "object" ? intent.scenario : "discussion";

  const withRestructure = (base) => {
    try {
      const r = restructureContent({ text, contextSummary, intent, bundle: base, targetArtifacts });
      return {
        ...base,
        restructuredMd: r.restructuredMd,
        docOutlineMd: r.docOutlineMd,
        pptOutlineLines: r.pptOutlineLines,
        cleaned: r.cleaned,
        evidencePoolMd: r.evidencePoolMd,
      };
    } catch {
      return { ...base, restructuredMd: "", docOutlineMd: "", pptOutlineLines: [], cleaned: null, evidencePoolMd: "" };
    }
  };

  if (!hasAnyLlm) {
    throw new Error("LLM is required: missing DOUBAO_API_KEY/DEEPSEEK_API_KEY");
  }

  const system = [
    "你是一个办公协同助手的内容生成器。",
    "目标：根据用户指令与上下文，生成 4 段 markdown：上下文摘要、需求点抽取、待确认问题清单、结构大纲。",
    "请输出严格 JSON（不要代码块，不要多余解释）。",
    'schema: {"summary_md":"","requirements_md":"","clarify_md":"","outline_md":"","confidence":0-1}',
    "要求：markdown 用中文；每段包含清晰的小标题；条目使用 - 列表。",
    "请根据意图类型调整模板：PRD/会议纪要/技术方案/汇报/头脑风暴。",
    `当前意图：doc_type=${String(docType)} scenario=${String(scenario)}`,
    `文档模板要求：标题=${docTemplate.h1}；语气=${docTemplate.tone}；约束=${docTemplate.constraints.join("；")}`,
    `文档大纲种子：${Array.isArray(docTemplate.outlineSeed) ? docTemplate.outlineSeed.join(" | ") : ""}`,
    `演示稿大纲种子：${Array.isArray(slidesTemplate.sectionOutline) ? slidesTemplate.sectionOutline.join(" | ") : ""}`,
  ].join("\n");

  const user = [
    `用户指令：${String(text || "").trim()}`,
    `上下文摘要：${String(contextSummary || "").trim()}`,
    `目标产物：doc=${wantsDoc ? "true" : "false"} slides=${wantsSlides ? "true" : "false"}`,
  ].join("\n");

  const content = await callLlm({ system, user, timeoutMs, temperature: 0.2, purpose: "content" });
  const jsonStart = content.indexOf("{");
  const jsonEnd = content.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error("LLM content returned no json");
  const obj = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
  const summaryMd = typeof obj.summary_md === "string" ? obj.summary_md.trim() : "";
  const requirementsMd = typeof obj.requirements_md === "string" ? obj.requirements_md.trim() : "";
  const clarifyMd = typeof obj.clarify_md === "string" ? obj.clarify_md.trim() : "";
  const outlineMd = typeof obj.outline_md === "string" ? obj.outline_md.trim() : "";
  const confidence = clamp01(Number(obj.confidence ?? 0.7));
  if (!summaryMd || !requirementsMd || !clarifyMd || !outlineMd) throw new Error("LLM content missing required fields");
  const structured = withRestructure({ source: "llm", summaryMd, requirementsMd, clarifyMd, outlineMd, confidence });

  // PPT: rewrite slides plan + quality gate (fail-fast).
  if (wantsSlides) {
    const slidesTimeoutMs = Number(envOptional("PPT_REWRITE_TIMEOUT_MS") ?? String(timeoutMs));
    const plan = await callLlmRewriteSlidesPlan({
      text,
      contextSummary,
      intent,
      slidesTemplate,
      cleaned: structured.cleaned,
      timeoutMs: slidesTimeoutMs,
    });
    const q = evaluateSlidesPlanQuality(plan);
    if (!q.ok) {
      const reasons = Array.isArray(q.reasons) ? q.reasons.join(",") : "unknown";
      throw new Error(`slides plan quality gate failed: ${reasons}`);
    }
    structured.rewrittenSlidesPlan = plan;
    structured.rewrittenSlidesConfidence = q.confidence;
  }

  // Optional: rewrite final doc body for all doc types (readability-first).
  const enabledEnv = parseBoolEnv(envOptional("DOC_REWRITE_ENABLED"));
  const shouldRewrite = enabledEnv == null ? wantsDoc === true : enabledEnv === true;
  if (!shouldRewrite) return structured;

  const rewriteTimeoutMs = Number(envOptional("DOC_REWRITE_TIMEOUT_MS") ?? String(timeoutMs));
  const rw = await callDoubaoRewriteDoc({
    text,
    contextSummary,
    intent,
    template: docTemplate,
    cleaned: structured.cleaned,
    evidencePoolMd: structured.evidencePoolMd,
    outlineMd: structured.docOutlineMd || structured.outlineMd,
    timeoutMs: rewriteTimeoutMs,
  });
  const quality = evaluateDocQuality(rw.rewrittenMd);
  if (!quality.ok) {
    const reasons = Array.isArray(quality.reasons) ? quality.reasons.join(",") : "unknown";
    throw new Error(`rewrittenMd quality gate failed: ${reasons}`);
  }
  return {
    ...structured,
    rewrittenMd: rw.rewrittenMd,
    rewrittenConfidence: rw.confidence,
  };
}

module.exports = { generateContentBundle, generateSlidesXmlArray };

