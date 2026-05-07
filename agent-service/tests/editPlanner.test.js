const test = require("node:test");
const assert = require("node:assert/strict");

const { buildEditPlan, buildEditPreview } = require("../src/editPlanner");

test("editPlanner: normalize doc replace plan", () => {
  const plan = buildEditPlan({
    input: "把 docx/abc 中里程碑改成下周一",
    intent: { output_type: "doc" },
    editIntent: {
      isEdit: true,
      target: "doc",
      operation: "UPDATE_BLOCK",
      selector: { anchorText: "里程碑" },
      payload: { to: "下周一" },
      confidence: 0.9,
      needsConfirm: false,
    },
  });
  assert.equal(plan.isEdit, true);
  assert.equal(plan.mode, "append");
  assert.equal(plan.needsConfirm, false);
});

test("editPlanner: maxChanges 恒为 1（不再用连接词启发式翻倍）", () => {
  const plan = buildEditPlan({
    input: "把第2页标题改了并且把第3页也替换",
    intent: { output_type: "ppt" },
    editIntent: {
      isEdit: true,
      target: "slides",
      operation: "UPDATE_BLOCK",
      selector: { pageIndex: 2 },
      payload: { title: "新标题" },
      confidence: 0.8,
      needsConfirm: false,
    },
  });
  assert.equal(plan.maxChanges, 1);
  assert.equal(plan.needsConfirm, false);
  assert.match(buildEditPreview(plan), /target=slides/);
});

