const { callChatCompletions } = require("./llmChat");
const { parseEditIntent: defaultParseEditIntent } = require("./editIntentParser");
const { editInstructionText } = require("./editIntentSource");
const { UPDATE_BLOCK, DELETE_BLOCK, INSERT_BLOCK, toBlockOp } = require("./editBlockOps");

function envOptional(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function parseBoolEnv(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!s) return null;
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return null;
}

function hasLlmConfigured() {
  const hasDoubao = Boolean(envOptional("DOUBAO_API_KEY") && envOptional("DOUBAO_ENDPOINT_ID"));
  const hasDeepSeek = Boolean(envOptional("DEEPSEEK_API_KEY"));
  return hasDoubao || hasDeepSeek;
}

function readEditIntentLlmEnabled() {
  const explicit = parseBoolEnv(envOptional("EDIT_INTENT_LLM_ENABLED"));
  if (explicit !== null) return explicit;
  return hasLlmConfigured();
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function truncate(s, maxLen) {
  const t = String(s || "");
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen);
}

function normalizeOperation(op) {
  return toBlockOp(op);
}

function parseOptionalPageIndex(v, maxPage) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const idx = Math.floor(n);
  if (idx < 1 || idx > maxPage) return null;
  return idx;
}

function parseOptionalBulletIndex(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const idx = Math.floor(n);
  if (idx < 1 || idx > 20) return null;
  return idx;
}

function parseJsonObjectFromLlmContent(s) {
  const text = String(s || "").trim();
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error("no json object found");
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
}

/**
 * 将 LLM JSON 规范为与 parseEditIntent 一致的输出；不合法时抛错由上层回落规则。
 */
function mapLlmJsonToEditIntent(raw) {
  const isEditFlag = Boolean(raw.is_edit ?? raw.isEdit);
  if (!isEditFlag) {
    return {
      isEdit: false,
      target: "doc",
      operation: UPDATE_BLOCK,
      selector: {},
      payload: {},
      confidence: 0,
      needsConfirm: false,
      reason: "no_edit_pattern",
    };
  }

  const tRaw = String(raw.target || "").toLowerCase().trim();
  if (tRaw !== "doc" && tRaw !== "slides") throw new Error("invalid target");
  const target = tRaw;

  const opRaw = String(raw.operation || "").trim();
  if (!opRaw) throw new Error("operation is required");
  const operation = normalizeOperation(opRaw);
  const selIn = raw.selector && typeof raw.selector === "object" ? raw.selector : {};
  const payIn = raw.payload && typeof raw.payload === "object" ? raw.payload : {};

  const anchorText = truncate(String(selIn.anchor_text ?? selIn.anchorText ?? "").trim(), 2000);
  const pageIndex = parseOptionalPageIndex(selIn.page_index ?? selIn.pageIndex, 200);
  const bulletIndex = parseOptionalBulletIndex(selIn.bullet_index ?? selIn.bulletIndex);
  let lastPage = Boolean(selIn.last_page ?? selIn.lastPage);
  if (pageIndex != null) lastPage = false;

  const from = truncate(String(payIn.from ?? "").trim(), 1200);
  const to = truncate(String(payIn.to ?? "").trim(), 2400);
  const content = truncate(String(payIn.content ?? "").trim(), 5000);
  const title = truncate(String(payIn.title ?? "").trim(), 500);

  let selector = {};
  let payload = {};

  if (target === "slides") {
    selector = { pageIndex, bulletIndex, lastPage };
    if (operation === UPDATE_BLOCK) {
      payload = { from, to, title: title || to || "" };
    } else if (operation === INSERT_BLOCK) {
      payload = { title: title || "", content };
    } else {
      payload = { title: title || "" };
    }
  } else if (operation === INSERT_BLOCK) {
    selector = { anchorText };
    payload = { content };
  } else if (operation === DELETE_BLOCK) {
    selector = { anchorText };
    payload = { content: "" };
  } else {
    const anchor = anchorText || from;
    selector = { anchorText: anchor };
    payload = { content: to || content, from: anchor || from, to: to || content };
  }

  let confidence = clamp01(Number(raw.confidence ?? 0.75));
  confidence = Math.max(0, Math.min(0.98, confidence));

  const ncRaw = raw.needs_confirm ?? raw.needsConfirm;
  const needsConfirm = typeof ncRaw === "boolean" ? ncRaw : false;

  return {
    isEdit: true,
    target,
    operation,
    selector,
    payload,
    confidence,
    needsConfirm,
    reason: "edit_instruction_matched",
  };
}

