function stripMdPrefix(line) {
  return String(line || "")
    .replace(/^\s{0,3}[-*+]\s+/, "")
    .replace(/^\s{0,3}\d+[.)]\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .trim();
}

function normalizeLine(line) {
  return stripMdPrefix(line).replace(/\s+/g, " ").trim();
}

function dedupeKeepOrder(lines, { max = 200 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(lines) ? lines : []) {
    const s = normalizeLine(raw);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function isNoisyLine(line) {
  const s = normalizeLine(line);
  if (!s) return true;
  // Placeholder lines should not be treated as facts.
  if (s === "（暂无）" || s === "暂无" || s === "待补充" || s === "（待补充）" || s === "待定" || s === "（待定）") return true;
  // Common section labels that often pollute extracted bullets.
  if (
    s === "上文摘要" ||
    s === "上下文摘要" ||
    s === "关键要点" ||
    s === "要点" ||
    s === "事实要点" ||
    s === "决策/结论" ||
    s === "决策" ||
    s === "结论" ||
    s === "行动项" ||
    s === "待决问题" ||
    s === "待确认问题" ||
    s === "澄清清单" ||
    s === "约束/范围" ||
    s === "风险" ||
    s === "风险点"
  )
    return true;
  // Strip injected quote blocks and meta.
  if (s.startsWith(">")) return true;
  if (/^\[invalid text json\]$/i.test(s)) return true;
  // Imperative instructions that should not appear in final docs.
  if (/^(请|麻烦|帮我|帮忙|帮)\S{0,6}(整理|梳理|总结|生成|输出|写成|做成|改成|转成|提炼)/.test(s)) return true;
  if (/^(整理一下|梳理一下|总结一下|同步一下|生成一版|生成一份|输出一份)/.test(s)) return true;
  // Meeting fillers / IM chatter.
  if (
    /@所有人|没问题|好的|收到|ok\b|okay\b|roger|已收到|辛苦|请推进|推进一下|同步一下|拉一下|过一下|对齐一下|感谢|谢谢|哈哈|嗯嗯/.test(
      s.toLowerCase(),
    )
  ) {
    return true;
  }
  // Bot/system artifacts or delivery links.
  if (/已收到指令，任务已开始|已收到指令，任务已启动|规划产物（预览）|任务已完成|同步到飞书失败/.test(s)) return true;
  if (/https?:\/\/[^\s]+\/(?:docx|slides)\/[A-Za-z0-9]+/i.test(s)) return true;
  return false;
}

function extractUserOutlineFromText(text) {
  const raw = String(text || "");
  // Remove injected context blocks by server/orchestrator (best-effort).
  const cutAt = raw.indexOf("## 上下文摘要");
  const main = cutAt >= 0 ? raw.slice(0, cutAt) : raw;
  const lines = main
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const headings = [];
  for (const l of lines) {
    const s = l.trim();
    if (!s) continue;
    // markdown headings
    if (/^#{1,6}\s+/.test(s)) {
      const h = stripMdPrefix(s);
      if (h) headings.push(h);
      continue;
    }
    // chinese enumerations: 一、 二、 三、
    const mCN = s.match(/^(?<h>[一二三四五六七八九十]{1,3})、\s*(?<t>.+)$/);
    if (mCN && mCN.groups && mCN.groups.t) {
      headings.push(stripMdPrefix(mCN.groups.t));
      continue;
    }
    // 1. / 1) / 1、
    const mNum = s.match(/^\d{1,2}[.)、]\s*(.+)$/);
    if (mNum && mNum[1]) {
      headings.push(stripMdPrefix(mNum[1]));
      continue;
    }
  }

  return dedupeKeepOrder(headings, { max: 16 });
}

function classifyLine(line) {
  const s = normalizeLine(line);
  const lower = s.toLowerCase();

  // Order matters (decision before action, etc.)
  if (/(决定|结论|通过|拍板|定稿|最终|已确认|确认如下|一致同意|就这么办)/.test(s)) return "decisions";
  if (
    /(行动项|待办|todo|下一步|安排|负责人|owner|ddl|截止|完成|跟进|推进|补充|更新|对接|联调|排期)/.test(lower)
  )
    return "actions";
  if (/(待确认|需要确认|是否|要不要|能不能|怎么|为什么|谁来|何时|多少|范围是否)/.test(s) || /[？?]$/.test(s))
    return "openQuestions";
  if (/(风险|阻塞|延期|冲突|不确定|隐患|问题点|可能导致)/.test(s)) return "risks";
  if (/(必须|不得|不能|仅|限制|约束|权限|合规|安全|依赖|预算|成本|范围外|不包含|包含)/.test(s)) return "constraints";

  return "facts";
}

function sectionKeyForHeading(heading) {
  const h = String(heading || "").trim();
  if (!h) return "facts";
  const lower = h.toLowerCase();
  if (/结论|决策|决定|拍板/.test(h)) return "decisions";
  if (/行动|待办|下一步|计划|排期|里程碑/.test(h)) return "actions";
  if (/待确认|问题|疑问|澄清/.test(h)) return "openQuestions";
  if (/风险|阻塞/.test(h)) return "risks";
  if (/约束|范围|假设|限制|权限|合规|安全/.test(h) || lower.includes("scope")) return "constraints";
  return "facts";
}

function bullets(lines, max) {
  const picked = dedupeKeepOrder(lines, { max });
  return picked.length ? picked.map((x) => `- ${x}`).join("\n") : "- （暂无）";
}

function buildEvidencePoolMd(cleaned) {
  const c = cleaned && typeof cleaned === "object" ? cleaned : {};
  const pick = (arr, max) =>
    dedupeKeepOrder(Array.isArray(arr) ? arr : [], { max })
      .map((x) => `- ${x}`)
      .join("\n");
  const sections = [
    ["事实要点", c.facts],
    ["决策/结论", c.decisions],
    ["行动项", c.actions],
    ["待决问题", c.openQuestions],
    ["约束/范围", c.constraints],
    ["风险", c.risks],
  ];
  const parts = [];
  parts.push("## 证据池（已清洗，供引用）");
  for (const [title, arr] of sections) {
    const body = pick(arr, 6);
    if (!body) continue;
    parts.push(`\n### ${title}`);
    parts.push(body);
  }
  return parts.join("\n").trim();
}

function evaluateDocQuality(md, { minH2 = 4, minBulletsPerSection = 2 } = {}) {
  const s = String(md || "").trim();
  if (!s) return { ok: false, reasons: ["empty"] };

  const reasons = [];
  const forbidden = [
    /严重信息污染/,
    /\braw_messages\b/i,
    /原始对话未清洗/,
    /对上述讨论进行整理/,
    /（暂无）\s*（暂无）/,
  ];
  if (forbidden.some((re) => re.test(s))) reasons.push("forbidden_phrases");

  const lines = s.split(/\r?\n/);
  const h2Idx = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) h2Idx.push(i);
  }
  if (h2Idx.length < minH2) reasons.push("too_few_sections");

  // For each section, count bullets after the heading until next heading.
  for (let si = 0; si < h2Idx.length; si += 1) {
    const start = h2Idx[si] + 1;
    const end = si + 1 < h2Idx.length ? h2Idx[si + 1] : lines.length;
    const slice = lines.slice(start, end);
    const bulletsCount = slice.filter((l) => /^\s*-\s+/.test(l)).length;
    const hasTooManyPlaceholders = slice.filter((l) => /（暂无|待补充|待定|需确认）/.test(l)).length >= 6;
    if (bulletsCount < minBulletsPerSection && !hasTooManyPlaceholders) reasons.push("section_too_thin");
  }

  // Rough repetition check: identical normalized lines ratio.
  const norm = lines.map((l) => normalizeLine(l)).filter(Boolean);
  const seen = new Set();
  let dup = 0;
  for (const l of norm) {
    if (seen.has(l)) dup += 1;
    else seen.add(l);
  }
  if (norm.length >= 12 && dup / Math.max(1, norm.length) > 0.28) reasons.push("too_repetitive");

  return { ok: reasons.length === 0, reasons };
}

