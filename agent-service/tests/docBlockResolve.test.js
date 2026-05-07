const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findBlockIdForAnchorText,
  expandAnchorCandidates,
  escapeRegExpLiteral,
  parseDocsUpdateSuccess,
} = require("../src/docBlockResolve");

test("escapeRegExpLiteral: escapes meta chars", () => {
  assert.equal(escapeRegExpLiteral("a+b"), "a\\+b");
});

test("findBlockIdForAnchorText: reads block_id from JSON snippet", () => {
  const stdout = JSON.stringify({
    blocks: [{ block_id: "blkcnAbCdEfGh12", text: "里程碑完成" }],
  });
  const id = findBlockIdForAnchorText(stdout, "里程碑", (s) => ({ ok: true, value: JSON.parse(s) }));
  assert.equal(id, "blkcnAbCdEfGh12");
});

test("findBlockIdForAnchorText: block_id on parent, anchor text nested (xml-like)", () => {
  const stdout = JSON.stringify({
    document: {
      block_id: "blkParent01",
      elements: [{ type: "text", text_run: { content: "第一节\n目标说明" } }],
    },
  });
  const id = findBlockIdForAnchorText(stdout, "目标说明", (s) => ({ ok: true, value: JSON.parse(s) }));
  assert.equal(id, "blkParent01");
});

test("findBlockIdForAnchorText: prefers smallest matching subtree (not only deepest)", () => {
  const stdout = JSON.stringify({
    block_id: "outer",
    children: [
      {
        block_id: "innerBlk99",
        text: "唯一一句",
      },
    ],
  });
  const id = findBlockIdForAnchorText(stdout, "唯一一句", (s) => ({ ok: true, value: JSON.parse(s) }));
  assert.equal(id, "innerBlk99");
});

test("findBlockIdForAnchorText: anchor variant with Chinese colon after short title", () => {
  const stdout = JSON.stringify({
    blocks: [{ block_id: "blkTbd01", text: "待确认问题" }],
  });
  const id = findBlockIdForAnchorText(stdout, "待确认问题", (s) => ({ ok: true, value: JSON.parse(s) }));
  assert.equal(id, "blkTbd01");
});

test("expandAnchorCandidates: includes colon suffix variants", () => {
  const v = expandAnchorCandidates("待确认问题");
  assert.ok(v.includes("待确认问题"));
  assert.ok(v.some((x) => x === "待确认问题：" || x === "待确认问题:"));
});

test("findBlockIdForAnchorText: fuzzy picks block when anchor differs slightly from stdout text", () => {
  const stdout = JSON.stringify({
    blocks: [
      { block_id: "blkNoise01", text: "无关段落占位无关段落占位无关段落" },
      {
        block_id: "blkTarget02",
        text:
          "三方翻译接口 Token 成本超支的具体原因?是否有明确的降本方案与排期",
      },
    ],
  });
  const anchor = "三方翻译接口 Token 成本超支的具体原因？是否有明确的降本方案与排期？";
  const id = findBlockIdForAnchorText(stdout, anchor, (s) => ({ ok: true, value: JSON.parse(s) }));
  assert.equal(id, "blkTarget02");
});

test("findBlockIdForAnchorText: XML tags split sentence still matches (non-JSON stdout)", () => {
  const stdout = [
    `stuff block_id="blkXmlSplit01" more`,
    `<t>三方翻译接口</t>`,
    `<t> Token 成本超支的具体原因？是否有明确的降本方案与排期？</t>`,
  ].join("");
  const anchor = "三方翻译接口 Token 成本超支的具体原因？是否有明确的降本方案与排期？";
  const id = findBlockIdForAnchorText(stdout, anchor, () => ({ ok: false }));
  assert.equal(id, "blkXmlSplit01");
});

test("findBlockIdForAnchorText: whitespace-normalized match", () => {
  const stdout = JSON.stringify({
    blocks: [{ block_id: "blkWs01", text: "A  B\nC" }],
  });
  const id = findBlockIdForAnchorText(stdout, "A B C", (s) => ({ ok: true, value: JSON.parse(s) }));
  assert.equal(id, "blkWs01");
});

test("findBlockIdForAnchorText: raw string fallback, block_id before anchor", () => {
  const stdout = `prefix block_id="blkRawXy12" tail more text 锚点句子 end`;
  const id = findBlockIdForAnchorText(stdout, "锚点句子", () => ({ ok: false }));
  assert.equal(id, "blkRawXy12");
});

test("findBlockIdForAnchorText: XML numeric entities in text match plain anchor", () => {
  const stdout = JSON.stringify({
    blocks: [{ block_id: "blkEnt01", text: "&#24453;&#30830;&#35748;&#38382;&#39064;" }],
  });
  const id = findBlockIdForAnchorText(stdout, "待确认问题", (s) => ({ ok: true, value: JSON.parse(s) }));
  assert.equal(id, "blkEnt01");
});

test("findBlockIdForAnchorText: block-id= kebab attribute in raw XML", () => {
  const stdout = `<root><para block-id="blkKebab99">锚点在此</para></root>`;
  const id = findBlockIdForAnchorText(stdout, "锚点在此", () => ({ ok: false }));
  assert.equal(id, "blkKebab99");
});

test("parseDocsUpdateSuccess: failed result", () => {
  const tryParseJson = (s) => ({ ok: true, value: JSON.parse(s) });
  assert.equal(parseDocsUpdateSuccess(JSON.stringify({ data: { result: "failed" } }), tryParseJson), false);
  assert.equal(
    parseDocsUpdateSuccess(JSON.stringify({ ok: true, data: { result: "success", updated_blocks_count: 1 } }), tryParseJson),
    true,
  );
});

test("parseDocsUpdateSuccess: zero updated_blocks_count", () => {
  const tryParseJson = (s) => ({ ok: true, value: JSON.parse(s) });
  assert.equal(parseDocsUpdateSuccess(JSON.stringify({ data: { result: "success", updated_blocks_count: 0 } }), tryParseJson), false);
});