async function resolveEditIntentWithLlm({ instructionText, intent }) {
  const timeoutMs = Math.max(
    2000,
    Math.min(60_000, Number(envOptional("EDIT_INTENT_TIMEOUT_MS") ?? "8000") || 8000),
  );

  const system = [
    "你是飞书云文档(docx)与演示文稿(slides)的编辑意图解析器。只输出一个 JSON 对象，不要 Markdown 代码块，不要多余解释。",
    "仅根据「本轮用户指令」（可含附带的 doc/slides 链接行），不要依据对话历史摘要或他人待办推断要改什么。",
    "",
    "输出 schema（字段必须齐全；无数值时用 null；无字符串时用空字符串）：",
    '{',
    '  "is_edit": boolean,',
    '  "target": "doc" | "slides",',
    '  "operation": "UPDATE_BLOCK" | "DELETE_BLOCK" | "INSERT_BLOCK",',
    '  "selector": {',
    '    "anchor_text": string,',
    '    "page_index": number | null,',
    '    "last_page": boolean,',
    '    "bullet_index": number | null',
    "  },",
    '  "payload": {',
    '    "from": string,',
    '    "to": string,',
    '    "content": string,',
    '    "title": string,',
    '    "max_bullets": number | null',
    "  },",
    '  "confidence": number,',
    '  "needs_confirm": boolean,',
    '  "reasoning": string',
    "}",
    "",
    "规则：",
    "- 若用户只是在闲聊、要我新建全文、总结但无修改指令：is_edit=false，其余字段可填空/默认值。",
    "- target=slides：页码用 page_index（从 1 开始）或 last_page=true 表示最后一页；INSERT_BLOCK 表示在该页后新增一页。",
    "- target=doc：三类操作都必须基于 block（用 anchor_text 供后续定位 block_id）。",
    "- UPDATE_BLOCK 优先填 payload.to / payload.content；DELETE_BLOCK 无需 payload；INSERT_BLOCK 需 payload.content（slides 可附 payload.title）。",
    "- confidence 取 0~1，表示你对解析的确信程度。",
    "- needs_confirm：是否需要在执行前由用户再确认；未给出时按 false。",
  ].join("\n");

  const coarse =
    intent && typeof intent === "object"
      ? `粗意图参考 output_type=${String(intent.output_type || "")} doc_type=${String(intent.doc_type || "")}`
      : "";

  const user = [`本轮用户指令：`, truncate(instructionText, 12000), coarse].filter(Boolean).join("\n\n");

  const content = await callChatCompletions({
    system,
    user,
    temperature: 0,
    timeoutMs,
    purpose: "edit_intent",
  });

  const raw = parseJsonObjectFromLlmContent(content);
  return mapLlmJsonToEditIntent(raw);
}

/**
 * LLM 优先；失败或未启用时回落规则 parseEditIntent（仅指令句 + 显式 target，与 slides 页码解析对齐）。
 * @returns {{ editIntent: object, source: 'llm'|'rule'|'llm_invalid' }}
 */
async function resolveEditIntentHybrid(input, deps = {}) {
  const parseEditIntentFn = typeof deps.parseEditIntent === "function" ? deps.parseEditIntent : defaultParseEditIntent;
  const intent = deps.intent;
  const instructionText = editInstructionText(input);

  const fallback = () => {
    const out = parseEditIntentFn(instructionText, { intent });
    if (!out || typeof out !== "object") return out;
    return { ...out, operation: toBlockOp(out.operation) };
  };

  if (!String(instructionText || "").trim()) {
    return { editIntent: fallback(), source: "rule" };
  }

  if (!readEditIntentLlmEnabled()) {
    return { editIntent: fallback(), source: "rule" };
  }

  try {
    if (!hasLlmConfigured()) {
      return { editIntent: fallback(), source: "rule" };
    }
    const llmIntent = await resolveEditIntentWithLlm({ instructionText, intent });
    llmIntent.reason = "edit_intent_llm";
    return { editIntent: llmIntent, source: "llm" };
  } catch {
    return { editIntent: fallback(), source: "llm_invalid" };
  }
}

module.exports = {
  resolveEditIntentHybrid,
  readEditIntentLlmEnabled,
  mapLlmJsonToEditIntent,
};