function buildRestructuredMd({ meta, outlineHeadings, cleaned, templateHeadings }) {
  const parts = [];

  parts.push("## 元信息");
  parts.push(
    bullets(
      [
        meta?.outputType ? `产物：${meta.outputType}` : "",
        meta?.scenario ? `场景：${meta.scenario}` : "",
        meta?.updatedAt ? `更新时间：${meta.updatedAt}` : "",
        meta?.sourceHint ? `来源：${meta.sourceHint}` : "",
      ].filter(Boolean),
      6,
    ),
  );

  const resolvedOutline = (() => {
    const user = Array.isArray(outlineHeadings) ? outlineHeadings : [];
    const tpl = Array.isArray(templateHeadings) ? templateHeadings : [];
    const merged = [];
    const seen = new Set();
    for (const h of [...user, ...tpl]) {
      const t = String(h || "").trim();
      if (!t) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      merged.push(t);
      if (merged.length >= 18) break;
    }
    return merged;
  })();

  parts.push("\n## 内容大纲");
  parts.push(bullets(resolvedOutline, 18));

  // Body sections follow the resolved outline if user provided one; otherwise follow a stable default.
  const defaultSections = ["事实要点", "决策/结论", "行动项", "待决问题", "约束/范围", "风险"];
  const useOutline = Array.isArray(outlineHeadings) && outlineHeadings.length > 0;
  const bodyHeadings = useOutline ? resolvedOutline : defaultSections;

  const pickByHeading = (heading) => cleaned[sectionKeyForHeading(heading)] || [];
  const used = new Set();
  for (const h of bodyHeadings) {
    const key = sectionKeyForHeading(h);
    if (!useOutline) {
      // Map default headings to distinct buckets.
      if (key === "facts" && used.has("facts")) continue;
      if (used.has(key)) continue;
    }
    used.add(key);
    parts.push(`\n## ${h}`);
    parts.push(bullets(pickByHeading(h), 10));
  }

  // Any leftover facts that were not surfaced in user outline headings.
  if (useOutline) {
    const surfacedKeys = new Set(bodyHeadings.map(sectionKeyForHeading));
    const extras = [];
    for (const [k, arr] of Object.entries(cleaned || {})) {
      if (surfacedKeys.has(k)) continue;
      for (const x of arr) extras.push(x);
    }
    if (extras.length) {
      parts.push("\n## 补充信息");
      parts.push(bullets(extras, 10));
    }
  }

  return parts.join("\n");
}

