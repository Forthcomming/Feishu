function stripInvisibleUnicode(s) {
  return String(s || "").replace(/[\u200b-\u200d\ufeff]/g, "");
}

function decodeXmlNumericEntities(s) {
  return String(s || "")
    .replace(/&#(\d{1,7});/g, (_, n) => {
      const c = Number(n);
      return Number.isFinite(c) && c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : _;
    })
    .replace(/&#x([0-9a-fA-F]{1,6});/gi, (_, h) => {
      const c = parseInt(h, 16);
      return Number.isFinite(c) && c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : _;
    });
}

/** NFC + 去零宽，减轻复制粘贴导致的匹配失败 */
function normalizeAnchorText(s) {
  try {
    return stripInvisibleUnicode(String(s || "")).normalize("NFC");
  } catch {
    return stripInvisibleUnicode(String(s || ""));
  }
}

function collectSubtreeStrings(obj, budget = 80000) {
  let total = 0;
  const parts = [];
  const walk = (v) => {
    if (total >= budget) return;
    if (typeof v === "string") {
      total += v.length;
      parts.push(v);
      return;
    }
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else {
      for (const val of Object.values(v)) walk(val);
    }
  };
  walk(obj);
  return parts.join("\n");
}

/** 飞书正文常见弯引号与 ASCII 引号混用 */
function normalizeQuotesForMatch(s) {
  return String(s).replace(/\u201c|\u201d|\uff02/g, '"');
}

