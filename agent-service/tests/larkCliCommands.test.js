const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDocsCreateArgs,
  buildDocsUpdateArgs,
  buildDocsFetchArgs,
  buildImMessagesSendArgs,
  buildSlidesCreateArgs,
} = require("../src/larkCliCommands");

test("buildImMessagesSendArgs: default dry-run + bot identity", () => {
  const args = buildImMessagesSendArgs({ chatId: "oc_xxx", text: "Hello" });
  assert.equal(args[0], "im");
  assert.ok(args.includes("--dry-run"));
  assert.deepEqual(
    args.slice(0, 8),
    ["im", "+messages-send", "--as", "bot", "--chat-id", "oc_xxx", "--text", "Hello"],
  );
});

test("buildDocsCreateArgs: content includes title + markdown", () => {
  const args = buildDocsCreateArgs({ title: "Weekly", markdown: "# Hi\n- A" });
  // default apiVersion is v2
  assert.ok(args.includes("--doc-format"));
  assert.ok(args.includes("markdown"));
  const mdIndex = args.indexOf("--content");
  assert.ok(mdIndex > 0);
  const md = args[mdIndex + 1];
  assert.equal(md, "-");
  assert.ok(args.includes("--dry-run"));
});

test("buildDocsCreateArgs: prepend heading when markdown doesn't start with heading", () => {
  const args = buildDocsCreateArgs({ title: "A&B<C>", markdown: "hello", dryRun: false });
  const md = args[args.indexOf("--content") + 1];
  assert.equal(md, "-");
  assert.ok(!args.includes("--dry-run"));
});

test("buildDocsCreateArgs: apiVersion v1 uses --title + --markdown", () => {
  const args = buildDocsCreateArgs({ title: "T", markdown: "hello", apiVersion: "v1", dryRun: true, as: "user" });
  assert.ok(args.includes("--title"));
  assert.ok(args.includes("T"));
  assert.ok(args.includes("--markdown"));
  assert.ok(!args.includes("--content"));
});

test("buildDocsUpdateArgs: apiVersion v2 + append mode uses --doc + stdin content", () => {
  const args = buildDocsUpdateArgs({
    as: "user",
    doc: "https://example.com/docx/abc",
    markdown: "# Update\n- A",
    mode: "append",
    apiVersion: "v2",
    dryRun: false,
  });
  assert.deepEqual(args.slice(0, 2), ["docs", "+update"]);
  assert.ok(args.includes("--api-version"));
  assert.ok(args.includes("v2"));
  assert.ok(args.includes("--doc"));
  assert.ok(args.includes("https://example.com/docx/abc"));
  assert.ok(args.includes("--command"));
  assert.ok(args.includes("append"));
  assert.ok(args.includes("--content"));
  assert.ok(args.includes("-"));
  assert.ok(!args.includes("--dry-run"));
});

test("buildDocsUpdateArgs: v2 block_replace includes block-id and markdown format", () => {
  const args = buildDocsUpdateArgs({
    as: "user",
    doc: "docx/abc",
    markdown: "新文案",
    command: "block_replace",
    blockId: "blkcn_1",
    docFormat: "markdown",
    apiVersion: "v2",
    dryRun: false,
  });
  assert.ok(args.includes("block_replace"));
  assert.ok(args.includes("--block-id"));
  assert.ok(args.includes("blkcn_1"));
  assert.ok(args.includes("markdown"));
});

test("buildDocsUpdateArgs: block_delete has block-id and no content flag", () => {
  const args = buildDocsUpdateArgs({
    as: "user",
    doc: "docx/abc",
    markdown: "",
    command: "block_delete",
    blockId: "blkcn_test123",
    apiVersion: "v2",
    dryRun: true,
  });
  assert.ok(args.includes("block_delete"));
  assert.ok(args.includes("blkcn_test123"));
  assert.ok(!args.includes("--content"));
});

test("buildDocsFetchArgs: keyword scope + with-ids（须配合 xml，与 lark-cli 校验一致）", () => {
  const args = buildDocsFetchArgs({
    as: "user",
    doc: "https://example.com/docx/abc",
    apiVersion: "v2",
    detail: "with-ids",
    scope: "keyword",
    keyword: "里程碑",
    docFormat: "xml",
    dryRun: false,
  });
  assert.deepEqual(args.slice(0, 3), ["docs", "+fetch", "--as"]);
  assert.ok(args.includes("--detail"));
  assert.ok(args.includes("with-ids"));
  assert.ok(args.includes("--scope"));
  assert.ok(args.includes("keyword"));
  assert.ok(args.includes("里程碑"));
  assert.ok(args.includes("xml"));
});

test("buildSlidesCreateArgs: 支持传入 slidesXmlArray", () => {
  const args = buildSlidesCreateArgs({
    as: "bot",
    title: "评审演示稿",
    slidesXmlArray: ["<slide><title>A</title><body><ul><li>1</li></ul></body></slide>"],
    dryRun: false,
  });
  assert.equal(args[0], "slides");
  assert.equal(args[1], "+create");
  assert.ok(args.includes("--slides"));
  const serialized = args[args.indexOf("--slides") + 1];
  const parsed = JSON.parse(serialized);
  assert.ok(Array.isArray(parsed) && parsed.length === 1);
  assert.ok(!args.includes("--dry-run"));
});