function buildPptOutlineLines({ cleaned, outlineHeadings }) {
  const lines = [];
  const pushAll = (arr, max) => {
    for (const x of dedupeKeepOrder(arr, { max })) {
      if (lines.length >= 24) return;
      lines.push(x);
    }
  };

  // Prefer user outline headings as a story line.
  if (Array.isArray(outlineHeadings) && outlineHeadings.length > 0) {
    pushAll(outlineHeadings, 10);
  }

  pushAll(cleaned?.decisions, 8);
  pushAll(cleaned?.facts, 8);
  pushAll(cleaned?.risks, 6);
  pushAll(cleaned?.actions, 6);
  pushAll(cleaned?.openQuestions, 6);

  return lines.slice(0, 24);
}

function templateHeadingsFromIntent(intent) {
  const i = intent && typeof intent === "object" ? intent : {};
  const docType = i.doc_type || "meeting_summary";
  if (docType === "prd") return ["背景与目标", "范围（包含/不包含）", "需求列表", "验收标准", "风险与待确认", "里程碑与排期"];
  if (docType === "solution") return ["背景与目标", "方案概述", "架构/模块拆分", "风险与权衡", "里程碑与回滚预案"];
  if (docType === "report") return ["核心结论", "关键数据与指标", "问题与原因分析", "建议与下一步", "风险与待确认"];
  if (docType === "brainstorm") return ["问题定义", "发散想法清单", "候选方案对比", "下一步验证计划"];
  return ["会议主题与参会人", "议题与关键讨论点", "结论/决定", "行动项（owner/ddl）", "待确认问题"];
}

