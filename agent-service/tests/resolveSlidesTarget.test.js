const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveSlidesTarget } = require("../src/orchestrator");

test("resolveSlidesTarget: 显式 slidesTarget 优先", () => {
  assert.equal(
    resolveSlidesTarget({
      slidesTarget: "https://x.example.com/slides/ZZtoken01",
      input: "删除最后一页",
      contextSummary: "",
      recentMessages: [],
    }),
    "https://x.example.com/slides/ZZtoken01",
  );
});

test("resolveSlidesTarget: 从 contextSummary 解析 slides", () => {
  assert.equal(
    resolveSlidesTarget({
      input: "删除最后一页",
      contextSummary: "演示稿：https://feishu.cn/slides/Ab12Cd34",
      recentMessages: [],
    }),
    "https://feishu.cn/slides/Ab12Cd34",
  );
});
