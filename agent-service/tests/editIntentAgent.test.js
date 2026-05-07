const test = require("node:test");
const assert = require("node:assert/strict");

const editIntentAgent = require("../src/editIntentAgent");
const { mapLlmJsonToEditIntent, resolveEditIntentHybrid } = editIntentAgent;
const { mergeEditIntentSource, editInstructionText } = require("../src/editIntentSource");

test("mapLlmJsonToEditIntent: slides 删除最后一页", () => {
  const out = mapLlmJsonToEditIntent({
    is_edit: true,
    target: "slides",
    operation: "delete",
    selector: { anchor_text: "", page_index: null, last_page: true, bullet_index: null },
    payload: { from: "", to: "", content: "", title: "", max_bullets: null },
    confidence: 0.9,
    reasoning: "",
  });
  assert.equal(out.isEdit, true);
  assert.equal(out.operation, "DELETE_BLOCK");
  assert.equal(out.selector.lastPage, true);
  assert.equal(out.needsConfirm, false);
});

test("resolveEditIntentHybrid: EDIT_INTENT_LLM_ENABLED=false 时走规则且不强行加确认", async (t) => {
  t.after(() => {
    delete process.env.EDIT_INTENT_LLM_ENABLED;
  });
  process.env.EDIT_INTENT_LLM_ENABLED = "false";
  const input = {
    input: "删除 https://example.com/slides/xyz 最后一页",
    contextSummary: "",
    recentMessages: [],
  };
  const { editIntent, source } = await resolveEditIntentHybrid(input, {
    intent: { output_type: "ppt" },
    parseEditIntent: require("../src/editIntentParser").parseEditIntent,
  });
  assert.equal(source, "rule");
  assert.equal(editIntent.isEdit, true);
  assert.equal(editIntent.operation, "DELETE_BLOCK");
  assert.equal(editIntent.needsConfirm, false);
});

test("mergeEditIntentSource: 合并 input 与 context", () => {
  const s = mergeEditIntentSource({
    input: "删除最后一页",
    contextSummary: "slides https://feishu.cn/slides/AAA",
    recentMessages: [],
  });
  assert.ok(s.includes("删除最后一页"));
  assert.ok(!s.includes("slides https://feishu.cn/slides/AAA"));
});

test("mergeEditIntentSource: 显式引用上文时合并 context", () => {
  const s = mergeEditIntentSource({
    input: "基于上文继续修改最后一页",
    contextSummary: "slides https://feishu.cn/slides/AAA",
    recentMessages: ["上一次动作：删除第3页"],
  });
  assert.ok(s.includes("基于上文继续修改最后一页"));
  assert.ok(s.includes("slides https://feishu.cn/slides/AAA"));
});

test("mergeEditIntentSource: 附带 docTarget / slidesTarget 供定位与 LLM 同源", () => {
  const s = mergeEditIntentSource({
    input: "把第二页标题改掉",
    contextSummary: "",
    recentMessages: [],
    slidesTarget: "https://x.feishu.cn/slides/Token_ab-1",
  });
  assert.ok(s.includes("把第二页标题改掉"));
  assert.ok(s.includes("https://x.feishu.cn/slides/Token_ab-1"));
});

test("editInstructionText: 忽略 contextSummary 与 recentMessages", () => {
  const s = editInstructionText({
    input: "把第2页标题改掉",
    contextSummary: "删掉最后一页 https://feishu.cn/slides/AAA",
    recentMessages: ["无关"],
    slidesTarget: "https://x.feishu.cn/slides/Tok",
  });
  assert.ok(s.includes("把第2页标题改掉"));
  assert.ok(s.includes("slides/Tok"));
  assert.ok(!s.includes("删掉最后一页"));
});

test("mapLlmJsonToEditIntent: needs_confirm 显式 true 生效", () => {
  const out = mapLlmJsonToEditIntent({
    is_edit: true,
    target: "slides",
    operation: "DELETE_BLOCK",
    selector: { last_page: true },
    payload: {},
    confidence: 0.95,
    needs_confirm: true,
    reasoning: "",
  });
  assert.equal(out.needsConfirm, true);
});
