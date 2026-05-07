const test = require("node:test");
const assert = require("node:assert/strict");
const { extractImTextLines } = require("../server");

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

test("extractImTextLines: keeps text + transcribed audio", async () => {
  const oldFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ text: "请生成演示稿" }),
  });

  try {
    const lines = await withEnv(
      {
        FEISHU_VOICE_ENABLED: "true",
        FEISHU_VOICE_TRANSCRIBE_URL: "https://example.com/transcribe",
      },
      async () =>
        extractImTextLines({
          items: [
            {
              message_type: "text",
              content: JSON.stringify({ text: "先看下这次需求范围" }),
              create_time: 1,
            },
            {
              message_type: "audio",
              content: JSON.stringify({ file_key: "file_audio_1" }),
              create_time: 2,
            },
          ],
        }),
    );
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "先看下这次需求范围");
    assert.equal(lines[1], "请生成演示稿");
  } finally {
    global.fetch = oldFetch;
  }
});