function collectCandidateLines({ text, contextSummary, bundle }) {
  const out = [];
  const pushMd = (md) => {
    const s = String(md || "");
    if (!s.trim()) return;
    for (const l of s.split(/\r?\n/)) out.push(l);
  };
  pushMd(text);
  pushMd(contextSummary);
  if (bundle && typeof bundle === "object") {
    pushMd(bundle.summaryMd);
    pushMd(bundle.requirementsMd);
    pushMd(bundle.clarifyMd);
    pushMd(bundle.outlineMd);
  }
  return out;
}

function restructureContent({ text, contextSummary, intent, bundle, targetArtifacts }) {
  const outputType = intent?.output_type === "ppt" ? "PPT" : "文档";
  const scenario = typeof intent?.scenario === "string" ? intent.scenario : "";
  const outlineHeadings = extractUserOutlineFromText(text);

  const templateHeadings = templateHeadingsFromIntent(intent);
  const outlineSet = new Set(
    dedupeKeepOrder([...(Array.isArray(outlineHeadings) ? outlineHeadings : []), ...(Array.isArray(templateHeadings) ? templateHeadings : [])], { max: 40 }),
  );

  const candidates = collectCandidateLines({ text, contextSummary, bundle })
    .map(normalizeLine)
    .filter((l) => l && !isNoisyLine(l))
    // Drop outline headings themselves to avoid polluting facts.
    .filter((l) => !outlineSet.has(l))
    // drop headings-only lines
    .filter((l) => !/^(任务指令|意图|执行计划|Planner|结构大纲|上下文摘要|关键要点|需求点|待确认问题|行动项|决策\/结论|决策|结论)\b/.test(l));

  const cleaned = {
    decisions: [],
    actions: [],
    openQuestions: [],
    constraints: [],
    risks: [],
    facts: [],
  };

  for (const l of candidates) {
    const bucket = classifyLine(l);
    cleaned[bucket].push(l);
  }

  for (const k of Object.keys(cleaned)) cleaned[k] = dedupeKeepOrder(cleaned[k], { max: 40 });

  // Ensure “讨论内容不留原话”：对过长/像聊天的条目做更强收敛。
  const tighten = (arr) =>
    dedupeKeepOrder(
      (Array.isArray(arr) ? arr : [])
        .map((x) => normalizeLine(x))
        .filter((x) => x.length <= 140)
        .filter((x) => !/^(我|你|他|她|我们|大家)\b/.test(x)),
      { max: 30 },
    );
  cleaned.decisions = tighten(cleaned.decisions);
  cleaned.actions = tighten(cleaned.actions);
  cleaned.openQuestions = tighten(cleaned.openQuestions);
  cleaned.constraints = tighten(cleaned.constraints);
  cleaned.risks = tighten(cleaned.risks);
  cleaned.facts = tighten(cleaned.facts);

  const meta = {
    outputType,
    scenario,
    updatedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
    sourceHint:
      Array.isArray(targetArtifacts) && targetArtifacts.includes("slides")
        ? "用户输入/上下文（已清洗）"
        : "用户输入/上下文（已清洗）",
  };

  const restructuredMd = buildRestructuredMd({
    meta,
    outlineHeadings,
    cleaned,
    templateHeadings,
  });

  const pptOutlineLines = buildPptOutlineLines({ cleaned, outlineHeadings });

  const docOutlineMd = ["## 结构大纲（可编辑）", bullets([...outlineHeadings, ...templateHeadings], 18)].join("\n");
  const evidencePoolMd = buildEvidencePoolMd(cleaned);

  return {
    cleaned,
    outlineHeadings,
    templateHeadings,
    restructuredMd,
    docOutlineMd,
    pptOutlineLines,
    evidencePoolMd,
  };
}

module.exports = { restructureContent, buildEvidencePoolMd, evaluateDocQuality };

