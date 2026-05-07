const { artifactEvent, errorEvent, stateEvent, stepEvent } = require("./taskEvents");
const { confirmRequiredEvent } = require("./taskEvents");
const { generateContentBundle } = require("./contentAgent");
const { generateSlidesXmlArray } = require("./contentAgent");
const { resolveDocTemplate, resolveSlidesTemplate } = require("./intentTemplates");
const { buildTaskCompletedFeedback, publishFeedbackEvent: defaultPublishFeedbackEvent } = require("./feedback");
const { readContentConfidenceMin, aggregateContentConfidence } = require("./contentConfidenceGate");
const { runReflectJob: defaultRunReflectJob } = require("./reflectJob");
const { parseEditIntent: defaultParseEditIntent } = require("./editIntentParser");
const { mergeEditIntentSource, editInstructionText } = require("./editIntentSource");
const { resolveEditIntentHybrid: defaultResolveEditIntent } = require("./editIntentAgent");
const { buildEditPlan: defaultBuildEditPlan, buildEditPreview } = require("./editPlanner");
const { UPDATE_BLOCK, DELETE_BLOCK, INSERT_BLOCK, toBlockOp } = require("./editBlockOps");
const {
  findBlockIdForAnchorText,
  parseDocsUpdateSuccess,
} = require("./docBlockResolve");
const { ruleBasedPlan } = require("./plannerAgent");

function sleep(ms) {
  const n = Number(ms);
  const delay = Number.isFinite(n) && n > 0 ? Math.min(n, 30_000) : 0;
  return delay ? new Promise((r) => setTimeout(r, delay)) : Promise.resolve();
}

/** 文档 block 编辑：fetch/update 超时（可通过环境变量覆盖，单位 ms） */
function readDocEditCliTimeouts() {
  const kw = Number(process.env.DOC_FETCH_KEYWORD_TIMEOUT_MS);
  const full = Number(process.env.DOC_FETCH_FULL_TIMEOUT_MS);
  const upd = Number(process.env.DOC_BLOCK_UPDATE_TIMEOUT_MS);
  return {
    keywordFetchMs: Number.isFinite(kw) && kw >= 8000 ? Math.min(kw, 120_000) : 45_000,
    fullFetchMs: Number.isFinite(full) && full >= 15_000 ? Math.min(full, 300_000) : 120_000,
    blockUpdateMs: Number.isFinite(upd) && upd >= 8000 ? Math.min(upd, 180_000) : 90_000,
  };
}

function readReflectingPhaseMs() {
  const raw = process.env.REFLECTING_PHASE_MS;
  if (raw == null || String(raw).trim() === "") return 250;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(10_000, Math.max(0, Math.floor(n))) : 250;
}

function makeStep(stepId, label) {
  return { stepId, label, status: "pending" };
}

function safeText(value, max = 240) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function summarizeForTrace(key, value) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return { len: 0, preview: "" };
  // Large inputs make notes unreadable; only keep length.
  if (key === "raw_messages" || key === "source_text") {
    return { len: s.length, preview: "" };
  }
  // Keep very short preview for readability.
  const preview = safeText(s.replace(/\s+/g, " "), 80);
  return { len: s.length, preview };
}

function extractTaskFromStep(stepId, taskDefsByStepId) {
  if (!stepId || !taskDefsByStepId || typeof taskDefsByStepId.get !== "function") return null;
  return taskDefsByStepId.get(stepId) || null;
}

function buildTaskInputMap({ taskDef, runtime, taskOutputsByField }) {
  const outputType = runtime?.intent?.output_type || "doc";
  const entries = Array.isArray(taskDef?.input_contract) ? taskDef.input_contract : [];
  const out = {};
  for (const key of entries) {
    if (key === "raw_messages" || key === "source_text") out[key] = runtime?.inputText || "";
    else if (key === "context_summary") out[key] = runtime?.contextSummary || "";
    else if (key === "ppt_type") out[key] = runtime?.intent?.ppt_type || "report";
    else if (key === "scenario") out[key] = runtime?.intent?.scenario || "discussion";
    else if (key === "output_type") out[key] = outputType;
    else out[key] = taskOutputsByField[key] || "";
  }
  return out;
}

function pickOutputSourceByTaskName(taskName, bundle, runtime) {
  const b = bundle || {};
  const name = String(taskName || "");
  if (name.includes("risk")) return b.clarifyMd || b.requirementsMd || b.summaryMd || "";
  if (name.includes("requirement") || name.includes("scope") || name.includes("milestone")) return b.requirementsMd || b.outlineMd || "";
  if (name.includes("outline") || name.includes("slide")) return b.outlineMd || b.summaryMd || "";
  if (name.includes("goal") || name.includes("background") || name.includes("problem") || name.includes("solution") || name.includes("architecture")) {
    return b.summaryMd || b.requirementsMd || "";
  }
  if (name.includes("action") || name.includes("decision") || name.includes("key_points")) return b.summaryMd || b.clarifyMd || "";
  return b.summaryMd || runtime?.inputText || "";
}

function buildTaskOutputMap({ taskDef, bundle, runtime }) {
  const outputs = {};
  const source = pickOutputSourceByTaskName(taskDef?.name, bundle, runtime);
  const outputKeys = Array.isArray(taskDef?.output_contract) ? taskDef.output_contract : [];
  for (const key of outputKeys) {
    outputs[key] = source;
  }
  return outputs;
}

function renderTaskTraceArtifact({ taskDef, stepId, inputs, outputs }) {
  const depends = Array.isArray(taskDef?.depends_on) ? taskDef.depends_on : [];
  const scopes = Array.isArray(taskDef?.extract_scope) ? taskDef.extract_scope : [];

  const inputLines = Object.entries(inputs || {}).map(([k, v]) => {
    const { len, preview } = summarizeForTrace(k, v);
    const suffix = preview ? `，预览：${preview}` : "";
    return `- ${k}（len=${len}）${suffix}`;
  });
  const outputLines = Object.entries(outputs || {}).map(([k, v]) => {
    const { len, preview } = summarizeForTrace(k, v);
    const suffix = preview ? `，预览：${preview}` : "";
    return `- ${k}（len=${len}）${suffix}`;
  });
  const title = [
    `DAG任务：${taskDef?.name || stepId}`,
    depends.length ? `依赖：${depends.join(",")}` : "依赖：无",
    scopes.length ? `Scope：${scopes.join(",")}` : "Scope：无",
    "",
    "输入：",
    inputLines.length ? inputLines.join("\n") : "- （无）",
    "",
    "输出：",
    outputLines.length ? outputLines.join("\n") : "- （无）",
  ].join("\n");
  return {
    artifactId: `dag_task_${Date.now()}_${String(stepId || "").slice(-18)}`,
    kind: "note",
    title,
    url: "",
  };
}

function pickDocUrl(result) {
  if (!result || typeof result !== "object") return null;
  const stack = [result];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    for (const [k, v] of Object.entries(cur)) {
      if (typeof v === "string") {
        const key = k.toLowerCase();
        if ((key.includes("url") || key.includes("link")) && /^https?:\/\//.test(v)) return v;
      } else if (v && typeof v === "object") {
        stack.push(v);
      }
    }
  }
  return null;
}

function pickDocsCreateUrl(parsedValue) {
  // Prefer explicit known shapes from lark-cli docs +create output.
  const v = parsedValue && typeof parsedValue === "object" ? parsedValue : null;
  const urlCandidates = [
    v?.data?.document?.url,
    v?.document?.url,
    v?.result?.data?.document?.url,
    v?.data?.url,
    v?.url,
  ];
  for (const c of urlCandidates) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) return c;
  }
  return pickDocUrl(v);
}

