const test = require("node:test");
const assert = require("node:assert/strict");

const { parseIntent } = require("../src/intentParser");
const { parseEditIntent } = require("../src/editIntentParser");
const { applyLinkedEditTargetArtifacts } = require("../src/orchestrator");

test("linked edit: 仅 docx 链接且为编辑 -> targetArtifacts 只保留 doc", () => {
  const input = {
    input: "在 https://example.com/docx/abc 的待确认问题后面插入：新增风险：第三方限流",
    contextSummary: "",
    recentMessages: [],
    targetArtifacts: ["doc", "slides"],
  };
  applyLinkedEditTargetArtifacts(input, { parseIntent, parseEditIntent });
  assert.deepEqual(input.targetArtifacts, ["doc"]);
});

test("linked edit: 仅 slides 链接且为编辑 -> targetArtifacts 只保留 slides", () => {
  const input = {
    input: "把 https://example.com/slides/xyz 第2页标题改为阶段复盘",
    contextSummary: "",
    recentMessages: [],
    targetArtifacts: ["doc", "slides"],
  };
  applyLinkedEditTargetArtifacts(input, { parseIntent, parseEditIntent });
  assert.deepEqual(input.targetArtifacts, ["slides"]);
});

test("linked edit: 同时含 docx 与 slides 链接 -> 不改写 targetArtifacts", () => {
  const input = {
    input:
      "在 https://example.com/docx/aa 插入说明，并参考 https://example.com/slides/bb 第1页风格",
    contextSummary: "",
    recentMessages: [],
    targetArtifacts: ["doc", "slides"],
  };
  const before = [...input.targetArtifacts];
  applyLinkedEditTargetArtifacts(input, { parseIntent, parseEditIntent });
  assert.deepEqual(input.targetArtifacts, before);
});

test("linked edit: 非编辑指令 -> 不改写 targetArtifacts", () => {
  const input = {
    input: "请生成一版评审PPT，重点讲风险。文档链接 https://example.com/docx/abc 供参考",
    contextSummary: "",
    recentMessages: [],
    targetArtifacts: ["doc", "slides"],
  };
  const before = [...input.targetArtifacts];
  applyLinkedEditTargetArtifacts(input, { parseIntent, parseEditIntent });
  assert.deepEqual(input.targetArtifacts, before);
});

test("linked edit: 无链接的文档插入且未提演示稿 -> 去掉误配的 slides", () => {
  const input = {
    input: "在会议纪要（Agent）的“待确认问题”后面插入：新增风险：第三方接口限流；对策：增加本地队列与重试",
    contextSummary: "",
    recentMessages: [],
    targetArtifacts: ["doc", "slides"],
  };
  applyLinkedEditTargetArtifacts(input, { parseIntent, parseEditIntent });
  assert.deepEqual(input.targetArtifacts, ["doc"]);
});

test("linked edit: 文档插入但明确要求演示稿 -> 保留 doc+slides", () => {
  const input = {
    input: "在纪要待确认问题后插入风险说明，并生成一版评审演示稿",
    contextSummary: "",
    recentMessages: [],
    targetArtifacts: ["doc", "slides"],
  };
  const before = [...input.targetArtifacts];
  applyLinkedEditTargetArtifacts(input, { parseIntent, parseEditIntent });
  assert.deepEqual(input.targetArtifacts, before);
});
