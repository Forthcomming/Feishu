const test = require("node:test");
const assert = require("node:assert/strict");

const { tryParseJson: tryParseJsonLenient } = require("../src/larkCliRunner");
const { extractSlideIdsFromCliOutput, parseSlideReplaceSucceeded } = require("../src/orchestrator");

const tryParseJson = (s) => {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false, value: null };
  }
};

test("extractSlideIdsFromCliOutput: data.slides 数组顺序为准（最后一页即数组最后一项）", () => {
  const stdout = JSON.stringify({
    code: 0,
    data: {
      slides: [{ slide_id: "first" }, { slide_id: "mid" }, { slide_id: "last_slide" }],
    },
  });
  const ids = extractSlideIdsFromCliOutput(stdout, tryParseJson);
  assert.deepEqual(ids, ["first", "mid", "last_slide"]);
});

test("extractSlideIdsFromCliOutput: DFS 回退时仍可解析（顺序不保）", () => {
  const stdout = JSON.stringify({ misc: { nested: { slide_id: "only_one" } } });
  const ids = extractSlideIdsFromCliOutput(stdout, tryParseJson);
  assert.deepEqual(ids, ["only_one"]);
});

test("extractSlideIdsFromCliOutput: data.xml_presentation.content 内嵌整册 XML", () => {
  const stdout = JSON.stringify({
    code: 0,
    data: {
      xml_presentation: {
        content:
          '<presentation><slide slide_id="em_a1"></slide><slide slide_id="em_b2"></slide></presentation>',
      },
    },
  });
  const ids = extractSlideIdsFromCliOutput(stdout, tryParseJson);
  assert.deepEqual(ids, ["em_a1", "em_b2"]);
});

test("extractSlideIdsFromCliOutput: 前缀日志 + JSON（larkCliRunner 宽松解析）", () => {
  const inner = {
    code: 0,
    data: {
      xml_presentation: {
        content: '<presentation><slide slide_id="p1"/><slide slide_id="p2"/></presentation>',
      },
    },
  };
  const stdout = `time=2026-01-01T00:00:00Z level=info\n${JSON.stringify(inner)}`;
  const ids = extractSlideIdsFromCliOutput(stdout, tryParseJsonLenient);
  assert.deepEqual(ids, ["p1", "p2"]);
});

test("parseSlideReplaceSucceeded: 有内容但非 JSON 视为失败", () => {
  assert.equal(parseSlideReplaceSucceeded("not json {{{", tryParseJson), false);
});

test("parseSlideReplaceSucceeded: 空 stdout 视为失败（避免跳过整页替换）", () => {
  assert.equal(parseSlideReplaceSucceeded("", tryParseJson), false);
  assert.equal(parseSlideReplaceSucceeded("  \n", tryParseJson), false);
});

test("parseSlideReplaceSucceeded: 显式 ok/code=0 且无 failed_reason 为成功", () => {
  assert.equal(parseSlideReplaceSucceeded(JSON.stringify({ ok: true }), tryParseJson), true);
  assert.equal(parseSlideReplaceSucceeded(JSON.stringify({ code: 0 }), tryParseJson), true);
  assert.equal(parseSlideReplaceSucceeded(JSON.stringify({ data: { code: 0 } }), tryParseJson), true);
});

test("parseSlideReplaceSucceeded: 空对象 {} 视为失败（避免误判跳过整页替换）", () => {
  assert.equal(parseSlideReplaceSucceeded(JSON.stringify({}), tryParseJson), false);
});
