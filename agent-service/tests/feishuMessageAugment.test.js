const test = require("node:test");
const assert = require("node:assert/strict");

const { augmentFeishuTextMessageForAgent, collectEmbeddedCloudRefsFromLarkRaw } = require("../server");

test("collectEmbeddedCloudRefs: 从 post 超链接 href 取出 docx", () => {
  const raw = JSON.stringify({
    zh_cn: {
      content: [
        [
          { tag: "text", text: "请改这篇" },
          {
            tag: "a",
            text: "会议纪要（Agent）",
            href: "https://bytedance.feishu.cn/docx/AbCdEfGh12",
          },
        ],
      ],
    },
  });
  const refs = collectEmbeddedCloudRefsFromLarkRaw(raw);
  assert.ok(refs.includes("https://bytedance.feishu.cn/docx/AbCdEfGh12"));
});

test("augmentFeishuTextMessageForAgent: 展示名 + 换行附加真实 URL", () => {
  const raw = JSON.stringify({
    zh_cn: {
      content: [
        [
          { tag: "text", text: "在待确认问题后插入" },
          {
            tag: "a",
            text: "项目纪要",
            href: "https://x.feishu.cn/docx/Token01ab",
          },
        ],
      ],
    },
  });
  const out = augmentFeishuTextMessageForAgent(raw);
  assert.match(out, /在待确认问题后插入/);
  assert.match(out, /https:\/\/x\.feishu\.cn\/docx\/Token01ab/);
});

test("augmentFeishuTextMessageForAgent: 纯 text 消息保持兼容", () => {
  const raw = JSON.stringify({ text: "hello" });
  assert.equal(augmentFeishuTextMessageForAgent(raw), "hello");
});
