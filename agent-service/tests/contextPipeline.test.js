const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildContextFromLines,
  rerankPickLines,
  readRerankTopK,
} = require("../src/contextPipeline");

function withEnv(temp, fn) {
  const old = {};
  const keys = Object.keys(temp || {});
  for (const k of keys) {
    old[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    process.env[k] = temp[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

test("readRerankTopK clamps to 5–8", () => {
  withEnv({ CONTEXT_RERANK_TOP_K: "4" }, () => assert.equal(readRerankTopK(), 5));
  withEnv({ CONTEXT_RERANK_TOP_K: "12" }, () => assert.equal(readRerankTopK(), 8));
  withEnv({ CONTEXT_RERANK_TOP_K: "7" }, () => assert.equal(readRerankTopK(), 7));
  withEnv({}, () => assert.equal(readRerankTopK(), 6));
});

test("rerankPickLines: trigger 与少量句子重叠则入选；topMessages 按时间序", () => {
  const noise = Array.from({ length: 15 }, (_, i) => `闲聊${i}吃饭天气`);
  const keyA = "本项目要做登录模块需求文档评审";
  const keyB = "下一步请张三整理 PRD 发给业务";
  const keyC = "是否周三前交付";
  const lines = [...noise.slice(0, 5), keyA, ...noise.slice(5, 10), keyB, keyC, ...noise.slice(10, 15)];
  const trigger = "生成需求文档";
  const picked = rerankPickLines(lines, trigger, 6);
  assert.ok(picked.includes(keyA));
  assert.ok(picked.includes(keyB));
  assert.ok(picked.length <= 6);
  // 时间序：在 picked 中的索引应递增
  const indices = picked.map((p) => lines.indexOf(p));
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] > indices[i - 1]);
  }
});

test("buildContextFromLines: 输出含结构化小节且选用原文条数等于 topMessages", () => {
  const lines = ["决定了本周上线", "TODO 补接口文档", "晚上吃什么", "要不要延期"];
  const { structuredContext, topMessages } = buildContextFromLines(lines, "接口文档", { topK: 5 });
  assert.ok(structuredContext.includes("## 结构化上下文"));
  assert.ok(structuredContext.includes("### 决策/结论"));
  assert.ok(structuredContext.includes("### 待确认"));
  assert.ok(structuredContext.includes("### 行动项"));
  assert.ok(structuredContext.includes("### 选用原文（Top-K，按时间序）"));
  assert.equal(topMessages.length, Math.min(5, lines.length));
  const quoteSection = structuredContext.split("### 选用原文（Top-K，按时间序）")[1] || "";
  const quoteLines = quoteSection.split("\n").filter((l) => l.startsWith(">"));
  assert.equal(quoteLines.length, topMessages.length);
});

test("buildContextFromLines: lines 少于 K 则全取", () => {
  const lines = ["a", "b", "c"];
  const { topMessages } = buildContextFromLines(lines, "", { topK: 8 });
  assert.deepEqual(topMessages, lines);
});
