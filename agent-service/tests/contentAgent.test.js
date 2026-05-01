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

test("contentAgent: 可从 bundle 生成最小 slidesXmlArray", () => {
  const slides = generateSlidesXmlArray({
    bundle: {
      outlineMd: "## 评审演示稿大纲\n- 背景与目标\n- 方案要点\n- 风险与待确认\n- 里程碑与下一步",
      summaryMd: "## 摘要\n- 目标明确\n- 需要排期",
      requirementsMd: "## 需求\n- 支持飞书PPT",
      pptOutlineLines: ["背景与目标", "决策：采用A", "风险：兼容性", "行动项：排期"],
    },
    text: "请生成评审PPT",
    intent: { output_type: "ppt", doc_type: "report", ppt_type: "review", scenario: "review" },
  });
  assert.ok(Array.isArray(slides));
  assert.ok(slides.length > 0);
  assert.match(slides[0], /<slide\b/);
  assert.match(slides[0], /textType="title"/);
});

