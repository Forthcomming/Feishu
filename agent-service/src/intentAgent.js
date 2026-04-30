const { parseIntentStub } = require("./intentParser");

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

function normalizeTaskType(taskType) {
  const t = String(taskType || "").toLowerCase().trim();
  if (t === "doc" || t === "document") return "doc";
  if (t === "slides" || t === "ppt" || t === "presentation") return "slides";
  if (t === "summary" || t === "summarize") return "summary";
  return "unknown";
}

function extractDocUrl(text) {
  const m = String(text || "").match(/https?:\/\/[^\s]+\/docx\/[A-Za-z0-9]+/);
  return m ? m[0] : "";
}

function mapStubToIntentResult(stub) {
  const name = stub?.intent?.name;
  const confidence = clamp01(Number(stub?.intent?.confidence ?? 0));
  const outputKinds = Array.isArray(stub?.slots?.outputKinds) ? stub.slots.outputKinds : [];

  let taskType = "unknown";
  if (name === "generate_review_ppt") taskType = "slides";
  else if (name === "generate_requirements_doc") taskType = "doc";
  else if (name === "summarize_conversation") taskType = "summary";

  const wantsDoc = outputKinds.includes("doc") || taskType === "doc";
  const wantsSlides = outputKinds.includes("ppt") || taskType === "slides";
  const targetArtifacts = wantsSlides ? (wantsDoc ? ["doc", "slides"] : ["slides"]) : ["doc"];

  return {
    source: "stub",
    intent: { name: taskType, confidence },
    slots: {
      targetArtifacts,
      basedOnDocUrl: "",
      contextRange: { mode: "recent_messages", limit: 20 },
      needClarify: taskType === "unknown" || confidence < 0.65,
      clarifyQuestion: "我没完全理解你的需求。你想生成：1) 需求文档 2) 演示稿PPT 3) 总结？回复 1/2/3。",
    },
  };
}

async function callDoubaoIntent({ text, contextSummary, timeoutMs }) {
  const apiKey = envOptional("DOUBAO_API_KEY");
  const baseUrl = envOptional("DOUBAO_BASE_URL") ?? "https://ark.cn-beijing.volces.com/api/v3";
  const endpointId = envOptional("DOUBAO_ENDPOINT_ID");
  if (!apiKey || !endpointId) {
    throw new Error("missing DOUBAO_API_KEY or DOUBAO_ENDPOINT_ID");
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const system = [
      "你是一个意图理解器（IntentAgent）。",
      "请仅输出严格 JSON（不要代码块，不要多余解释）。",
      "根据用户输入与上下文，判断 task_type 与 target_artifacts。",
      '输出 schema: {"task_type":"doc|slides|summary|unknown","confidence":0-1,"target_artifacts":["doc"|"slides"],"based_on_doc_url":"","need_clarify":true|false,"clarify_question":""}',
      "规则：",
      "- 用户要求PPT/演示稿/汇报 -> task_type=slides，target_artifacts默认仅slides",
      "- 用户明确要求需求文档/文档整理 -> task_type=doc",
      "- 用户要求总结/结论/提炼 -> task_type=summary",
      "- 若用户说“文档+PPT”，target_artifacts为[\"doc\",\"slides\"]",
      "- 若用户提供docx链接或说“基于文档生成PPT”，based_on_doc_url填该链接，target_artifacts仅slides",
      "- 若无法确定，task_type=unknown，need_clarify=true，并给出clarify_question（让用户选1文档2PPT3总结）。",
    ].join("\n");

    const user = [
      `用户输入：${String(text || "").trim()}`,
      `上下文摘要：${String(contextSummary || "").trim()}`,
    ].join("\n");

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
        temperature: 0,
      }),
      signal: controller.signal,
    });

    const raw = await resp.text();
    if (!resp.ok) throw new Error(raw || `doubao http ${resp.status}`);

    // Volc Ark chat.completions is OpenAI-like: { choices:[{message:{content}}] }
    const parsed = JSON.parse(raw);
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("doubao returned empty content");
    return content.trim();
  } finally {
    clearTimeout(t);
  }
}

function parseIntentJson(s) {
  const text = String(s || "").trim();
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error("no json object found");
  const body = text.slice(jsonStart, jsonEnd + 1);
  const obj = JSON.parse(body);

  const taskType = normalizeTaskType(obj.task_type);
  const confidence = clamp01(Number(obj.confidence ?? 0));
  const artifactsRaw = Array.isArray(obj.target_artifacts) ? obj.target_artifacts : [];
  const targetArtifacts = artifactsRaw
    .map((x) => normalizeTaskType(x))
    .filter((x) => x === "doc" || x === "slides");
  const uniq = Array.from(new Set(targetArtifacts));
  const basedOnDocUrl = typeof obj.based_on_doc_url === "string" ? obj.based_on_doc_url.trim() : "";
  const needClarify = obj.need_clarify === true || taskType === "unknown" || confidence < 0.65;
  const clarifyQuestion =
    typeof obj.clarify_question === "string" && obj.clarify_question.trim()
      ? obj.clarify_question.trim()
      : "我没完全理解你的需求。你想生成：1) 需求文档 2) 演示稿PPT 3) 总结？回复 1/2/3。";

  const finalArtifacts = uniq.length > 0 ? uniq : taskType === "slides" ? ["slides"] : taskType === "summary" ? ["doc"] : ["doc"];
  return {
    intent: { name: taskType, confidence },
    slots: {
      targetArtifacts: finalArtifacts,
      basedOnDocUrl: basedOnDocUrl || extractDocUrl(text),
      contextRange: { mode: "recent_messages", limit: 20 },
      needClarify,
      clarifyQuestion,
    },
  };
}

async function analyzeIntent({ text, contextSummary }) {
  const timeoutMs = Number(envOptional("INTENT_TIMEOUT_MS") ?? "6000");
  const threshold = Number(envOptional("INTENT_CONFIDENCE_THRESHOLD") ?? "0.65");

  // If no Doubao config, go stub directly.
  const hasDoubao = Boolean(envOptional("DOUBAO_API_KEY") && envOptional("DOUBAO_ENDPOINT_ID"));
  if (!hasDoubao) {
    const stub = parseIntentStub({ input: text });
    const mapped = mapStubToIntentResult(stub);
    return { ...mapped, threshold };
  }

  try {
    const content = await callDoubaoIntent({ text, contextSummary, timeoutMs });
    const parsed = parseIntentJson(content);
    const needClarify = parsed.slots.needClarify === true || parsed.intent.confidence < threshold || parsed.intent.name === "unknown";
    return { source: "doubao", ...parsed, threshold, slots: { ...parsed.slots, needClarify } };
  } catch {
    const stub = parseIntentStub({ input: text });
    const mapped = mapStubToIntentResult(stub);
    return { ...mapped, threshold };
  }
}

module.exports = { analyzeIntent };

