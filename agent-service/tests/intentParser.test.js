const test = require("node:test");
const assert = require("node:assert/strict");
const { parseIntent } = require("../src/intentParser");

test("产品讨论 + 整理一下 -> doc/prd", () => {
  const input = "我们在讨论产品需求，帮我整理一下 PRD，包含目标、范围和里程碑。";
  const result = parseIntent(input, {});
  assert.equal(result.output_type, "doc");
  assert.equal(result.doc_type, "prd");
});

test("评审场景 + 明确PPT -> ppt/review", () => {
  const input = "请生成一版评审PPT并做汇报演示，重点讲目标、结论和风险。";
  const result = parseIntent(input, {});
  assert.equal(result.output_type, "ppt");
  assert.equal(result.ppt_type, "review");
});

test("包含 slides 链接 -> 强制 ppt", () => {
  const input = "帮我把 https://example.com/slides/xyz 第2页替换成最新结论";
  const result = parseIntent(input, {});
  assert.equal(result.output_type, "ppt");
});

test("信息不足 -> fallback meeting_summary 且稳定", () => {
  const input = "整理一下";
  const result = parseIntent(input, {});
  assert.equal(result.output_type, "doc");
  assert.equal(result.doc_type, "meeting_summary");
  assert.ok(typeof result.reasoning === "string" && result.reasoning.length > 0);
});

test("明确需求文档，即使技术上下文也应为 prd", () => {
  const input = "请把最近讨论整理成需求文档，包含背景/目标/范围/里程碑。";
  const result = parseIntent(input, {
    contextSummary: "技术方案讨论：接口拆分、性能瓶颈、重构路线",
    recentMessages: ["架构改造要分阶段", "接口要兼容旧版本", "性能压测要做"],
  });
  assert.equal(result.output_type, "doc");
  assert.equal(result.doc_type, "prd");
});

test("显式类型词命中信号: ppt", () => {
  const result = parseIntent("请生成评审PPT", {});
  assert.equal(result.meta.explicitTypeHit, true);
  assert.equal(result.meta.explicitTypeKind, "ppt");
});

test("显式类型词命中信号: none", () => {
  const result = parseIntent("整理一下刚才聊的", {});
  assert.equal(result.meta.explicitTypeHit, false);
  assert.equal(result.meta.explicitTypeKind, "none");
});

test("否定 PPT -> doc，且不作为强约束短路", () => {
  const result = parseIntent("不要 PPT，整理成文档", {});
  assert.equal(result.output_type, "doc");
  assert.equal(result.meta.negatedPpt, true);
  assert.equal(result.meta.explicitTypeHit, false);
});

