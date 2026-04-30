const test = require("node:test");
const assert = require("node:assert/strict");

const { generateContentBundle } = require("../src/contentAgent");

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