/** 去掉 XML 标签后再比：fetch 正文常被 `<w:t>` 等拆开，连续 includes 会失败 */
function flattenXmlishForMatch(s) {
  let t = decodeXmlNumericEntities(String(s || ""));
  t = normalizeQuotesForMatch(normalizeAnchorText(t));
  t = t.replace(/<[^>]+>/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** 中英文标点与问号形态对齐，减轻「看起来一样」却不匹配 */
function unifyWeakPunctuation(s) {
  return String(s)
    .replace(/[?？]/g, "?")
    .replace(/[!！]/g, "!")
    .replace(/[;；]/g, ";")
    .replace(/[:：]/g, ":");
}

/** 允许正文与锚点空白略不一致；stdout 侧可能含 XML 数字实体 */
function textHaystackIncludesNeedle(haystack, needle) {
  let n = normalizeAnchorText(needle).trim();
  if (n.length < 2) return false;
  n = normalizeQuotesForMatch(n);
  const raw = String(haystack || "");
  let h = normalizeAnchorText(decodeXmlNumericEntities(raw));
  h = normalizeQuotesForMatch(h);
  if (h.includes(n)) return true;
  const hn = h.replace(/\s+/g, " ");
  const nn = n.replace(/\s+/g, " ");
  if (nn.length >= 2 && hn.includes(nn)) return true;
  return textHaystackIncludesNeedleLoose(haystack, needle);
}

function textHaystackIncludesNeedleLoose(haystack, needle) {
  let n = flattenXmlishForMatch(needle);
  if (n.length < 2) return false;
  n = unifyWeakPunctuation(n);
  let h = flattenXmlishForMatch(haystack);
  h = unifyWeakPunctuation(h);
  if (h.includes(n)) return true;
  if (n.length >= 14) {
    const suf = n.slice(-Math.min(48, Math.floor(n.length * 0.85)));
    if (suf.length >= 12 && h.includes(suf)) return true;
  }
  return false;
}


/**
 * 生成锚点备选串：标点/引号/标题冒号变体，减轻「看上去一致但匹配不到」。
 */
function expandAnchorCandidates(primary) {
  const base = normalizeAnchorText(primary || "").trim();
  if (base.length < 2) return [];
  const set = new Set();
  const add = (s) => {
    const t = normalizeAnchorText(s).trim();
    if (t.length >= 2) set.add(t);
  };
  add(base);
  try {
    add(base.normalize("NFKC"));
  } catch {
    /* ignore */
  }
  add(normalizeQuotesForMatch(base));
  add(base.replace(/：/g, ":"));
  add(base.replace(/:/g, "："));
  if (!/[：:。.．!?！？]$/.test(base)) {
    add(`${base}：`);
    add(`${base}:`);
  }
  add(base.replace(/[：:。.．]+$/g, ""));
  return [...set];
}

/**
 * 在 JSON 树中找「子树文本含锚点」且自身带 block_id 的节点。
 * 多命中时优先子树文本最短（通常是标题独立块），再取更深节点；避免「章节容器」盖住标题块。
 */
function findBlockIdInJsonValue(root, anchor) {
  const candidates = [];
  const walk = (cur, depth) => {
    if (cur == null || typeof cur !== "object") return;
    const id =
      typeof cur.block_id === "string"
        ? cur.block_id
        : typeof cur.blockId === "string"
          ? cur.blockId
          : typeof cur.block_token === "string"
            ? cur.block_token
            : "";
    if (id && id.length > 4) {
      const hay = collectSubtreeStrings(cur);
      if (textHaystackIncludesNeedle(hay, anchor)) {
        candidates.push({ id, depth, hayLen: hay.length });
      }
    }
    if (Array.isArray(cur)) {
      for (const x of cur) walk(x, depth + 1);
    } else {
      for (const v of Object.values(cur)) {
        if (v && typeof v === "object") walk(v, depth + 1);
      }
    }
  };
  walk(root, 0);
  if (candidates.length === 0) return "";
  candidates.sort((x, y) => x.hayLen - y.hayLen || y.depth - x.depth);
  return candidates[0].id;
}

/**
 * JSON 解析失败或结构不标准时：按「相邻 block_id 字段之间的片段」扫描。
 * 全文 indexOf 锚点在 XML 标签拆开时会失效；按段匹配更贴近实际块边界。
 */
function findBlockIdInRawString(raw, anchor) {
  const s = String(raw || "");
  const a = normalizeAnchorText(anchor || "").trim();
  if (a.length < 2 || !textHaystackIncludesNeedle(s, a)) return "";

  const re =
    /(?:block[-_]?id|blockId|block_token)\s*[:=]\s*["']([a-zA-Z0-9_-]{8,})["']/gi;
  const hits = [];
  let m;
  while ((m = re.exec(s))) {
    hits.push({ id: m[1], matchStart: m.index, matchEnd: m.index + m[0].length });
  }
  if (hits.length === 0) return "";

  const candidates = [];
  for (let i = 0; i < hits.length; i++) {
    const chunkEnd = i + 1 < hits.length ? hits[i + 1].matchStart : s.length;
    const chunk = s.slice(hits[i].matchStart, chunkEnd);
    if (textHaystackIncludesNeedle(chunk, a)) {
      candidates.push({ id: hits[i].id, chunkLen: chunk.length });
    }
  }
  if (candidates.length > 0) {
    candidates.sort((x, y) => x.chunkLen - y.chunkLen);
    return candidates[0].id;
  }

  const searchIn = decodeXmlNumericEntities(s);
  const ids = [];
  let m2;
  const re2 =
    /(?:block[-_]?id|blockId|block_token)\s*[:=]\s*["']([a-zA-Z0-9_-]{8,})["']/gi;
  while ((m2 = re2.exec(searchIn))) {
    ids.push({ id: m2[1], index: m2.index });
  }
  let anchorPos = searchIn.indexOf(a);
  if (anchorPos < 0) {
    const nn = a.replace(/\s+/g, " ");
    anchorPos = searchIn.replace(/\s+/g, " ").indexOf(nn);
  }
  if (anchorPos < 0) {
    const flatH = unifyWeakPunctuation(flattenXmlishForMatch(searchIn));
    const flatA = unifyWeakPunctuation(flattenXmlishForMatch(a));
    if (flatA.length >= 2) anchorPos = flatH.indexOf(flatA);
  }
  if (anchorPos < 0) return "";

  let bestId = "";
  let bestIdx = -1;
  for (const { id, index } of ids) {
    if (index <= anchorPos && index > bestIdx) {
      bestIdx = index;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * 从 docs +fetch（JSON/XML/Markdown 文本）中启发式定位包含锚点文案的 block_id。
 */
/** 用于模糊匹配：去空白与弱标点，中英混排句子仍可比对 */
function normalizeForDice(s) {
  return unifyWeakPunctuation(flattenXmlishForMatch(s)).replace(/\s+/g, "");
}

function diceBigramSimilarity(s1, s2) {
  const a = normalizeForDice(s1);
  const b = normalizeForDice(s2);
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  if (a.length >= 8 && b.includes(a)) return 0.94;
  if (b.length >= 8 && a.includes(b)) return 0.9;
  const na = Math.max(0, a.length - 1);
  const nb = Math.max(0, b.length - 1);
  if (na === 0 || nb === 0) return 0;
  const m1 = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    m1.set(bg, (m1.get(bg) || 0) + 1);
  }
  const m2 = new Map();
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    m2.set(bg, (m2.get(bg) || 0) + 1);
  }
  let inter = 0;
  for (const [bg, c2] of m2) {
    if (m1.has(bg)) inter += Math.min(c2, m1.get(bg));
  }
  return (2 * inter) / (na + nb);
}

function anchorVersusBlockScore(anchor, blockText) {
  return diceBigramSimilarity(anchor, blockText);
}

/** 遍历 JSON：每个带 block_id 的节点收集整棵子树文本，供模糊打分（比单次 includes 更抗措辞差异） */
function collectBlockIdTextPairs(root, budget = 120000) {
  const pairs = [];
  const walk = (cur) => {
    if (cur == null || typeof cur !== "object") return;
    const id =
      typeof cur.block_id === "string"
        ? cur.block_id
        : typeof cur.blockId === "string"
          ? cur.blockId
          : typeof cur.block_token === "string"
            ? cur.block_token
            : "";
    if (id && id.length > 4) {
      pairs.push({ id, text: collectSubtreeStrings(cur, budget) });
    }
    if (Array.isArray(cur)) {
      for (const x of cur) walk(x);
    } else {
      for (const v of Object.values(cur)) {
        if (v && typeof v === "object") walk(v);
      }
    }
  };
  walk(root);
  return pairs;
}

/**
 * 精确匹配全部失败后：对「每个候选块的文本」与锚点做 Dice 相似度，取分差足够大的最优。
 */
function pickBestBlockIdByFuzzy(pairs, anchor) {
  const a = normalizeAnchorText(anchor || "").trim();
  if (a.length < 2 || pairs.length === 0) return "";
  const MIN_ABS_LONG = 0.36;
  const MIN_ABS_SHORT = 0.44;
  const MIN_GAP = 0.055;
  const HIGH_CONF = 0.68;
  const minAbs = a.length >= 28 ? MIN_ABS_LONG : MIN_ABS_SHORT;

  const scored = pairs.map((p) => ({
    id: p.id,
    hayLen: p.text.length,
    score: anchorVersusBlockScore(a, p.text),
  }));
  scored.sort((x, y) => y.score - x.score || x.hayLen - y.hayLen);
  const top = scored[0];
  const second = scored[1];
  if (!top || top.score < minAbs) return "";
  if (top.score >= HIGH_CONF) return top.id;
  if (second && top.score - second.score < MIN_GAP) return "";
  return top.id;
}

function findBlockIdByFuzzyJson(parsedRoot, anchor) {
  const pairs = collectBlockIdTextPairs(parsedRoot);
  return pickBestBlockIdByFuzzy(pairs, anchor);
}

function findBlockIdByFuzzyRaw(raw, anchor) {
  const s = String(raw || "");
  const re =
    /(?:block[-_]?id|blockId|block_token)\s*[:=]\s*["']([a-zA-Z0-9_-]{8,})["']/gi;
  const hits = [];
  let m;
  while ((m = re.exec(s))) {
    hits.push({ id: m[1], matchStart: m.index, matchEnd: m.index + m[0].length });
  }
  if (hits.length === 0) return "";
  const pairs = [];
  for (let i = 0; i < hits.length; i++) {
    const chunkEnd = i + 1 < hits.length ? hits[i + 1].matchStart : s.length;
    pairs.push({ id: hits[i].id, text: s.slice(hits[i].matchStart, chunkEnd) });
  }
  return pickBestBlockIdByFuzzy(pairs, anchor);
}

function findBlockIdForAnchorText(fetchStdout, anchorText, tryParseJson) {
  const primary = normalizeAnchorText(anchorText || "").trim();
  if (primary.length < 2) return "";
  const variants = expandAnchorCandidates(primary);

  let parsedValue = null;
  if (typeof tryParseJson === "function") {
    const parsed = tryParseJson(String(fetchStdout || ""));
    if (parsed && parsed.ok && parsed.value) parsedValue = parsed.value;
  }
  const raw = String(fetchStdout || "");

  for (const anchor of variants) {
    if (parsedValue) {
      const hit = findBlockIdInJsonValue(parsedValue, anchor);
      if (hit) return hit;
    }
    const fromRaw = findBlockIdInRawString(raw, anchor);
    if (fromRaw) return fromRaw;
  }

  if (parsedValue) {
    const fuzzyJ = findBlockIdByFuzzyJson(parsedValue, primary);
    if (fuzzyJ) return fuzzyJ;
  }
  const fuzzyR = findBlockIdByFuzzyRaw(raw, primary);
  if (fuzzyR) return fuzzyR;

  return "";
}

function escapeRegExpLiteral(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 解析 docs +update 的 stdout：partial_success / failed / 0 处更新 视为未成功（触发重试或降级）。 */
function parseDocsUpdateSuccess(stdout, tryParseJson) {
  if (typeof tryParseJson !== "function") return false;
  const p = tryParseJson(String(stdout || ""));
  if (!p.ok) return false;
  const v = p.value;
  if (v && v.ok === false) return false;
  if (Number(v?.code) > 0 || Number(v?.data?.code) > 0) return false;
  const result = v?.data?.result ?? v?.result ?? "";
  if (result === "failed" || result === "partial_success") return false;
  const updated =
    v?.data?.updated_blocks_count ??
    v?.data?.document?.updated_blocks_count ??
    v?.updated_blocks_count;
  if (typeof updated === "number" && Number.isFinite(updated) && updated <= 0) return false;
  if (v?.ok === true || v?.success === true) return true;
  if (Number(v?.code) === 0 || Number(v?.data?.code) === 0) return true;
  return false;
}

module.exports = {
  findBlockIdForAnchorText,
  expandAnchorCandidates,
  escapeRegExpLiteral,
  parseDocsUpdateSuccess,
};