function pickDocUrlFromText(stdout) {
  const s = String(stdout || "");
  // Feishu docx link shape: /docx/<token>
  const m = s.match(/https?:\/\/[^\s"']+\/docx\/[A-Za-z0-9]+/);
  return m ? m[0] : "";
}

function pickDocTargetFromInput(text) {
  const s = String(text || "");
  const urlMatch = s.match(/https?:\/\/[^\s"']+\/docx\/[A-Za-z0-9]+/);
  if (urlMatch) return urlMatch[0];
  const tokenMatch = s.match(/(?:^|[^A-Za-z0-9])docx\/([A-Za-z0-9]+)(?:$|[^A-Za-z0-9])/);
  if (tokenMatch && tokenMatch[1]) return tokenMatch[1];
  return "";
}

/** 合并主输入、上下文、最近消息与调用方显式 docTarget，定位要更新的飞书文档 */
function resolveDocTarget(input) {
  if (!input || typeof input !== "object") return "";
  const explicit = typeof input.docTarget === "string" ? input.docTarget.trim() : "";
  if (explicit) {
    const fromExplicit = pickDocTargetFromInput(explicit);
    if (fromExplicit) return fromExplicit;
  }
  const chunks = [
    input.input,
    input.contextSummary,
    Array.isArray(input.recentMessages) ? input.recentMessages.map((x) => String(x || "").trim()).filter(Boolean).join("\n") : "",
  ];
  for (const c of chunks) {
    const hit = pickDocTargetFromInput(String(c || ""));
    if (hit) return hit;
  }
  return "";
}

/** 编辑定位：仅用本轮指令句（及显式 doc/slides 目标），不用上下文摘要 */
function slidesLocatorText(input) {
  return editInstructionText(input);
}

/** 合并主输入、上下文、最近消息与调用方显式 slidesTarget，定位要编辑的演示文稿 */
function resolveSlidesTarget(input) {
  if (!input || typeof input !== "object") return "";
  const explicit = typeof input.slidesTarget === "string" ? input.slidesTarget.trim() : "";
  if (explicit) {
    const hit = pickSlidesTargetFromInput(explicit);
    if (hit) return hit;
  }
  const chunks = [
    input.input,
    input.contextSummary,
    Array.isArray(input.recentMessages) ? input.recentMessages.map((x) => String(x || "").trim()).filter(Boolean).join("\n") : "",
  ];
  for (const c of chunks) {
    const hit = pickSlidesTargetFromInput(String(c || ""));
    if (hit) return hit;
  }
  return "";
}

function pickSlidesUrlFromCliOutput(stdout) {
  const s = String(stdout || "");
  // Prefer explicit slides links if present.
  const m = s.match(/https?:\/\/[^\s"']+\/slides\/[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

function pickSlidesCreateUrl(parsedValue) {
  const v = parsedValue && typeof parsedValue === "object" ? parsedValue : null;
  const candidates = [
    v?.data?.slide?.url,
    v?.data?.slides?.url,
    v?.data?.url,
    v?.slide?.url,
    v?.slides?.url,
    v?.url,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) return c;
  }
  return pickDocUrl(v);
}

function normalizeErrorMessage(msg) {
  const s = String(msg || "").trim();
  if (!s) return "未知错误";
  if (s.includes("�")) {
    return "命令执行失败（错误信息编码异常，可能是超时或权限问题，请稍后重试）";
  }
  return s;
}

function shouldFallbackToEmptySlides(err) {
  const s = String(err && err.message ? err.message : err || "")
    .toLowerCase()
    .trim();
  if (!s) return false;
  // Only fallback on explicit XML parsing/validation errors.
  return s.includes("此时不应有 <") || s.includes("unexpected token <") || s.includes("xml");
}

function extractSlidesTokenFromUrl(url) {
  const s = String(url || "").trim();
  const m = s.match(/\/slides\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : "";
}

/**
 * lark-cli：before_slide_id 必须与 slide 同级放在 --data body 里；写进 --params 会被静默忽略，新页会始终追加到末尾。
 * @see https://github.com/larksuite/cli/blob/main/skills/lark-slides/SKILL.md
 */
function buildXmlPresentationSlideCreateStdin({ contentXml, beforeSlideId }) {
  const body = { slide: { content: String(contentXml || "") } };
  const before = String(beforeSlideId || "").trim();
  if (before) body.before_slide_id = before;
  return JSON.stringify(body);
}

function makeSlidesPageCreateArgs({ as, xmlPresentationId, dryRun }) {
  const identity = as === "bot" ? "bot" : "user";
  const safeId = String(xmlPresentationId || "").trim();
  const params = { xml_presentation_id: safeId };
  const args = ["slides", "xml_presentation.slide", "create", "--as", identity, "--params", JSON.stringify(params), "--data", "-"];
  // xml_presentation.slide.create is marked as high-risk-write; require explicit yes when executing.
  args.push("--yes");
  if (dryRun !== false) args.push("--dry-run");
  return args;
}

function pickSlidesTargetFromInput(text) {
  const s = String(text || "");
  const urlMatch = s.match(/https?:\/\/[^\s"']+\/slides\/[A-Za-z0-9_-]+/);
  if (urlMatch) return urlMatch[0];
  const tokenMatch = s.match(/(?:^|[^A-Za-z0-9])slides\/([A-Za-z0-9_-]+)(?:$|[^A-Za-z0-9_-])/);
  if (tokenMatch && tokenMatch[1]) return tokenMatch[1];
  return "";
}

function pickSlidesPageIndexFromInput(text) {
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

/** 是否在指令中说「最后一页」（页码需在拉取 slide 列表后解析为 slideIds.length）。 */
function wantsSlidesLastPageFromInput(text) {
  return /最后\s*一\s*页|最后一页(?:幻灯)?|最后一页ppt/i.test(String(text || ""));
}

function extractSlideContentXmlFromGetStdout(stdout, tryParseJson) {
  const p =
    typeof tryParseJson === "function"
      ? tryParseJson(String(stdout || ""))
      : { ok: false, value: null };
  if (!p.ok) return "";
  const v = p.value;
  const c = v?.data?.slide?.content ?? v?.slide?.content ?? v?.data?.content;
  return typeof c === "string" ? c : "";
}

/** 生成 xml_presentation.slide replace 的 stdin JSON（parts）；无可替换片段时返回空串。 */
function buildSlideReplaceStdin(from, to) {
  const f = String(from || "").trim();
  const t = String(to || "").trim();
  if (!f || !t) return "";
  return JSON.stringify({
    comment: "agent-slide-edit",
    parts: [{ action: "str_replace", pattern: f, replacement: t, is_multiple: false }],
  });
}

function stripXmlTags(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectTitleFromSlideXml(xml) {
  const x = String(xml || "");
  if (!x) return "";
  const m = x.match(/<shape\b[^>]*type=["']title["'][^>]*>[\s\S]*?<text>([\s\S]*?)<\/text>/i);
  if (m && m[1]) {
    const t = stripXmlTags(m[1]);
    if (t) return t;
  }
  const m2 = x.match(/<text>([\s\S]*?)<\/text>/i);
  return m2 && m2[1] ? stripXmlTags(m2[1]) : "";
}

function buildSlideUpdateRequest({ editPlan, slideXml }) {
  const op = toBlockOp(editPlan?.operation || UPDATE_BLOCK);
  if (op !== UPDATE_BLOCK) return { stdin: "", reason: "non_update_op" };
  const pay = editPlan?.payload && typeof editPlan.payload === "object" ? editPlan.payload : {};
  const from = String(pay.from || "").trim();
  const to = String(pay.to || pay.content || "").trim();
  if (from && to) return { stdin: buildSlideReplaceStdin(from, to), reason: "explicit_from_to" };
  const title = String(pay.title || "").trim();
  if (title && slideXml) {
    const oldTitle = detectTitleFromSlideXml(slideXml);
    if (oldTitle && oldTitle !== title) {
      return { stdin: buildSlideReplaceStdin(oldTitle, title), reason: "derive_title_from_xml" };
    }
  }
  return { stdin: "", reason: "missing_pattern" };
}

function parseSlideReplaceSucceeded(stdout, tryParseJson) {
  const raw = String(stdout || "");
  const t = raw.trim();
  // 空输出不视为成功：不少 CLI 在未匹配 pattern / 未写入时仍 exit 0 且无输出，若误判成功会跳过整页 delete+create，表现为「原稿完全未改」。
  if (!t) return false;
  const p = typeof tryParseJson === "function" ? tryParseJson(raw) : { ok: false, value: null };
  if (!p.ok) return false;
  const v = p.value;
  const reason = v?.failed_reason ?? v?.data?.failed_reason ?? "";
  if (reason) return false;
  // 仅有「可解析 JSON」不够：{} 或任意无显式成功字段的响应仍应走整页重建，否则会误判「元素级已成功」而完全不写。
  if (!v || typeof v !== "object") return false;
  if (v.ok === true || v.success === true) return true;
  if (Number(v.code) === 0) return true;
  if (Number(v?.data?.code) === 0) return true;
  return false;
}

/** 优先使用 API 返回的 slides 数组顺序；随意 DFS 收集 slide_id 会导致页序错乱，「最后一页」会指错页 */
function extractOrderedSlideIdsFromPresentationJson(root) {
  if (!root || typeof root !== "object") return null;
  const candidates = [
    root?.data?.slides,
    root?.data?.slide_list,
    root?.data?.xml_presentation?.slides,
    root?.data?.xml_presentation?.slide_list,
    root?.slides,
    root?.result?.slides,
  ];
  for (const arr of candidates) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const ids = [];
    for (const item of arr) {
      if (typeof item === "string") {
        const t = item.trim();
        if (t) ids.push(t);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const id = item.slide_id ?? item.slideId ?? item.id;
      const t = String(id || "").trim();
      if (t) ids.push(t);
    }
    if (ids.length > 0) return ids;
  }
  return null;
}

/**
 * xml_presentations.get 常把整册结构放在 data.xml_presentation.content 等大段 XML 字符串里，而非 JSON 数组。
 * 按 <slide ...> 出现顺序抽取 slide_id / id。
 */
function extractSlideIdsFromSlideXmlString(xml) {
  const s = String(xml || "");
  if (!s || !/<\s*slide\b/i.test(s)) return [];
  const ids = [];
  const seen = new Set();
  const push = (id) => {
    const t = String(id || "").trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    ids.push(t);
  };
  const slideOpenRe = /<\s*slide\b[^>]*>/gi;
  let m;
  while ((m = slideOpenRe.exec(s))) {
    const tag = m[0];
    let idm = /\bslide_id\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!idm) idm = /\bslideId\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!idm) idm = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (idm) push(idm[1]);
  }
  if (ids.length > 0) return ids;
  const loose = /\bslide_id\s*=\s*["']([A-Za-z0-9_-]+)["']/gi;
  let m2;
  while ((m2 = loose.exec(s))) push(m2[1]);
  return ids;
}

/** 从 xml_presentations get 的 JSON 根对象中解析 slide_id 列表（含嵌入 XML）。 */
function extractSlideIdsFromPresentationPayload(root) {
  if (!root || typeof root !== "object") return [];
  const fromArr = extractOrderedSlideIdsFromPresentationJson(root);
  if (fromArr && fromArr.length > 0) return fromArr;

  const xmlCandidates = [
    root?.data?.xml_presentation?.content,
    root?.data?.xml_presentation?.xml,
    typeof root?.data?.xml_presentation === "string" ? root.data.xml_presentation : null,
    root?.data?.content,
    root?.data?.presentation?.content,
    root?.data?.pptx?.content,
  ];
  for (const x of xmlCandidates) {
    if (typeof x === "string" && x.length > 0) {
      const ids = extractSlideIdsFromSlideXmlString(x);
      if (ids.length > 0) return ids;
    }
  }

  const data = root?.data;
  if (data && typeof data === "object") {
    for (const v of Object.values(data)) {
      if (typeof v === "string" && v.length > 80 && /<\s*slide\b/i.test(v)) {
        const ids = extractSlideIdsFromSlideXmlString(v);
        if (ids.length > 0) return ids;
      }
    }
  }
  return [];
}

function extractSlideIdsFromCliOutput(stdout, tryParseJson) {
  const s = String(stdout || "");
  const parsed = typeof tryParseJson === "function" ? tryParseJson(s) : { ok: false, value: null };
  const ids = [];
  const seen = new Set();
  const push = (id) => {
    const t = String(id || "").trim();
    if (!t) return;
    if (seen.has(t)) return;
    seen.add(t);
    ids.push(t);
  };

  if (parsed.ok && parsed.value) {
    const fromPayload = extractSlideIdsFromPresentationPayload(parsed.value);
    if (fromPayload.length > 0) return fromPayload;
  }

  // 纯 XML stdout（无 JSON 包装）
  if (!parsed.ok && /<\s*slide\b/i.test(s)) {
    const fromXmlOnly = extractSlideIdsFromSlideXmlString(s);
    if (fromXmlOnly.length > 0) return fromXmlOnly;
  }

  const scanObject = (root) => {
    const stack = [root];
    const visited = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (visited.has(cur)) continue;
      visited.add(cur);
      if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
        continue;
      }
      for (const [k, v] of Object.entries(cur)) {
        const key = String(k || "").toLowerCase();
        if (typeof v === "string" && (key === "slide_id" || key === "slideid")) push(v);
        else if (v && typeof v === "object") stack.push(v);
      }
    }
  };

  if (parsed.ok && parsed.value) scanObject(parsed.value);

  // Fallback to regex扫描整段 stdout（兼容非标准 JSON / 调试输出）
  const re = /(?:slide_id|slideId)\s*[:=]\s*["']([A-Za-z0-9_-]{4,})["']/g;
  let m;
  while ((m = re.exec(s))) push(m[1]);

  return ids;
}

function escapeXmlText(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSimpleSlideXml({ title, bullets }) {
  const safeTitle = escapeXmlText(title || "更新页");
  const lines = Array.isArray(bullets) ? bullets : [];
  const lis = lines.map((x) => `<li><p>${escapeXmlText(x)}</p></li>`).join("");
  const bodyInner = lis ? `<ul>${lis}</ul>` : "<p>（暂无）</p>";
  return [
    '<slide xmlns="http://www.larkoffice.com/sml/2.0">',
    '<style><fill><fillColor color="rgb(248,250,252)"/></fill></style>',
    "<data>",
    '<shape type="text" topLeftX="80" topLeftY="80" width="800" height="120">',
    "<content textType=\"title\"><p>",
    safeTitle,
    "</p></content>",
    "</shape>",
    '<shape type="text" topLeftX="80" topLeftY="220" width="800" height="360">',
    '<content textType="body">',
    bodyInner,
    "</content>",
    "</shape>",
    "</data>",
    "</slide>",
  ].join("");
}

/**
 * 细粒度文档编辑：仅允许 block 级 UPDATE/DELETE/INSERT。
 */
async function runFineDocLarkUpdate({
  editPlan,
  bodyMd,
  docTarget,
  buildDocsUpdateArgs,
  buildDocsFetchArgs,
  runLarkCliWithRetry,
  tryParseJson,
  as,
  dryRun,
}) {
  const op = toBlockOp(editPlan?.operation || UPDATE_BLOCK);
  const sel = editPlan?.selector && typeof editPlan.selector === "object" ? editPlan.selector : {};
  const pay = editPlan?.payload && typeof editPlan.payload === "object" ? editPlan.payload : {};
  const anchor = String(sel.anchorText || pay.from || "").trim();
  const insHint = String(pay.content || pay.to || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 72);
  // 短锚点（如「待确认问题」）单独做 keyword 易命中错误片段；拼接拟写入前缀提高检索召回。
  const keyword =
    anchor.length > 0 && anchor.length < 40 && insHint
      ? `${anchor} ${insHint}`.trim().slice(0, 200)
      : anchor.slice(0, 200) || insHint.slice(0, 120);
  if (!anchor) {
    throw new Error(
      "文档编辑未提供可定位锚点：仅支持基于 block 的 UPDATE/DELETE/INSERT。请提供能唯一定位段落的原文片段。",
    );
  }
  if (typeof buildDocsFetchArgs !== "function") {
    throw new Error("服务端未注入 docs +fetch 能力，无法定位 block_id。");
  }

  const { keywordFetchMs, fullFetchMs, blockUpdateMs } = readDocEditCliTimeouts();

  const runUpdate = async (opts, stdin) =>
    runLarkCliWithRetry(buildDocsUpdateArgs(opts), {
      timeoutMs: blockUpdateMs,
      ...(typeof stdin === "string" ? { stdin } : {}),
    });

  const baseOpts = {
    as,
    doc: docTarget,
    apiVersion: "v2",
    dryRun,
  };

  const okStdout = async (resp) => (parseDocsUpdateSuccess(resp.stdout, tryParseJson) ? resp.stdout : null);
  // lark-cli：--detail with-ids 仅与 --doc-format xml 兼容；markdown 无 block id，会校验失败。
  const fetchKeywordArgs = buildDocsFetchArgs({
    as,
    doc: docTarget,
    apiVersion: "v2",
    detail: "with-ids",
    scope: "keyword",
    keyword: keyword || anchor,
    docFormat: "xml",
    // read-only fetch 在 dry-run 下部分 CLI 版本会返回精简结果，导致 block_id 丢失。
    // 定位阶段一律真实读取；真正写入仍遵循 execution.dryRun。
    dryRun: false,
    // 扩大 keyword 命中片段的前后块，减少「检索窗口偏一刀」导致锚点落在窗外
    contextBefore: 5,
    contextAfter: 5,
  });
  let fetchResp = await runLarkCliWithRetry(fetchKeywordArgs, { timeoutMs: keywordFetchMs });
  let blockId = findBlockIdForAnchorText(fetchResp.stdout, anchor || keyword, tryParseJson);
  // keyword 片段有时不包含锚点所在 block（检索窗口偏移）；再拉全文定位。
  if (!blockId) {
    const fetchFullArgs = buildDocsFetchArgs({
      as,
      doc: docTarget,
      apiVersion: "v2",
      detail: "with-ids",
      scope: "full",
      docFormat: "xml",
      dryRun: false,
    });
    fetchResp = await runLarkCliWithRetry(fetchFullArgs, { timeoutMs: fullFetchMs });
    blockId = findBlockIdForAnchorText(fetchResp.stdout, anchor || keyword, tryParseJson);
  }
  if (!blockId) {
    throw new Error(
      "未能定位 block_id：请从正文复制「锚点所在那一行的完整文字」（含中英文标点与弯引号）；短标题（如「待确认问题」）请改用下方某一整条列表原文作为锚点，或在该标题后加一句独有上下文再试。",
    );
  }

  if (op === DELETE_BLOCK) {
    const resp = await runUpdate(
      {
        ...baseOpts,
        command: "block_delete",
        blockId,
        markdown: "",
      },
      undefined,
    );
    const good = await okStdout(resp);
    if (!good) throw new Error("block_delete 未生效：请确认锚点对应 block 仍存在并且有编辑权限。");
    return { stdout: good, mode: "block_delete", fetchRan: true, blockId, fallback: false };
  }

  if (op === INSERT_BLOCK) {
    const ins = String(pay.content || "").trim();
    if (!ins) throw new Error("INSERT_BLOCK 缺少 payload.content，无法插入 block。");
    const resp = await runUpdate(
      {
        ...baseOpts,
        command: "block_insert_after",
        blockId,
        markdown: ins,
        docFormat: "markdown",
      },
      ins,
    );
    const good = await okStdout(resp);
    if (!good) throw new Error("block_insert_after 未生效：请确认 block_id 与文档权限。");
    return { stdout: good, mode: "block_insert_after", fetchRan: true, blockId, fallback: false };
  }

  const repl = String(pay.to || pay.content || bodyMd).trim();
  if (!repl) throw new Error("UPDATE_BLOCK 缺少新内容（payload.to 或 payload.content）。");
  const resp = await runUpdate(
    {
      ...baseOpts,
      command: "block_replace",
      blockId,
      markdown: repl,
      docFormat: "markdown",
    },
    repl,
  );
  const good = await okStdout(resp);
  if (!good) throw new Error("block_replace 未生效：请确认 block_id 与替换内容格式。");
  return { stdout: good, mode: "block_replace", fetchRan: true, blockId, fallback: false };
}

function buildDocEditMarkdown(plan, fallbackBody) {
  const op = toBlockOp(plan?.operation || UPDATE_BLOCK);
  const selector = plan?.selector || {};
  const payload = plan?.payload || {};
  if (op === DELETE_BLOCK) {
    return ["## 定向删除", "", `- 删除目标：${String(selector.anchorText || "（自动定位）")}`, "", "> 已按指令执行删除。"].join("\n");
  }
  if (op === INSERT_BLOCK) {
    return ["## 定向插入", "", `- 插入位置：${String(selector.anchorText || "（自动定位）")}`, "", String(payload.content || fallbackBody || "（暂无）")].join(
      "\n",
    );
  }
  return [
    "## 定向替换",
    "",
    `- 原文锚点：${String(selector.anchorText || payload.from || "（自动定位）")}`,
    `- 新内容：${String(payload.content || payload.to || fallbackBody || "（暂无）")}`,
  ].join("\n");
}

function shouldRetryCliError(err) {
  const s = String(err && err.message ? err.message : err || "").toLowerCase();
  return s.includes("timeout") || s.includes("timed out") || s.includes("econnreset") || s.includes("socket hang up") || s.includes("temporarily unavailable");
}

function parseEditShortCircuitEnabled() {
  const v = process.env.EDIT_SHORT_CIRCUIT_ENABLED;
  if (v == null || String(v).trim() === "") return true;
  const s = String(v).trim().toLowerCase();
  return !(s === "0" || s === "false" || s === "off" || s === "no");
}

/**
 * 编辑短路：已识别编辑意图且输入里能解析到对应 docx/slides 目标时，跳过全量 generateContentBundle（无 LLM）。
 */
function shouldUseEditShortCircuit({ editPlan, input, wantsDoc, wantsSlides }) {
  if (!parseEditShortCircuitEnabled()) return false;
  if (!editPlan?.isEdit) return false;
  const docTarget = resolveDocTarget(input);
  const slidesTarget = resolveSlidesTarget(input);
  const docOk = editPlan.target === "doc" && Boolean(docTarget) && wantsDoc;
  const slidesOk = editPlan.target === "slides" && Boolean(slidesTarget) && wantsSlides;
  if (wantsDoc && wantsSlides) return docOk && slidesOk;
  if (wantsDoc) return docOk;
  if (wantsSlides) return slidesOk;
  return false;
}

/**
 * 编辑短路时任务面板应展示真实执行路径，避免仍显示「生成大纲 → 新建整稿」等误导性步骤。
 */
function buildMinimalEditWorkflowSteps({ editPlan, wantsDoc, wantsSlides, dryRun }) {
  const writeRisk = dryRun === false && (wantsDoc || wantsSlides);
  const steps = [
    {
      stepId: "step_risk_guard",
      label: "风险检查与确认（精细编辑）",
      status: "pending",
      kind: "guard",
      tool: undefined,
      requiresConfirm: writeRisk,
    },
  ];
  if (editPlan?.target === "doc" && wantsDoc) {
    steps.push({
      stepId: "step_create_doc",
      label: "更新云文档（按块编辑）",
      status: "pending",
      kind: "tool",
      tool: "docs.update",
      requiresConfirm: false,
    });
  }
  if (editPlan?.target === "slides" && wantsSlides) {
    steps.push({
      stepId: "step_create_slides",
      label: "更新演示文稿（按页编辑）",
      status: "pending",
      kind: "tool",
      tool: "slides.xml_edit",
      requiresConfirm: false,
    });
  }
  steps.push({
    stepId: "step_send_delivery_message",
    label: "回 IM 交付链接",
    status: "pending",
    kind: "tool",
    tool: "im.messages_send",
    requiresConfirm: false,
  });
  return steps;
}

function buildMinimalEditContentBundle({ editPlan, wantsDoc, wantsSlides }) {
  const bundle = {
    source: "edit_short_circuit",
    confidence: 0.95,
    summaryMd: "",
    requirementsMd: "",
    clarifyMd: "",
    outlineMd: "",
    rewrittenMd: "",
    restructuredMd: "",
    docOutlineMd: "",
    pptOutlineLines: [],
    cleaned: { facts: [], decisions: [], actions: [], openQuestions: [], constraints: [], risks: [] },
    evidencePoolMd: "",
  };
  if (wantsDoc && editPlan.target === "doc") {
    bundle.rewrittenMd = buildDocEditMarkdown(editPlan, "");
    bundle.rewrittenConfidence = 0.95;
  }
  if (wantsSlides && editPlan.target === "slides") {
    const p = editPlan.payload || {};
    const bullets = [];
    if (p.to) bullets.push(String(p.to));
    if (p.content) bullets.push(String(p.content));
    if (typeof p.maxBullets === "number") {
      const n = Math.max(1, Math.min(8, Math.floor(p.maxBullets)));
      while (bullets.length < n) bullets.push(`要点 ${bullets.length + 1}`);
    }
    if (bullets.length === 0) bullets.push("已按指令更新本页内容");
    bundle.rewrittenSlidesPlan = {
      confidence: 0.95,
      slides: [{ title: String(p.title || p.to || "编辑页"), bullets: bullets.slice(0, 8) }],
    };
    bundle.rewrittenSlidesConfidence = 0.95;
  }
  return bundle;
}

function explicitPptMention(text) {
  const t = String(text || "");
  if (/(不要|不需要|别(做|搞|生成)?|不是).{0,6}(ppt|幻灯片|演示稿|slides|deck)/i.test(t)) return false;
  return /(ppt|演示稿|幻灯片|slides|deck)/i.test(t);
}

/**
 * 编辑场景：收窄目标产物，避免「只改文档」却误配 doc+slides（例如入口默认绑了双产物）。
 * 1) 输入里仅一类链接 → 只保留对应 artifact；
 * 2) 细粒度文档编辑且未提及演示稿、非多目标并列句 → 去掉误配的 slides。
 */
function applyLinkedEditTargetArtifacts(input, { parseIntent, parseEditIntent }) {
  if (!input || typeof input.input !== "string") return;
  const artifacts = input.targetArtifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) return;
  const instructionOnly = editInstructionText(input);
  const intent = parseIntent(input.input, {
    contextSummary: input.contextSummary || "",
    recentMessages: Array.isArray(input.recentMessages) ? input.recentMessages : [],
  });
  const editIntent = parseEditIntent(instructionOnly, { intent });
  if (!editIntent.isEdit) return;
  const docT = resolveDocTarget(input);
  const slidesT = resolveSlidesTarget(input);
  if (docT && !slidesT) {
    input.targetArtifacts = ["doc"];
    return;
  }
  if (slidesT && !docT) {
    input.targetArtifacts = ["slides"];
    return;
  }
  const norm = artifacts.map((x) => String(x || "").toLowerCase().trim());
  const wantsDoc = norm.includes("doc");
  const wantsSlides = norm.includes("slides") || norm.includes("ppt");
  if (
    wantsDoc &&
    wantsSlides &&
    editIntent.target === "doc" &&
    !explicitPptMention(instructionOnly) &&
    !/(并且|同时|另外再|以及|然后再)/.test(instructionOnly)
  ) {
    input.targetArtifacts = ["doc"];
  }
}

class AgentOrchestrator {
  constructor(deps) {
    this.parseIntent = deps.parseIntent;
    this.planWorkflow = deps.planWorkflow;
    this.generateContentBundle = deps.generateContentBundle || generateContentBundle;
    this.buildDocsCreateArgs = deps.buildDocsCreateArgs;
    this.buildDocsUpdateArgs = deps.buildDocsUpdateArgs;
    this.buildDocsFetchArgs = deps.buildDocsFetchArgs;
    this.buildSlidesCreateArgs = deps.buildSlidesCreateArgs;
    this.buildSlidesXmlPresentationsGetArgs = deps.buildSlidesXmlPresentationsGetArgs;
    this.buildSlidesXmlPresentationSlideDeleteArgs = deps.buildSlidesXmlPresentationSlideDeleteArgs;
    this.buildSlidesXmlPresentationSlideGetArgs = deps.buildSlidesXmlPresentationSlideGetArgs;
    this.buildSlidesXmlPresentationSlideReplaceArgs = deps.buildSlidesXmlPresentationSlideReplaceArgs;
    this.buildImMessagesSendArgs = deps.buildImMessagesSendArgs;
    this.runLarkCli = deps.runLarkCli;
    this.parseEditIntent = deps.parseEditIntent || defaultParseEditIntent;
    this.resolveEditIntent = deps.resolveEditIntent || defaultResolveEditIntent;
    this.buildEditPlan = deps.buildEditPlan || defaultBuildEditPlan;
    this.tryParseJson = deps.tryParseJson;
    this.taskStore = deps.taskStore;
    this.publishTaskEvent = deps.publishTaskEvent;
    this.publishFeedbackEvent = deps.publishFeedbackEvent || defaultPublishFeedbackEvent;
    this.runReflectJob = deps.runReflectJob || defaultRunReflectJob;
  }

  async runLarkCliWithRetry(args, options = {}, maxAttempts = 2) {
    let lastErr = null;
    const attempts = Math.max(1, Number(maxAttempts) || 1);
    for (let i = 1; i <= attempts; i += 1) {
      try {
        return await this.runLarkCli(args, options);
      } catch (e) {
        lastErr = e;
        if (i >= attempts || !shouldRetryCliError(e)) throw e;
        await sleep(250 * i);
      }
    }
    throw lastErr || new Error("runLarkCliWithRetry failed");
  }

  async emit(event) {
    await this.publishTaskEvent(event);
  }

  async emitTaskCompletedFeedback({ taskId, input, capturedIntent, capturedTemplate, startedAt }) {
    if (typeof this.publishFeedbackEvent !== "function") return;
    try {
      const finalTask = this.taskStore.get(taskId);
      if (!finalTask) return;
      const intentMeta = {
        ...(capturedIntent && typeof capturedIntent === "object" ? capturedIntent : {}),
        ...(input && input.intentMeta && typeof input.intentMeta === "object" ? input.intentMeta : {}),
      };
      const event = buildTaskCompletedFeedback({
        task: finalTask,
        input: input || {},
        intentMeta,
        templateInfo: capturedTemplate || {},
        startedAt,
      });
      await this.publishFeedbackEvent(event);
    } catch {
      // never block main flow on feedback failures
    }
  }

  updateStep(task, stepId, status) {
    const nextSteps = task.steps.map((s) => (s.stepId === stepId ? { ...s, status } : s));
    return this.taskStore.update(task.taskId, { steps: nextSteps, currentStepId: status === "running" ? stepId : task.currentStepId });
  }

  async startWorkflow(input) {
    applyLinkedEditTargetArtifacts(input, {
      parseIntent: this.parseIntent,
      parseEditIntent: this.parseEditIntent,
    });
    const taskId = input.taskId;
    const now = Date.now();
    const wantsDoc = Array.isArray(input.targetArtifacts) && input.targetArtifacts.includes("doc");
    const wantsSlides = Array.isArray(input.targetArtifacts) && input.targetArtifacts.includes("slides");
    const task = this.taskStore.create({
      taskId,
      conversationId: input.conversationId,
      state: "detecting",
      currentStepId: null,
      steps: [
        makeStep("step_extract_intent", "提取意图"),
        // planning 阶段会用 Planner 输出的 steps 替换这部分列表；这里先给一个最小占位，保证任务面板可见。
        makeStep("step_planning", "生成执行计划"),
        ...(wantsDoc ? [makeStep("step_create_doc", "创建文档")] : []),
        ...(wantsSlides ? [makeStep("step_create_slides", "创建演示稿")] : []),
        makeStep("step_send_delivery_message", "回 IM 交付"),
      ],
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      lastError: null,
    });

    await this.emit(stateEvent(taskId, "detecting"));
    void this.runWorkflow(taskId, input);
    return task;
  }

  async runWorkflow(taskId, input) {
    let task = this.taskStore.get(taskId);
    if (!task) return;
    const startedAt = Date.now();
    let capturedIntent = null;
    let capturedTemplate = null;
    try {
      if (this.taskStore.isCancelled(taskId)) {
        this.taskStore.update(taskId, { state: "cancelled", currentStepId: null });
        await this.emit(stateEvent(taskId, "cancelled"));
        await this.emitTaskCompletedFeedback({ taskId, input, capturedIntent, capturedTemplate, startedAt });
        return;
      }
      task = this.taskStore.update(taskId, { state: "intent" });
      await this.emit(stateEvent(taskId, "intent"));

      task = this.updateStep(task, "step_extract_intent", "running");
      await this.emit(stepEvent(taskId, task.steps.find((s) => s.stepId === "step_extract_intent")));
      const intent = this.parseIntent(input.input, {
        contextSummary: input.contextSummary || "",
        recentMessages: Array.isArray(input.recentMessages) ? input.recentMessages : [],
      });
      const { editIntent, source: editIntentSource } = await this.resolveEditIntent(input, {
        intent,
        parseEditIntent: this.parseEditIntent,
      });
      const editPlan = this.buildEditPlan({ input: input.input, editIntent, intent });
      capturedIntent = intent;
      task = this.updateStep(task, "step_extract_intent", "completed");
      await this.emit(stepEvent(taskId, task.steps.find((s) => s.stepId === "step_extract_intent")));

      const wantsDocEarly = Array.isArray(input.targetArtifacts) && input.targetArtifacts.includes("doc");
      const wantsSlidesEarly = Array.isArray(input.targetArtifacts) && input.targetArtifacts.includes("slides");
      const execDryRunEarly = input.execution?.dryRun ?? true;
      const useMinimalEditSteps =
        Boolean(editPlan?.isEdit) &&
        shouldUseEditShortCircuit({
          editPlan,
          input,
          wantsDoc: wantsDocEarly,
          wantsSlides: wantsSlidesEarly,
        });

      task = this.taskStore.update(taskId, { state: "planning" });
      await this.emit(stateEvent(taskId, "planning"));

      // 编辑短路：跳过 Planner LLM（省一次对话延迟）；否则仍走 planWorkflow（常为豆包规划）。
      const planned =
        !this.planWorkflow
          ? null
          : useMinimalEditSteps
            ? ruleBasedPlan({ targetArtifacts: input.targetArtifacts || [], dryRun: execDryRunEarly })
            : await this.planWorkflow({
                text: input.input,
                contextSummary: input.contextSummary || "",
                intent,
                targetArtifacts: input.targetArtifacts,
                execution: input.execution || {},
              });

      const existingExtract = task.steps.find((s) => s.stepId === "step_extract_intent") || makeStep("step_extract_intent", "提取意图");
      const plannedSteps = Array.isArray(planned?.steps) ? planned.steps : [];
      let plannedTasks = Array.isArray(planned?.tasks) ? planned.tasks : [];
      let taskPlanMeta = planned?.taskPlanMeta && typeof planned.taskPlanMeta === "object" ? { ...planned.taskPlanMeta } : {};
      const normalizedPlannedSteps = plannedSteps
        .map((s) => (s && typeof s === "object" ? { stepId: s.stepId, label: s.label, status: "pending", kind: s.kind, tool: s.tool, requiresConfirm: s.requiresConfirm } : null))
        .filter(Boolean);

      const stepsForUi = useMinimalEditSteps
        ? buildMinimalEditWorkflowSteps({
            editPlan,
            wantsDoc: wantsDocEarly,
            wantsSlides: wantsSlidesEarly,
            dryRun: execDryRunEarly,
          })
        : normalizedPlannedSteps;

      if (useMinimalEditSteps) {
        plannedTasks = [];
        taskPlanMeta = { ...taskPlanMeta, edit_short_circuit: true };
      }

      // Keep extract_intent as completed + inject planned steps right after.
      const nextSteps = [
        { ...existingExtract, status: "completed" },
        ...stepsForUi.map((s) => ({ ...s })),
      ];
      task = this.taskStore.update(taskId, {
        steps: nextSteps,
        currentStepId: null,
        taskPlan: {
          tasks: plannedTasks,
          meta: taskPlanMeta,
        },
      });

      // Emit pending steps so GUI can render the whole plan immediately.
      for (const s of stepsForUi) {
        await this.emit(stepEvent(taskId, { stepId: s.stepId, label: s.label, status: "pending" }));
      }

      // Optional confirm gate: only when planner says so OR any step requests confirmation.
      // Defer confirm gate to step_risk_guard for better observability (step status reflects waiting).
      const planNeedsConfirm =
        (!useMinimalEditSteps && planned?.risks?.needsConfirm === true) || stepsForUi.some((s) => s.requiresConfirm === true);
      const planReason =
        typeof planned?.risks?.reason === "string" && planned.risks.reason.trim()
          ? planned.risks.reason.trim()
          : "该任务包含写操作。为避免误操作，请先确认再执行。";
      const editNeedsConfirm = Boolean(editPlan?.isEdit && editPlan?.needsConfirm);
      const editReason = editNeedsConfirm
        ? `检测到细粒度编辑请求（target=${editPlan.target} operation=${editPlan.operation} confidence=${editPlan.confidence.toFixed(2)}），为避免误改，请确认后继续。`
        : "";
      const preNeedsConfirm = planNeedsConfirm || editNeedsConfirm;
      const preReason = [planReason, editReason].filter(Boolean).join("\n");
      input.confirmGate = preNeedsConfirm ? { needed: true, reason: preReason, stepId: "step_risk_guard" } : { needed: false, reason: "", stepId: "" };

      task = this.taskStore.update(taskId, { state: "executing" });
      await this.emit(stateEvent(taskId, "executing"));

      const wantsDoc = Array.isArray(input.targetArtifacts) && input.targetArtifacts.includes("doc");
      const wantsSlides = Array.isArray(input.targetArtifacts) && input.targetArtifacts.includes("slides");
      const execDryRun = input.execution?.dryRun ?? true;
      const execIdentity = input.execution?.defaultIdentity ?? "user";
      const taskDefsByStepId = new Map(
        plannedTasks
          .filter((t) => t && typeof t === "object" && typeof t.name === "string")
          .map((t) => [`step_${t.name}`, t]),
      );
      const completedTaskIds = new Set();
      const taskOutputsByField = {};
      const runtimeForTasks = {
        inputText: input.input,
        contextSummary: input.contextSummary || "",
        intent,
      };

      let docUrl = "";
      let contentBundle = null;
      let emittedContentArtifact = false;
      let contentPreviewOnly = false;
      let emittedConfidenceGateNote = false;
      if (editPlan?.isEdit) {
        console.info(
          JSON.stringify({
            type: "workflow.edit_plan",
            taskId,
            target: editPlan.target,
            operation: editPlan.operation,
            confidence: Number(editPlan.confidence || 0),
            needsConfirm: Boolean(editPlan.needsConfirm),
            maxChanges: Number(editPlan.maxChanges || 1),
            edit_intent_source: typeof editIntentSource === "string" ? editIntentSource : "rule",
          }),
        );
        const preview = {
          artifactId: `note_edit_preview_${Date.now()}`,
          kind: "note",
          title: `编辑预览\n\n${buildEditPreview(editPlan)}`,
          url: "",
        };
        task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, preview] });
        await this.emit(artifactEvent(taskId, preview));
      }
      const ensureBundle = async () => {
        if (contentBundle) return contentBundle;
        const useEditShort = shouldUseEditShortCircuit({
          editPlan,
          input,
          wantsDoc,
          wantsSlides,
        });
        if (useEditShort) {
          contentBundle = buildMinimalEditContentBundle({ editPlan, wantsDoc, wantsSlides });
          const minConf = readContentConfidenceMin();
          if (minConf != null) {
            const agg = aggregateContentConfidence(contentBundle, wantsSlides);
            if (agg < minConf) {
              contentPreviewOnly = true;
              if (!emittedConfidenceGateNote) {
                emittedConfidenceGateNote = true;
                const thr = String(minConf);
                const gateNote = {
                  artifactId: `note_conf_gate_${Date.now()}`,
                  kind: "note",
                  title:
                    `提示：内容综合置信度低于阈值（CONTENT_CONFIDENCE_MIN=${thr}），本次仅保留「规划产物」预览，已跳过飞书文档/演示稿写入与 IM 交付消息。`,
                  url: "",
                };
                task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, gateNote] });
                await this.emit(artifactEvent(taskId, gateNote));
              }
            }
          }
          if (!emittedContentArtifact) {
            emittedContentArtifact = true;
            const patchBody = String(contentBundle.rewrittenMd || "").trim() || "（演示稿编辑：已生成最小页计划）";
            const shortNote = {
              artifactId: `note_${Date.now()}`,
              kind: "note",
              title: `编辑短路（未调用全量 LLM）\n\n${patchBody}`,
              url: "",
            };
            task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, shortNote] });
            await this.emit(artifactEvent(taskId, shortNote));
          }
          return contentBundle;
        }

        contentBundle = await this.generateContentBundle({
          text: input.input,
          contextSummary: input.contextSummary || "",
          targetArtifacts: input.targetArtifacts || [],
          intent,
          experienceContext: {
            conversationId: input.conversationId || "",
          },
        });

        const minConf = readContentConfidenceMin();
        if (minConf != null) {
          const agg = aggregateContentConfidence(contentBundle, wantsSlides);
          if (agg < minConf) {
            contentPreviewOnly = true;
            if (!emittedConfidenceGateNote) {
              emittedConfidenceGateNote = true;
              const thr = String(minConf);
              const gateNote = {
                artifactId: `note_conf_gate_${Date.now()}`,
                kind: "note",
                title:
                  `提示：内容综合置信度低于阈值（CONTENT_CONFIDENCE_MIN=${thr}），本次仅保留「规划产物」预览，已跳过飞书文档/演示稿写入与 IM 交付消息。`,
                url: "",
              };
              task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, gateNote] });
              await this.emit(artifactEvent(taskId, gateNote));
            }
          }
        }

        // Emit a human-readable artifact so the frontend can show intermediate results
        // without requiring users to open the generated doc.
        if (!emittedContentArtifact) {
          emittedContentArtifact = true;
          const safe = (s, max) => {
            const t = String(s || "").trim();
            if (!t) return "";
            if (t.length <= max) return t;
            return `${t.slice(0, max - 3)}...`;
          };
          const structured = safe(contentBundle.rewrittenMd || contentBundle.restructuredMd, 2600);
          const summary = safe(contentBundle.summaryMd, 1200);
          const reqs = safe(contentBundle.requirementsMd, 1200);
          const clarify = safe(contentBundle.clarifyMd, 900);
          const outline = safe(contentBundle.docOutlineMd || contentBundle.outlineMd, 900);
          // UX: prefer a single structured preview; avoid repeating legacy sections unless needed.
          const body = structured || [summary, reqs, clarify, outline].filter(Boolean).join("\n\n");
          const artifact = {
            artifactId: `note_${Date.now()}`,
            kind: "note",
            title: body ? `规划产物（预览）\n\n${body}` : "规划产物（预览）",
            url: "",
          };
          task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, artifact] });
          await this.emit(artifactEvent(taskId, artifact));
        }

        return contentBundle;
      };

      // Execute planned steps in order (skip extract_intent which is already completed).
      for (const s of task.steps) {
        if (!s || s.stepId === "step_extract_intent") continue;
        if (this.taskStore.isCancelled(taskId)) throw new Error("task cancelled");

        task = this.updateStep(task, s.stepId, "running");
        await this.emit(stepEvent(taskId, task.steps.find((x) => x.stepId === s.stepId)));

        const taskDef = extractTaskFromStep(s.stepId, taskDefsByStepId);
        if (taskDef) {
          const deps = Array.isArray(taskDef.depends_on) ? taskDef.depends_on : [];
          const unsatisfied = deps.filter((depId) => !completedTaskIds.has(depId));
          if (unsatisfied.length > 0) {
            throw new Error(`dag dependency not satisfied: ${taskDef.name} <- ${unsatisfied.join(",")}`);
          }
          const b = await ensureBundle();
          const taskInputs = buildTaskInputMap({ taskDef, runtime: runtimeForTasks, taskOutputsByField });
          const taskOutputs = buildTaskOutputMap({ taskDef, bundle: b, runtime: runtimeForTasks });
          for (const [k, v] of Object.entries(taskOutputs)) taskOutputsByField[k] = v;
          completedTaskIds.add(taskDef.id);

          const traceArtifact = renderTaskTraceArtifact({
            taskDef,
            stepId: s.stepId,
            inputs: taskInputs,
            outputs: taskOutputs,
          });
          task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, traceArtifact] });
          await this.emit(artifactEvent(taskId, traceArtifact));
        } else if (s.stepId === "step_risk_guard") {
          const gate = input.confirmGate && input.confirmGate.needed ? input.confirmGate : null;
          const dryRunNow = input.execution?.dryRun !== false;
          if (gate && gate.needed && dryRunNow === false) {
            const waitConfirmNote = {
              artifactId: `note_confirm_gate_${Date.now()}`,
              kind: "note",
              title:
                "【尚未写入飞书】当前为真实写操作，任务在安全确认处暂停。\n\n" +
                "请在本页左侧（窄屏为上方）黄色「需要确认」卡片中点击「确认执行」，否则不会调用 lark-cli、演示稿/文档不会被删除或修改。\n\n" +
                "若看不到按钮：请确认已连接实时任务进度（Realtime），或刷新后重试。",
              url: "",
            };
            task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, waitConfirmNote] });
            await this.emit(artifactEvent(taskId, waitConfirmNote));
            await this.emit(
              confirmRequiredEvent(taskId, gate.stepId || "step_risk_guard", gate.reason || "需要确认后继续执行。", {
                approveEndpoint: "/api/agent/workflow/confirm",
                cancelEndpoint: "/api/agent/workflow/cancel",
              }),
            );
            const confirm = await this.taskStore.waitForConfirm(taskId, gate.stepId || "step_risk_guard");
            if (!confirm?.approved) {
              this.taskStore.update(taskId, { state: "cancelled", currentStepId: null });
              await this.emit(stateEvent(taskId, "cancelled"));
              await this.emitTaskCompletedFeedback({ taskId, input, capturedIntent, capturedTemplate, startedAt });
              return;
            }
            if (confirm.override) {
              input.execution = { ...(input.execution || {}), ...(confirm.override || {}) };
            }
          }
        } else if (s.stepId === "step_summarize_context" || s.stepId === "step_extract_requirements" || s.stepId === "step_identify_open_questions" || s.stepId === "step_make_outline") {
          await ensureBundle();
        } else if (s.stepId === "step_create_doc" && wantsDoc) {
          const b = await ensureBundle();
          if (!contentPreviewOnly) {
            const summaryMd = b?.summaryMd ? String(b.summaryMd).trim() : "";
            const requirementsMd = b?.requirementsMd ? String(b.requirementsMd).trim() : "";
            const clarifyMd = b?.clarifyMd ? String(b.clarifyMd).trim() : "";
            const outlineMd = b?.outlineMd ? String(b.outlineMd).trim() : "";
          const rewrittenMd = b?.rewrittenMd ? String(b.rewrittenMd).trim() : "";
          const docTpl = resolveDocTemplate(intent);
          capturedTemplate = {
            kind: "doc",
            title: docTpl.title,
            sectionsOrder: Array.isArray(docTpl.sectionsOrder) ? docTpl.sectionsOrder : [],
          };
            const fallbackBody = [summaryMd, requirementsMd, clarifyMd, outlineMd].filter(Boolean).join("\n\n").trim();
            const bodyMd = rewrittenMd || fallbackBody || "## 内容\n- （暂无）";
            const docMarkdown = ["# " + docTpl.h1, "", bodyMd].join("\n\n");
            const docTarget = resolveDocTarget(input);
            const canUpdate = Boolean(docTarget && typeof this.buildDocsUpdateArgs === "function");
            const useFineDocEdit = Boolean(editPlan?.isEdit && editPlan?.target === "doc" && canUpdate);

            if (editPlan?.isEdit && editPlan?.target === "doc" && !canUpdate) {
              throw new Error(
                "未解析到要编辑的飞书文档：请在本条或上下文中附上原文档 docx 链接（或 docx/token），或由调用方传入 docTarget；未定位到文档时不会新建文档，以免误产出。",
              );
            }

            if (canUpdate) {
              let docResp;
              if (useFineDocEdit) {
                const fine = await runFineDocLarkUpdate({
                  editPlan,
                  bodyMd,
                  docTarget,
                  buildDocsUpdateArgs: (opts) => this.buildDocsUpdateArgs(opts),
                  buildDocsFetchArgs: this.buildDocsFetchArgs,
                  runLarkCliWithRetry: (...args) => this.runLarkCliWithRetry(...args),
                  tryParseJson: this.tryParseJson,
                  as: input.execution?.docIdentity ?? input.execution?.defaultIdentity ?? execIdentity,
                  dryRun: input.execution?.dryRun ?? execDryRun,
                });
                docResp = { stdout: fine.stdout };
                const opNote = {
                  artifactId: `note_doc_edit_applied_${Date.now()}`,
                  kind: "note",
                  title: [
                    "云文档编辑记录",
                    `方式：${fine.mode}`,
                    "说明：已按 block 原子操作写入（UPDATE_BLOCK/DELETE_BLOCK/INSERT_BLOCK）。",
                    `keyword检索：${fine.fetchRan ? "已执行" : "未执行"}`,
                    `目标：${docTarget}`,
                  ].join("\n"),
                  url: "",
                };
                task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, opNote] });
                await this.emit(artifactEvent(taskId, opNote));
              } else {
                const updateMarkdown = [
                  "",
                  `## 本次更新（${new Date().toISOString().slice(0, 19).replace("T", " ")}）`,
                  "",
                  bodyMd,
                ].join("\n");
                const docArgs = this.buildDocsUpdateArgs({
                  as: input.execution?.docIdentity ?? input.execution?.defaultIdentity ?? execIdentity,
                  doc: docTarget,
                  apiVersion: "v2",
                  mode: "append",
                  markdown: updateMarkdown,
                  dryRun: input.execution?.dryRun ?? execDryRun,
                });
                docResp = await this.runLarkCliWithRetry(docArgs, { timeoutMs: 120_000, stdin: updateMarkdown }, 2);
              }
              const parsedDoc = this.tryParseJson(docResp.stdout);
              docUrl =
                pickDocsCreateUrl(parsedDoc.ok ? parsedDoc.value : null) ||
                pickDocUrlFromText(docResp.stdout) ||
                (docTarget.startsWith("http") ? docTarget : "");
            } else {
              const docArgs = this.buildDocsCreateArgs({
                as: input.execution?.docIdentity ?? input.execution?.defaultIdentity ?? execIdentity,
                title: docTpl.title,
                apiVersion: "v2",
                markdown: docMarkdown,
                dryRun: input.execution?.dryRun ?? execDryRun,
              });
              const docResp = await this.runLarkCliWithRetry(docArgs, { timeoutMs: 120_000, stdin: docMarkdown }, 2);
              const parsedDoc = this.tryParseJson(docResp.stdout);
              docUrl = pickDocsCreateUrl(parsedDoc.ok ? parsedDoc.value : null) || pickDocUrlFromText(docResp.stdout) || "";
            }
            const artifact = {
              artifactId: `doc_${Date.now()}`,
              kind: "doc",
              title: docTpl.title.replace("（Agent）", ""),
              url: docUrl,
            };
            task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, artifact] });
            await this.emit(artifactEvent(taskId, artifact));
          }
        } else if (s.stepId === "step_create_slides" && wantsSlides) {
          // 必须 await 真实错误：若 .catch(() => null) 会得到 b=null，随后 generateSlidesXmlArray 只报 misleading 的 missing rewrittenSlidesPlan
          const b = await ensureBundle();
          if (contentPreviewOnly) {
            // skip Feishu slides writes (preview-only gate)
          } else {
          const slidesTpl = resolveSlidesTemplate(intent);
          if (!capturedTemplate) {
            capturedTemplate = {
              kind: "slides",
              title: slidesTpl.deckTitle,
              sectionsOrder: Array.isArray(slidesTpl.sectionsOrder) ? slidesTpl.sectionsOrder : [],
            };
          }
          const slidesTitle = slidesTpl.deckTitle;
          let slidesXmlArray = generateSlidesXmlArray({ bundle: b, text: input.input, intent });
          const useFineSlidesEdit = Boolean(editPlan?.isEdit && editPlan?.target === "slides");
          if (useFineSlidesEdit) {
            const p = editPlan.payload || {};
            const bullets = [];
            if (p.to) bullets.push(String(p.to));
            if (p.content) bullets.push(String(p.content));
            if (typeof p.maxBullets === "number") {
              const firstSlide = Array.isArray(slidesXmlArray) && slidesXmlArray[0] ? String(slidesXmlArray[0]) : "";
              const defaultBullets = firstSlide
                .split(/<li>|<\/li>/)
                .map((x) => x.replace(/<[^>]+>/g, "").trim())
                .filter(Boolean)
                .slice(0, Math.max(1, Math.min(8, p.maxBullets)));
              bullets.push(...defaultBullets);
            }
            const custom = buildSimpleSlideXml({
              title: String(p.title || p.to || "更新页"),
              bullets: bullets.length ? bullets.slice(0, 8) : ["已按指令更新本页内容"],
            });
            slidesXmlArray = [custom];
          }
          const dryRunNow = input.execution?.dryRun ?? execDryRun;
          const locatorText = slidesLocatorText(input);
          const maybeSlidesTarget = resolveSlidesTarget(input);
          const blockOp = toBlockOp(editPlan?.operation || UPDATE_BLOCK);
          const sel = editPlan?.selector && typeof editPlan.selector === "object" ? editPlan.selector : {};
          const rawPageIdx = sel.pageIndex ?? sel.page_index;
          let pageFromPlan = null;
          if (rawPageIdx != null && rawPageIdx !== "") {
            const n = Number(rawPageIdx);
            if (Number.isFinite(n) && n >= 1) pageFromPlan = n;
          }
          const maybeSlidesPageIndex =
            pickSlidesPageIndexFromInput(locatorText) ?? pageFromPlan;
          const lastPageRequested =
            wantsSlidesLastPageFromInput(locatorText) || Boolean(sel.lastPage);
          const editSlidesToken =
            maybeSlidesTarget && String(maybeSlidesTarget).startsWith("http")
              ? extractSlidesTokenFromUrl(maybeSlidesTarget)
              : String(maybeSlidesTarget || "");
          const pureSlidesDelete = useFineSlidesEdit && editPlan?.target === "slides" && blockOp === DELETE_BLOCK;
          const pureSlidesInsert = useFineSlidesEdit && editPlan?.target === "slides" && blockOp === INSERT_BLOCK;

          if (useFineSlidesEdit && editPlan?.target === "slides" && !editSlidesToken) {
            throw new Error(
              "未解析到要编辑的飞书演示文稿：请在本条消息、上下文摘要或最近对话中附上 slides 完整链接（或 slides/<token>）。系统不会在未定位到原稿时新建空白演示稿。",
            );
          }

          if (
            useFineSlidesEdit &&
            editPlan?.target === "slides" &&
            Boolean(editSlidesToken) &&
            !(maybeSlidesPageIndex != null || lastPageRequested)
          ) {
            throw new Error(
              "已识别为编辑已有演示稿，但未解析到页码：请在指令中写明「第 N 页」或「最后一页」。未指定页码时系统不会新建空白演示稿以免误操作。",
            );
          }

          // 编辑模式必须在原稿上按 slide 操作，不允许回落到新建空稿。
          const canEditExistingSlides =
            Boolean(editSlidesToken) &&
            (maybeSlidesPageIndex != null || lastPageRequested) &&
            typeof this.buildSlidesXmlPresentationsGetArgs === "function" &&
            typeof this.buildSlidesXmlPresentationSlideDeleteArgs === "function";

          let usedFallbackEmptySlides = false;
          let slidesUrl = "";

          if (!canEditExistingSlides) {
            if (useFineSlidesEdit) {
              throw new Error("已识别为编辑已有演示稿，但缺少页码或 slides 编辑 CLI，系统已拒绝回落到新建空稿。");
            }
            let slidesArgs = this.buildSlidesCreateArgs({
              as: input.execution?.slidesIdentity ?? "user",
              title: slidesTitle,
              // Avoid pushing large slides JSON via CLI args on Windows.
              // Create deck first, then add pages via xml_presentation.slide.create (stdin).
              slidesXmlArray: [],
              dryRun: input.execution?.dryRun ?? execDryRun,
            });
            let slidesResp;
            try {
              slidesResp = await this.runLarkCliWithRetry(slidesArgs, { timeoutMs: 120_000 }, 2);
            } catch (e) {
              if (!shouldFallbackToEmptySlides(e)) throw e;
              // Some cli/server combinations reject inline slides XML. Fallback to empty deck creation.
              usedFallbackEmptySlides = true;
              slidesArgs = this.buildSlidesCreateArgs({
                as: input.execution?.slidesIdentity ?? "user",
                title: slidesTitle,
                slidesXmlArray: [],
                dryRun: input.execution?.dryRun ?? execDryRun,
              });
              slidesResp = await this.runLarkCliWithRetry(slidesArgs, { timeoutMs: 120_000 }, 2);
            }
            const parsedSlides = this.tryParseJson(slidesResp.stdout);
            slidesUrl =
              (parsedSlides.ok ? pickSlidesCreateUrl(parsedSlides.value) : null) || pickSlidesUrlFromCliOutput(slidesResp.stdout) || "";
          }

          let slidesResultUrl = "";

          // Edit mode: replace a specific page in an existing deck (whole-slide replace: delete + create).
          // 支持「第N页」与「最后一页」；纯删除某页时仅 delete，不再用生成稿整页补回。可在已有稿上编辑时不再先 xml_presentation.create。
          if (canEditExistingSlides) {
            if (dryRunNow && useFineSlidesEdit) {
              const dryNote = {
                artifactId: `note_slides_dry_${Date.now()}`,
                kind: "note",
                title:
                  "提示：当前 execution.dryRun=true，以下 xml_presentation 调用均带 --dry-run，飞书演示稿不会被真实修改。若要写入请在启动 workflow 时关闭 dryRun，并在网页上确认执行时带上 override.dryRun=false。",
                url: "",
              };
              task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, dryNote] });
              await this.emit(artifactEvent(taskId, dryNote));
            }
            // 只读接口不要带 --dry-run：多数 lark-cli 在 dry-run 下不返回真实 slides 列表，导致 slide_id 全空、整页编辑被跳过，却误报「新建稿未填充」类 NOTE。
            const getArgs = this.buildSlidesXmlPresentationsGetArgs({
              as: input.execution?.slidesIdentity ?? "user",
              xmlPresentationId: editSlidesToken,
              dryRun: false,
            });
            const getResp = await this.runLarkCliWithRetry(getArgs, { timeoutMs: 120_000 }, 2);
            const slideIds = extractSlideIdsFromCliOutput(getResp.stdout, this.tryParseJson);
            if (slideIds.length === 0) {
              console.warn(
                JSON.stringify({
                  type: "workflow.slides_get_no_ids",
                  taskId,
                  tokenLen: String(editSlidesToken || "").length,
                  stdoutLen: String(getResp.stdout || "").length,
                }),
              );
              throw new Error(
                "无法读取该演示稿的页面列表（xml_presentations get 未解析到任何 slide_id）。请检查 slides token、lark-cli 身份（bot/user）对该稿的读取权限，以及 CLI 返回是否为 JSON。",
              );
            }
            // 显式「第 N 页」必须优先于合并上下文里误带的「最后一页」，否则会把「第2页后插入」错指到末页。
            let pageIndex = maybeSlidesPageIndex;
            if (
              lastPageRequested &&
              slideIds.length > 0 &&
              (maybeSlidesPageIndex == null || maybeSlidesPageIndex < 1)
            ) {
              pageIndex = slideIds.length;
            }
            if (pageIndex == null || pageIndex < 1) {
              usedFallbackEmptySlides = true;
            } else {
            const idx0 = Math.max(0, pageIndex - 1);
            const targetSlideId = slideIds[idx0] || "";
            const beforeSlideId = slideIds[idx0 + 1] || "";
            slidesResultUrl = String(maybeSlidesTarget).startsWith("http")
              ? String(maybeSlidesTarget).trim()
              : `https://www.feishu.cn/slides/${editSlidesToken}`;

            if (!targetSlideId) {
              throw new Error("未定位到目标 slide_id：请检查页码是否超出演示稿范围。");
            } else {
              let execMode = "update_block";
              if (pureSlidesDelete) execMode = "delete_block";
              if (pureSlidesInsert) execMode = "insert_block";

              const trace = {
                artifactId: `note_slides_edit_${Date.now()}`,
                kind: "note",
                title: `PPT编辑：slides=${editSlidesToken} dryRun=${dryRunNow} 页=${pageIndex} slideId=${targetSlideId} 模式=${execMode}${useFineSlidesEdit ? ` op=${blockOp}` : ""}`,
                url: "",
              };
              task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, trace] });
              await this.emit(artifactEvent(taskId, trace));

              if (pureSlidesDelete) {
                const delArgs = this.buildSlidesXmlPresentationSlideDeleteArgs({
                  as: input.execution?.slidesIdentity ?? "user",
                  xmlPresentationId: editSlidesToken,
                  slideId: targetSlideId,
                  dryRun: dryRunNow,
                });
                await this.runLarkCliWithRetry(delArgs, { timeoutMs: 120_000 }, 2);
              } else if (pureSlidesInsert) {
                const p = editPlan.payload || {};
                const bullets = [];
                if (p.content) {
                  String(p.content)
                    .split(/[；;]/)
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .forEach((b) => bullets.push(b));
                }
                if (p.to) bullets.push(String(p.to));
                const slideXml = buildSimpleSlideXml({
                  title: String(p.title || "新增页"),
                  bullets: bullets.length ? bullets.slice(0, 8) : ["已新增页面"],
                });
                const stdin = buildXmlPresentationSlideCreateStdin({
                  contentXml: slideXml,
                  beforeSlideId,
                });
                const pageArgs = makeSlidesPageCreateArgs({
                  as: input.execution?.slidesIdentity ?? "user",
                  xmlPresentationId: editSlidesToken,
                  dryRun: dryRunNow,
                });
                await this.runLarkCliWithRetry(pageArgs, { timeoutMs: 120_000, stdin }, 2);
              } else {
                if (typeof this.buildSlidesXmlPresentationSlideReplaceArgs !== "function") {
                  throw new Error("服务端未注入 slides 更新 CLI（xml_presentation.slide replace），无法执行 UPDATE_BLOCK。");
                }
                let slideXml = "";
                if (typeof this.buildSlidesXmlPresentationSlideGetArgs === "function") {
                  const gsArgs = this.buildSlidesXmlPresentationSlideGetArgs({
                    as: input.execution?.slidesIdentity ?? "user",
                    xmlPresentationId: editSlidesToken,
                    slideId: targetSlideId,
                    dryRun: false,
                  });
                  const gsResp = await this.runLarkCliWithRetry(gsArgs, { timeoutMs: 120_000 }, 2);
                  slideXml = extractSlideContentXmlFromGetStdout(gsResp.stdout, this.tryParseJson);
                }
                const req = buildSlideUpdateRequest({ editPlan, slideXml });
                if (!req.stdin) {
                  throw new Error("UPDATE_BLOCK 缺少可执行替换模式：请提供 from/to，或使用“第N页标题改为XXX”并确保该页存在可识别标题。");
                }
                const repArgs = this.buildSlidesXmlPresentationSlideReplaceArgs({
                  as: input.execution?.slidesIdentity ?? "user",
                  xmlPresentationId: editSlidesToken,
                  slideId: targetSlideId,
                  dryRun: dryRunNow,
                });
                const repResp = await this.runLarkCliWithRetry(repArgs, { timeoutMs: 120_000, stdin: req.stdin }, 2);
                const ok = parseSlideReplaceSucceeded(repResp.stdout, this.tryParseJson);
                if (!ok) throw new Error("slide replace 未生效：请确认目标页内容与替换条件（from/title）匹配。");
              }
            }
            }
          } else if (!dryRunNow && slidesUrl && Array.isArray(slidesXmlArray) && slidesXmlArray.length > 0) {
            // Create mode: fill pages in the newly created deck.
            const xmlPresentationId = extractSlidesTokenFromUrl(slidesUrl);
            if (xmlPresentationId) {
              for (const slideXml of slidesXmlArray) {
                const stdin = buildXmlPresentationSlideCreateStdin({
                  contentXml: slideXml,
                  beforeSlideId: "",
                });
                const pageArgs = makeSlidesPageCreateArgs({
                  as: input.execution?.slidesIdentity ?? "user",
                  xmlPresentationId,
                  dryRun: dryRunNow,
                });
                await this.runLarkCliWithRetry(pageArgs, { timeoutMs: 120_000, stdin }, 2);
              }
            } else {
              usedFallbackEmptySlides = true;
            }
          }
          const slidesArtifact = {
            artifactId: `slides_${Date.now()}`,
            kind: "slides",
            title: slidesTitle.replace("（Agent）", ""),
            url: slidesResultUrl || slidesUrl || (editSlidesToken ? `https://www.feishu.cn/slides/${editSlidesToken}` : ""),
          };
          task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, slidesArtifact] });
          await this.emit(artifactEvent(taskId, slidesArtifact));

          if (usedFallbackEmptySlides) {
            const hint = {
              artifactId: `note_slides_fallback_${Date.now()}`,
              kind: "note",
              title:
                "提示：本次演示稿内容填充未完成（已创建演示稿但页面可能为空）。" +
                "为避免 Windows 命令行参数长度/转义问题，系统会优先“先建稿再逐页写入”。" +
                "若仍为空，请检查：1) IM 默认 FEISHU_DRY_RUN=true，需真写入时请设 FEISHU_DRY_RUN=false（或 WORKFLOW_DRY_RUN=false）2) slides 链接 token 是否可解析 3) slide XML 是否被服务端拒绝。" +
                "若要改「已有」演示稿，请附带可解析的 slides 链接并写明第几页，否则会误走新建稿分支。",
              url: "",
            };
            task = this.taskStore.update(taskId, { artifacts: [...task.artifacts, hint] });
            await this.emit(artifactEvent(taskId, hint));
          }
          }
        } else if (s.stepId === "step_send_delivery_message") {
          if (input.delivery?.chatId && !contentPreviewOnly) {
            const slides = task.artifacts.find((a) => a.kind === "slides");
            const docLink = typeof docUrl === "string" ? docUrl.trim() : "";
            const slidesLink = typeof slides?.url === "string" ? slides.url.trim() : "";
            let message = "任务已完成，产物已创建（当前未提取到 URL，可在后台结果中查看）。";
            if (docLink && !slidesLink) {
              message = `任务已完成，文档链接：${docLink}`;
            } else if (docLink && slidesLink) {
              message = `任务已完成，文档：${docLink}；演示稿：${slidesLink}（打开后可在飞书内放映/排练）`;
            } else if (!docLink && slidesLink) {
              message = `任务已完成，演示稿链接：${slidesLink}（打开后可在飞书内放映/排练）`;
            }
            const sendArgs = this.buildImMessagesSendArgs({
              as: input.execution?.defaultIdentity ?? execIdentity,
              chatId: input.delivery.chatId,
              text: message,
              dryRun: input.execution?.dryRun ?? execDryRun,
            });
            await this.runLarkCliWithRetry(sendArgs, { timeoutMs: 30_000 }, 2);
          }
        } else {
          // other logic steps: no-op, but kept for observability.
        }

        task = this.updateStep(task, s.stepId, "completed");
        await this.emit(stepEvent(taskId, task.steps.find((x) => x.stepId === s.stepId)));
      }

      this.taskStore.update(taskId, { state: "completed", currentStepId: null });
      await this.emit(stateEvent(taskId, "completed"));
      await this.emitTaskCompletedFeedback({ taskId, input, capturedIntent, capturedTemplate, startedAt });

      this.taskStore.update(taskId, { state: "reflecting", currentStepId: null });
      await this.emit(stateEvent(taskId, "reflecting"));
      void this.runReflectJob({ conversationId: input.conversationId || "" }).catch(() => {
        // reflect errors are intentionally non-blocking
      });
      await sleep(readReflectingPhaseMs());
      this.taskStore.update(taskId, { state: "idle", currentStepId: null });
      await this.emit(stateEvent(taskId, "idle"));
    } catch (err) {
      const rawMsg = err && err.message ? err.message : String(err);
      const msg = normalizeErrorMessage(rawMsg);
      this.taskStore.update(taskId, { state: "failed", lastError: msg, currentStepId: null });
      await this.emit(
        errorEvent(taskId, this.taskStore.get(taskId)?.currentStepId || "unknown", {
          code: "WORKFLOW_EXECUTION_ERROR",
          message: msg,
          retryable: true,
        }),
      );
      // Best-effort: report failure back to IM (safe with IMEntry sender filters).
      try {
        if (input?.delivery?.chatId) {
          const sendArgs = this.buildImMessagesSendArgs({
            as: input.execution?.defaultIdentity ?? "bot",
            chatId: input.delivery.chatId,
            text: `任务失败：${msg}`,
            dryRun: input.execution?.dryRun ?? true,
          });
          await this.runLarkCli(sendArgs, { timeoutMs: 30_000 });
        }
      } catch {
        // ignore
      }
      await this.emit(stateEvent(taskId, "failed"));
      await this.emitTaskCompletedFeedback({ taskId, input, capturedIntent, capturedTemplate, startedAt });
    }
  }
}

module.exports = {
  AgentOrchestrator,
  applyLinkedEditTargetArtifacts,
  resolveDocTarget,
  resolveSlidesTarget,
  mergeEditIntentSource,
  editInstructionText,
  extractSlideIdsFromCliOutput,
  parseSlideReplaceSucceeded,
};

