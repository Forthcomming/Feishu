const test = require("node:test");
const assert = require("node:assert/strict");
const { parseIntentStub } = require("../src/intentParser");

test("需求文档 + 总结 -> generate_requirements_doc", () => {
  const input =
    "帮我生成PRD需求文档，并整理需求要点，最后给出关键结论与总结。是否需要确认？";
  const result = parseIntentStub({ input });

  assert.equal(result.intent.name, "generate_requirements_doc");
  assert.ok(Array.isArray(result.slots.outputKinds));
  assert.ok(result.slots.outputKinds.includes("doc"));
  assert.ok(result.slots.outputKinds.includes("summary"));
  assert.equal(result.slots.documentKind, "requirements");
  assert.equal(result.slots.wantsUserConfirm, true);

  assert.ok(Array.isArray(result.entities));
  assert.ok(result.entities.some((e) => e.type === "documentKind" && e.value === "requirements"));
  assert.ok(result.entities.some((e) => e.type === "conclusion" && e.value === true));
});

test("评审PPT + 演示 -> generate_review_ppt", () => {
  const input = "请生成一版评审PPT并做汇报演示";
  const result = parseIntentStub({ input });

  assert.equal(result.intent.name, "generate_review_ppt");
  assert.ok(result.slots.outputKinds.includes("ppt"));
  assert.equal(result.slots.pptKind, "review");
  assert.deepEqual(result.slots.wantsUserConfirm, false);
});

test("无关键词 -> unknown", () => {
  const input = "你好，今天怎么样？";
  const result = parseIntentStub({ input });

  assert.equal(result.intent.name, "unknown");
  assert.deepEqual(result.slots.outputKinds, ["unknown"]);
  assert.equal(result.entities.length, 0);
});

