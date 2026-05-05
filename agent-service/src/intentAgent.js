const { parseIntent, normalizeIntentOutput } = require("./intentParser");
const { callChatCompletions } = require("./llmChat");

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

function readSlowThresholdForApi() {
  const slow = Number(envOptional("INTENT_SLOW_THRESHOLD") ?? "0.6");
  return Number.isFinite(slow) ? Math.min(1, Math.max(0, slow)) : 0.6;
}

function extractDocUrl(text) {
  const m = String(text || "").match(/https?:\/\/[^\s]+\/docx\/[A-Za-z0-9]+/);
  return m ? m[0] : "";
}

function extractSlidesUrl(text) {
  const m = String(text || "").match(/https?:\/\/[^\s]+\/slides\/[A-Za-z0-9]+/);
  return m ? m[0] : "";
}

function extractSlidesPageIndex(text) {
  const s = String(text || "");
  const m1 = s.match(/第\s*(\d{1,3})\s*页/);
  const m2 = s.match(/页码\s*(\d{1,3})/);
  const m3 = s.match(/\bpage\s*(\d{1,3})\b/i);
  const raw = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]) || "";
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const idx = Math.max(1, Math.min(200, Math.floor(n)));
  return idx;
}

function mapParsedIntentToWorkflow(parsed) {
  const normalized = normalizeIntentOutput(parsed);
  const taskType = normalized.output_type === "ppt" ? "slides" : "doc";
  const targetArtifacts = normalized.output_type === "ppt" ? ["slides"] : ["doc"];
  return {
    intent: { name: taskType, confidence: clamp01(Number(normalized.confidence ?? 0)) },
    slots: {
      targetArtifacts,
      basedOnDocUrl: "",
      basedOnSlidesUrl: "",
      slidesEditPageIndex: null,
      contextRange: { mode: "recent_messages", limit: 20 },
      needClarify: false,
      clarifyQuestion: "我没完全理解你的需求。你想生成：1) 需求文档 2) 演示稿PPT 3) 总结？回复 1/2/3。",
      parseIntentV2: normalized,
    },
  };
}

async function callLlmIntent({ text, contextSummary, structuredContext, recentMessages, rulePreview, timeoutMs }) {
  const structured = String(structuredContext ?? contextSummary ?? "").trim();
  const summary = String(contextSummary ?? "").trim();
  const recentJoined = Array.isArray(recentMessages) ? recentMessages.map((s) => String(s).trim()).filter(Boolean).join(" | ") : "";

  const system = [
    "你是一个意图理解器（IntentAgent）。",
    "请仅输出严格 JSON（不要代码块，不要多余解释）。",
    "请先判断场景，再判断输出类型与子类型。",
    '输出 schema: {"output_type":"doc|ppt","doc_type":"prd|meeting_summary|solution|report|brainstorm","ppt_type":"review|report|proposal","scenario":"discussion|review|handoff|brainstorm","confidence":0-1,"reasoning":""}',
    "规则：",
    "- 先做 scenario 分类，再推导 output_type 与 doc_type/ppt_type",
    "- 若无法判断，必须回退 output_type=doc 且 doc_type=meeting_summary",
    "- 输出必须稳定，不要输出随机描述，reasoning 控制在1-2句",
  ].join("\n");

  const user = [
    `用户输入：${String(text || "").trim()}`,
    `结构化上下文：${structured}`,
    `上下文摘要：${summary}`,
    `最近消息（rerank 后 Top-K，全量）：${recentJoined}`,
    `规则预判：${JSON.stringify(rulePreview || {})}`,
  ].join("\n");

  return callChatCompletions({ system, user, temperature: 0, timeoutMs, purpose: "intent" });
}

function parseIntentJson(s) {
  const text = String(s || "").trim();
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error("no json object found");
  const body = text.slice(jsonStart, jsonEnd + 1);
  const obj = JSON.parse(body);

  return normalizeIntentOutput(obj);
}

async function resolveIntent({ text, contextSummary, recentMessages, structuredContext }) {
  const timeoutMs = Number(envOptional("INTENT_TIMEOUT_MS") ?? "6000");
  const slowThreshold = readSlowThresholdForApi();
  const thresholds = { fast: 0.8, slow: slowThreshold };

  const ruleParsed = parseIntent(text, { contextSummary, recentMessages });
  const mappedRule = mapParsedIntentToWorkflow(ruleParsed);
  const slotExtras = {
    basedOnDocUrl: extractDocUrl(text),
    basedOnSlidesUrl: extractSlidesUrl(text),
    slidesEditPageIndex: extractSlidesPageIndex(text),
  };

  const hasShortcut = ruleParsed?.meta?.explicitTypeHit === true;
  const hasAnyLlm = Boolean(envOptional("DOUBAO_API_KEY") || envOptional("DEEPSEEK_API_KEY"));

  if (hasShortcut) {
    return {
      source: "rule_shortcut",
      decisionPath: "rule_shortcut",
      parseIntentV2: normalizeIntentOutput(ruleParsed),
      ...mappedRule,
      thresholds,
      slots: {
        ...mappedRule.slots,
        ...slotExtras,
        needClarify: false,
      },
    };
  }

  if (!hasAnyLlm) {
    return {
      source: "rule_no_llm",
      decisionPath: "rule_no_llm",
      parseIntentV2: normalizeIntentOutput(ruleParsed),
      ...mappedRule,
      thresholds,
      slots: {
        ...mappedRule.slots,
        ...slotExtras,
        needClarify: true,
      },
    };
  }

  try {
    const content = await callLlmIntent({
      text,
      contextSummary,
      structuredContext,
      recentMessages,
      rulePreview: ruleParsed,
      timeoutMs,
    });
    const llmParsed = parseIntentJson(content);
    const llmMapped = mapParsedIntentToWorkflow(llmParsed);
    const llmConfidence = clamp01(Number(llmMapped.intent.confidence ?? 0));
    const needClarify = llmConfidence < slowThreshold;
    return {
      source: "llm",
      decisionPath: "llm",
      parseIntentV2: normalizeIntentOutput(llmParsed),
      ...llmMapped,
      thresholds,
      slots: {
        ...llmMapped.slots,
        ...slotExtras,
        needClarify,
      },
    };
  } catch {
    return {
      source: "rule_fallback",
      decisionPath: "rule_fallback",
      parseIntentV2: normalizeIntentOutput(ruleParsed),
      ...mappedRule,
      thresholds,
      slots: {
        ...mappedRule.slots,
        ...slotExtras,
        needClarify: true,
      },
    };
  }
}

async function analyzeIntent(args) {
  return resolveIntent(args);
}

module.exports = { analyzeIntent, resolveIntent };
