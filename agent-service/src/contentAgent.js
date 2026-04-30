function envOptional(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

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

function ruleExtractRequirements({ text }) {
  const lines = pickLinesFromInput(text, { maxLines: 24 });
  const req = lines.filter((l) => /需求|要做|希望|支持|实现|功能|场景/.test(l));
  const constraints = lines.filter((l) => /不(能|要)|限制|必须|仅|默认|权限|安全|合规/.test(l));
  const risks = lines.filter((l) => /风险|问题|阻塞|不确定|可能|需要确认/.test(l));

  const parts = [];
  parts.push("## 需求点/约束/风险（抽取）");
  parts.push("### 需求点");
  parts.push(bullets(req, 10) || "- （待补充）");
  parts.push("\n### 约束/假设");
  parts.push(bullets(constraints, 8) || "- （待补充）");
  parts.push("\n### 风险点");
  parts.push(bullets(risks, 8) || "- （待补充）");
  return parts.join("\n");
}

function ruleClarifyQuestions({ text }) {
  const lines = pickLinesFromInput(text, { maxLines: 18 });
  const qs = lines.filter((l) => /吗\??$|？$|是否|要不要|能不能|怎么|为什么|确认/.test(l));
  const defaults = [
    "目标用户与使用场景是什么？",
    "产出需要包含哪些模块（背景/目标/范围/流程/风险/里程碑）？",
    "是否需要同时生成评审演示稿（PPT/Slides）？",
    "是否有明确的截止时间与里程碑？",
  ];
  const picked = qs.length > 0 ? qs.map((x) => x.replace(/^[\-*]+\s*/g, "")) : defaults;
  return ["## 待确认问题（澄清清单）", bullets(picked, 8) || "- （暂无）"].join("\n");
}

function ruleOutline({ wantsDoc, wantsSlides }) {
  const parts = [];
  parts.push("## 结构大纲（可编辑）");
  if (wantsDoc) {
    parts.push("### 需求文档大纲");
    parts.push(
      bullets(
        [
          "背景与目标",
          "范围（包含/不包含）",
          "用户画像与使用场景",
          "需求列表（P0/P1/P2）",
          "交互与流程（可配图）",
          "数据与埋点",
          "权限与安全",
          "风险与待确认",
          "里程碑与排期",
        ],
        12,
      ),
    );
  }
  if (wantsSlides) {
    parts.push("\n### 评审演示稿大纲");
    parts.push(
      bullets(
        ["背景与目标", "关键结论", "方案要点", "关键流程/原型", "风险与待确认", "里程碑与下一步"],
        10,
      ),
    );
  }
  return parts.join("\n");
}

async function callDoubaoContent({ system, user, timeoutMs }) {
  const apiKey = envOptional("DOUBAO_API_KEY");
  const baseUrl = envOptional("DOUBAO_BASE_URL") ?? "https://ark.cn-beijing.volces.com/api/v3";
  const endpointId = envOptional("DOUBAO_CONTENT_ENDPOINT_ID") ?? envOptional("DOUBAO_ENDPOINT_ID");
  if (!apiKey || !endpointId) throw new Error("missing DOUBAO_API_KEY or DOUBAO_CONTENT_ENDPOINT_ID/DOUBAO_ENDPOINT_ID");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: endpointId,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    const raw = await resp.text();
    if (!resp.ok) throw new Error(raw || `doubao http ${resp.status}`);
    const parsed = JSON.parse(raw);
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("doubao returned empty content");
    return content.trim();
  } finally {
    clearTimeout(t);
  }
}

async function generateContentBundle({ text, contextSummary, targetArtifacts }) {
  const wantsDoc = Array.isArray(targetArtifacts) && targetArtifacts.includes("doc");
  const wantsSlides = Array.isArray(targetArtifacts) && targetArtifacts.includes("slides");
  const timeoutMs = Number(envOptional("CONTENT_TIMEOUT_MS") ?? "8000");
  const hasDoubao = Boolean(envOptional("DOUBAO_API_KEY") && (envOptional("DOUBAO_CONTENT_ENDPOINT_ID") || envOptional("DOUBAO_ENDPOINT_ID")));

  if (!hasDoubao) {
    return {
      source: "rules",
      summaryMd: ruleSummarize({ text, contextSummary }),
      requirementsMd: ruleExtractRequirements({ text }),
      clarifyMd: ruleClarifyQuestions({ text }),
      outlineMd: ruleOutline({ wantsDoc, wantsSlides }),
      confidence: 0.75,
    };
  }

  try {
    const system = [
      "你是一个办公协同助手的内容生成器。",
      "目标：根据用户指令与上下文，生成 4 段 markdown：上下文摘要、需求点抽取、待确认问题清单、结构大纲。",
      "请输出严格 JSON（不要代码块，不要多余解释）。",
      'schema: {"summary_md":"","requirements_md":"","clarify_md":"","outline_md":"","confidence":0-1}',
      "要求：markdown 用中文；每段包含清晰的小标题；条目使用 - 列表。",
    ].join("\n");

    const user = [
      `用户指令：${String(text || "").trim()}`,
      `上下文摘要：${String(contextSummary || "").trim()}`,
      `目标产物：doc=${wantsDoc ? "true" : "false"} slides=${wantsSlides ? "true" : "false"}`,
    ].join("\n");

    const content = await callDoubaoContent({ system, user, timeoutMs });
    const jsonStart = content.indexOf("{");
    const jsonEnd = content.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error("no json found");
    const obj = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
    const summaryMd = typeof obj.summary_md === "string" ? obj.summary_md.trim() : "";
    const requirementsMd = typeof obj.requirements_md === "string" ? obj.requirements_md.trim() : "";
    const clarifyMd = typeof obj.clarify_md === "string" ? obj.clarify_md.trim() : "";
    const outlineMd = typeof obj.outline_md === "string" ? obj.outline_md.trim() : "";
    const confidence = clamp01(Number(obj.confidence ?? 0.7));
    if (!summaryMd || !requirementsMd || !clarifyMd || !outlineMd) throw new Error("missing fields");
    return { source: "doubao", summaryMd, requirementsMd, clarifyMd, outlineMd, confidence };
  } catch {
    return {
      source: "rules",
      summaryMd: ruleSummarize({ text, contextSummary }),
      requirementsMd: ruleExtractRequirements({ text }),
      clarifyMd: ruleClarifyQuestions({ text }),
      outlineMd: ruleOutline({ wantsDoc, wantsSlides }),
      confidence: 0.7,
    };
  }
}

module.exports = { generateContentBundle };

