const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveDocTarget } = require("../src/orchestrator");

test("resolveDocTarget: 显式 docTarget 优先", () => {
  assert.equal(
    resolveDocTarget({
      docTarget: "https://x.example.com/docx/ZZtoken01",
      input: "仅编辑文字",
      contextSummary: "",
      recentMessages: [],
    }),
    "https://x.example.com/docx/ZZtoken01",
  );
});

test("resolveDocTarget: 从 recentMessages 解析 docx", () => {
  assert.equal(
    resolveDocTarget({
      input: "在待确认问题后插入：说明",
      contextSummary: "",
      recentMessages: ["请改纪要 https://feishu.cn/docx/Ab12Cd34"],
    }),
    "https://feishu.cn/docx/Ab12Cd34",
  );
});
