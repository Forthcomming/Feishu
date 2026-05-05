const test = require("node:test");
const assert = require("node:assert/strict");

const { generateContentBundle, generateSlidesXmlArray } = require("../src/contentAgent");

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars || {})) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    return fn();
  } finally {
    restore();
  }
}

test("contentAgent: 无 Doubao 时也能生成完整 markdown bundle", async () => {
  await withEnv({ DOUBAO_API_KEY: null, DOUBAO_ENDPOINT_ID: null, DOUBAO_CONTENT_ENDPOINT_ID: null }, async () => {
    await assert.rejects(
      () =>
        generateContentBundle({
          text: "我们要做一个需求文档。需要确认权限与范围。下一步请给出里程碑。",
          contextSummary: "关键要点：做文档；待确认：权限；行动项：里程碑。",
          targetArtifacts: ["doc"],
          intent: { output_type: "doc", doc_type: "prd", ppt_type: "report", scenario: "discussion" },
        }),
      /LLM is required/i,
    );
  });
});

test("contentAgent: restructuredMd 会清洗口语/指令并输出决策化结构", async () => {
  await withEnv({ DOUBAO_API_KEY: null, DOUBAO_ENDPOINT_ID: null, DOUBAO_CONTENT_ENDPOINT_ID: null }, async () => {
    await assert.rejects(
      () =>
        generateContentBundle({
          text: [
            " @所有人 同步一下",
            "[Invalid text JSON]",
            "请把最近讨论整理成需求文档：包含背景/目标/范围/需求点/风险/里程碑",
            "没问题",
            "决定：本周五发布",
            "下一步：小王 owner，ddl 周四",
            "需要确认：是否包含旧版兼容？",
            "OK",
          ].join("\n"),
          contextSummary: "",
          targetArtifacts: ["doc"],
          intent: { output_type: "doc", doc_type: "meeting_summary", ppt_type: "report", scenario: "discussion" },
        }),
      /LLM is required/i,
    );
  });
});

test("contentAgent: 用户给出显式大纲时以其为主并补齐结构", async () => {
  await withEnv({ DOUBAO_API_KEY: null, DOUBAO_ENDPOINT_ID: null, DOUBAO_CONTENT_ENDPOINT_ID: null }, async () => {
    await assert.rejects(
      () =>
        generateContentBundle({
          text: ["一、背景", "二、目标", "三、风险", "决定：采用A方案", "下一步：推进排期"].join("\n"),
          contextSummary: "",
          targetArtifacts: ["doc"],
          intent: { output_type: "doc", doc_type: "solution", ppt_type: "report", scenario: "review" },
        }),
      /LLM is required/i,
    );
  });
});

const sixSlidesPlan = {
  confidence: 0.8,
  slides: [
    { title: "评审演示稿（封面）", bullets: ["目标：通过评审并明确决策", "范围：仅本期核心能力", "产物：可执行计划与风险清单"] },
    { title: "背景与目标（为什么做）", bullets: ["当前痛点：路由纠错成本高", "目标：降低错派并可追溯", "成功标准：错误率下降、可复核"] },
    { title: "方案概览（怎么做）", bullets: ["先自动路由，再人工复核兜底", "输出置信度与解释", "关键链路可中断可回放"] },
    { title: "关键风险与对策", bullets: ["非结构化图片/手写影响识别", "低置信度强制进入复核", "上线前做回归样本集"] },
    { title: "里程碑与排期", bullets: ["5/6 前交付交互原型", "Alpha：验证复核闭环", "上线：灰度+监控"] },
    { title: "需要决策/支持", bullets: ["是否确认范围边界", "是否需要审批流", "资源与时间投入确认"] },
  ],
};

test("contentAgent: 可从 bundle 生成预定义模板 slidesXmlArray（review）", () => {
  const slides = generateSlidesXmlArray({
    bundle: { rewrittenSlidesPlan: sixSlidesPlan },
    text: "请生成评审PPT",
    intent: { output_type: "ppt", doc_type: "report", ppt_type: "review", scenario: "review" },
  });
  assert.ok(Array.isArray(slides));
  assert.equal(slides.length, 6);
  assert.match(slides[0], /<slide\b/);
  assert.match(slides[0], /linear-gradient\(135deg,rgba\(15,23,42,1\)/);
  assert.match(slides[0], /textAlign="center"/);
  assert.match(slides[1], /type="rect"/);
  assert.match(slides[1], /rgb\(248,250,252\)/);
  assert.match(slides[slides.length - 1], /linear-gradient\(135deg,rgba\(30,41,59,1\)/);
});

test("contentAgent: report 模板封面与正文配色", () => {
  const slides = generateSlidesXmlArray({
    bundle: { rewrittenSlidesPlan: sixSlidesPlan },
    text: "请生成汇报PPT",
    intent: { output_type: "ppt", doc_type: "report", ppt_type: "report", scenario: "discussion" },
  });
  assert.match(slides[0], /linear-gradient\(135deg,rgba\(30,60,114,1\)/);
  assert.match(slides[1], /rgb\(248,250,252\)/);
});

test("contentAgent: proposal 模板封面渐变", () => {
  const slides = generateSlidesXmlArray({
    bundle: { rewrittenSlidesPlan: sixSlidesPlan },
    text: "请生成提案PPT",
    intent: { output_type: "ppt", doc_type: "report", ppt_type: "proposal", scenario: "discussion" },
  });
  assert.match(slides[0], /linear-gradient\(135deg,rgba\(88,28,135,1\)/);
  assert.match(slides[1], /rgb\(255,255,255\)/);
});

test("contentAgent: 单页演示稿仅封面版式（无正文 rect 装饰）", () => {
  const slides = generateSlidesXmlArray({
    bundle: {
      rewrittenSlidesPlan: {
        slides: [{ title: "仅封面", bullets: ["要点一", "要点二", "要点三", "要点四"] }],
      },
    },
    text: "x",
    intent: { output_type: "ppt", doc_type: "report", ppt_type: "report", scenario: "discussion" },
  });
  assert.equal(slides.length, 1);
  assert.match(slides[0], /linear-gradient/);
  assert.doesNotMatch(slides[0], /type="rect"/);
});

test("contentAgent: 缺少 rewrittenSlidesPlan 时 PPT 生成应 fail-fast", () => {
  assert.throws(
    () =>
      generateSlidesXmlArray({
        bundle: { pptOutlineLines: ["背景与目标", "方案要点"] },
        text: "请生成评审PPT",
        intent: { output_type: "ppt", doc_type: "report", ppt_type: "review", scenario: "review" },
      }),
    /missing rewrittenSlidesPlan/i,
  );
});

