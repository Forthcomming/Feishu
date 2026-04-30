const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDocsCreateArgs, buildImMessagesSendArgs } = require("../src/larkCliCommands");

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
  const contentIndex = args.indexOf("--content");
  assert.ok(contentIndex > 0);
  const content = args[contentIndex + 1];
  assert.ok(content.startsWith("<title>Weekly</title>\n"));
  assert.ok(content.includes("# Hi"));
  assert.ok(args.includes("--dry-run"));
});

test("buildDocsCreateArgs: escape title xml chars", () => {
  const args = buildDocsCreateArgs({ title: "A&B<C>", markdown: "# x", dryRun: false });
  const content = args[args.indexOf("--content") + 1];
  assert.ok(content.startsWith("<title>A&amp;B&lt;C&gt;</title>\n"));
  assert.ok(!args.includes("--dry-run"));
});

