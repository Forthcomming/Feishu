const test = require("node:test");
const assert = require("node:assert/strict");

const { generateContentBundle, generateSlidesXmlArray } = require("../src/contentAgent");

test("contentAgent: 无 Doubao 时也能生成完整 markdown bundle", async () => {
  const b = await generateContentBundle({
    text: "我们要做一个需求文档。需要确认权限与范围。下一步请给出里程碑。",
    contextSummary: "关键要点：做文档；待确认：权限；行动项：里程碑。",
    targetArtifacts: ["doc"],
  });
  assert.ok(b);
  assert.ok(typeof b.summaryMd === "string" && b.summaryMd.includes("上下文摘要"));
  assert.ok(typeof b.requirementsMd === "string" && b.requirementsMd.includes("需求点"));
  assert.ok(typeof b.clarifyMd === "string" && b.clarifyMd.includes("待确认问题"));
  assert.ok(typeof b.outlineMd === "string" && b.outlineMd.includes("结构大纲"));
});

test("contentAgent: 可从 bundle 生成最小 slidesXmlArray", () => {
  const slides = generateSlidesXmlArray({
    bundle: {
      outlineMd: "## 评审演示稿大纲\n- 背景与目标\n- 方案要点\n- 风险与待确认\n- 里程碑与下一步",
      summaryMd: "## 摘要\n- 目标明确\n- 需要排期",
      requirementsMd: "## 需求\n- 支持飞书PPT",
    },
    text: "请生成评审PPT",
  });
  assert.ok(Array.isArray(slides));
  assert.ok(slides.length > 0);
  assert.match(slides[0], /<slide\b/);
  assert.match(slides[0], /textType="title"/);
});

