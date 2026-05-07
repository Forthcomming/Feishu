const RE_DOC_URL = /(?:https?:\/\/[^\s"']+\/docx\/[A-Za-z0-9]+)|(?:\bdocx\/[A-Za-z0-9]+\b)/i;
const RE_SLIDES_URL = /(?:https?:\/\/[^\s"']+\/slides\/[A-Za-z0-9_-]+)|(?:\bslides\/[A-Za-z0-9_-]+\b)/i;
const { UPDATE_BLOCK, DELETE_BLOCK, INSERT_BLOCK } = require("./editBlockOps");

function cleanText(s) {
  return String(s || "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function pickTarget(raw, intent) {
  if (RE_SLIDES_URL.test(raw)) return "slides";
  if (RE_DOC_URL.test(raw)) return "doc";
  // 「最后一页」几乎总是幻灯片页序；避免无链接时落到 doc 导致整段编辑链路不触发
  if (/最后\s*一\s*页|最后一页(?:幻灯)?|最后一页ppt/i.test(raw)) return "slides";
  if (/ppt|演示稿|幻灯片|slides|deck/i.test(raw)) return "slides";
  if (/文档|doc|docx|纪要|需求|报告/i.test(raw)) return "doc";
  if (intent && intent.output_type === "ppt") return "slides";
  return "doc";
}

function pickOperation(raw) {
  const t = String(raw || "");
  // 合并上下文里常混入无关的「删除」「最后一页」；用户对「第 N 页…改成/改为」的指令必须优先，
  // 否则会出现「删除」与「第 2 页」跨句 AND 误判为 delete、或 lastPage 覆盖页码删错页。
  if (/第\s*\d{1,3}\s*页/.test(t) && /(改成|改为|替换成|替换为|替换掉)/.test(t)) {
    return UPDATE_BLOCK;
  }
  // 页级删除：删除动词与「最后一页」同现
  if (/(删掉|删去|删了|删除|去掉|移除)/.test(t) && /(最后\s*一\s*页|最后一页(?:幻灯)?|最后一页ppt)/i.test(t)) {
    return DELETE_BLOCK;
  }
  // 删除第 N 页（无「改成」类词时才成立；有「改成」已在上面 return replace）
  if (/(删掉|删去|删了|删除|去掉|移除)/.test(t) && /第\s*\d{1,3}\s*页/.test(t)) {
    return DELETE_BLOCK;
  }
  if (/(改成|改为|替换成|替换为|替换掉)/.test(t)) return UPDATE_BLOCK;
  if (/(插入|新增|补充|添加)/.test(t)) return INSERT_BLOCK;
  if (/(删掉|删去|删了|删除|去掉|移除)/.test(t)) return DELETE_BLOCK;
  if (/(精简|压缩|浓缩)/.test(t)) return UPDATE_BLOCK;
  if (/(润色|改写|重写|统一语气|优化表达)/.test(t)) return UPDATE_BLOCK;
  return UPDATE_BLOCK;
}

function pickReplacePayload(raw) {
  const m = raw.match(/把(.{1,120}?)(?:改成|改为|替换成|替换为)(.{1,240})/);
  if (m) return { from: cleanText(m[1]), to: cleanText(m[2]) };
  const quoted = raw.match(/["']([^"']{1,180})["']/g) || [];
  if (quoted.length >= 2) {
    return {
      from: cleanText(quoted[0].slice(1, -1)),
      to: cleanText(quoted[1].slice(1, -1)),
    };
  }
  return { from: "", to: "" };
}

/** 去掉 doc/slides 链接后再解析「在…后面插入」，避免 URL 占用 120 字上限导致锚点被截断或整句匹配失败 */
function stripUrlsForLocalParse(raw) {
  return String(raw || "")
    .replace(RE_DOC_URL, " ")
    .replace(RE_SLIDES_URL, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 「在 的"正文"后面」→ 与文档列表项对齐的锚点正文 */
function normalizeDocInsertAnchor(s) {
  let t = cleanText(s).trim();
  t = t.replace(/^的\s*/, "");
  t = t.replace(/^["「『]/, "").replace(/["」』]$/, "").trim();
  return t;
}

function pickInsertPayload(raw) {
  const compact = stripUrlsForLocalParse(raw);
  const re = /在\s*(.{1,2000}?)\s*(后面|之后|后)\s*(插入|新增|补充|添加)([\s\S]{1,2000})/;
  let m = compact.match(re);
  if (!m) m = String(raw || "").match(re);
  if (!m) return { anchor: "", content: "" };
  return {
    anchor: normalizeDocInsertAnchor(m[1]),
    content: cleanText(m[4]),
  };
}

/** slides 插入：解析「标题「xx」」「内容「yy」」等口语，不依赖「在…后面」句式 */
function pickSlidesInsertPayload(raw) {
  const t = String(raw || "");
  let title = "";
  const t1 = t.match(/标题\s*[「"']([^」"']{1,120})[」"']/);
  const t2 = t.match(/标题\s*[:：]\s*([^\s，,。]{1,120})/);
  if (t1) title = cleanText(t1[1]);
  else if (t2) title = cleanText(t2[1]);
  let content = "";
  const c1 = t.match(/内容\s*[「"']([^」"']{1,800})[」"']/);
  const c2 = t.match(/内容\s*[:：]\s*(.+?)(?:$|。|\n)/);
  if (c1) content = cleanText(c1[1]);
  else if (c2) content = cleanText(c2[1]);
  return { title, content };
}

function pickDeletePayload(raw) {
  const m = raw.match(/删除(?:关于)?(.{1,120}?)(?:段落|内容|那一段|这一段)?(?:$|。|；|,)/);
  return { target: cleanText((m && m[1]) || "") };
}

function pickSlidesSelector(raw) {
  const page = raw.match(/第\s*(\d{1,3})\s*页|页码\s*(\d{1,3})|\bpage\s*(\d{1,3})\b/i);
  const bullet = raw.match(/第\s*(\d{1,2})\s*条|bullet\s*(\d{1,2})/i);
  const pageIndex = Number((page && (page[1] || page[2] || page[3])) || 0) || null;
  const bulletIndex = Number((bullet && (bullet[1] || bullet[2])) || 0) || null;
  const lastPageRaw = /最后\s*一\s*页|最后一页(?:幻灯)?|最后一页ppt/i.test(raw);
  // 显式「第 N 页」优先于上下文里误带的「最后一页」
  const lastPage = pageIndex != null ? false : lastPageRaw;
  const titleHit = raw.match(/(?:标题|title)(?:改成|改为|替换成|替换为)(.{1,180})/i);
  return {
    pageIndex,
    bulletIndex,
    lastPage,
    title: titleHit ? cleanText(titleHit[1]) : "",
  };
}

function parseEditIntent(input, context = {}) {
  const raw = cleanText(input);
  if (!raw) return { isEdit: false, reason: "empty_input" };
  const target = pickTarget(raw, context.intent || null);
  const operation = pickOperation(raw);

  let selector = {};
  let payload = {};
  if (target === "slides") {
    const slideSel = pickSlidesSelector(raw);
    selector = {
      pageIndex: slideSel.pageIndex,
      bulletIndex: slideSel.bulletIndex,
      lastPage: slideSel.lastPage,
    };
    if (operation === UPDATE_BLOCK) {
      const rp = pickReplacePayload(raw);
      payload = {
        from: rp.from,
        to: rp.to,
        title: slideSel.title || rp.to || "",
      };
    } else if (operation === INSERT_BLOCK) {
      const ins = pickSlidesInsertPayload(raw);
      payload = {
        title: ins.title || slideSel.title || "新增页",
        content: ins.content,
      };
    } else {
      payload = { title: slideSel.title || "" };
    }
  } else if (operation === INSERT_BLOCK) {
    const ip = pickInsertPayload(raw);
    selector = { anchorText: ip.anchor };
    payload = { content: ip.content };
  } else if (operation === DELETE_BLOCK) {
    const dp = pickDeletePayload(raw);
    selector = { anchorText: dp.target };
    payload = { content: "" };
  } else {
    const rp = pickReplacePayload(raw);
    selector = { anchorText: rp.from };
    payload = { content: rp.to, from: rp.from, to: rp.to };
  }

  const hasActionWord =
    /(改成|改为|替换|插入|新增|补充|删掉|删去|删除|去掉|移除|润色|重写|精简|压缩)/.test(raw);
  const hasLocator = Boolean(
    selector.anchorText || selector.pageIndex || selector.bulletIndex || selector.lastPage,
  );
  const hasPayload = Boolean(payload.content || payload.to || payload.title || payload.maxBullets);
  const isEdit = hasActionWord && (hasLocator || hasPayload);

  const confidence = isEdit ? 0.75 : 0;
  const needsConfirm = false;
  return {
    isEdit,
    target,
    operation,
    selector,
    payload,
    confidence,
    needsConfirm,
    reason: isEdit ? "edit_instruction_matched" : "no_edit_pattern",
  };
}

module.exports = {
  parseEditIntent,
};
