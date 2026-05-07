const test = require("node:test");
const assert = require("node:assert/strict");
const { isAudioMessageType, transcribeFeishuAudioMessage } = require("../src/voiceTranscriber");

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

test("isAudioMessageType: supports audio/voice", () => {
  assert.equal(isAudioMessageType("audio"), true);
  assert.equal(isAudioMessageType("voice"), true);
  assert.equal(isAudioMessageType("Audio"), true);
  assert.equal(isAudioMessageType("text"), false);
});

test("transcribeFeishuAudioMessage: use transcript text in content first", async () => {
  const res = await withEnv({ FEISHU_VOICE_ENABLED: "false" }, async () =>
    transcribeFeishuAudioMessage({
      message_type: "audio",
      content: JSON.stringify({ recognized_text: "请生成需求文档" }),
    }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.text, "请生成需求文档");
});

test("transcribeFeishuAudioMessage: disabled returns safe failure", async () => {
  const res = await withEnv({ FEISHU_VOICE_ENABLED: "false" }, async () =>
    transcribeFeishuAudioMessage({
      message_type: "audio",
      content: JSON.stringify({ file_key: "file_xxx" }),
    }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "voice_disabled");
});

test("transcribeFeishuAudioMessage: transcribe by endpoint", async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: { text: "请输出周报" } }),
  });
  const res = await withEnv(
    {
      FEISHU_VOICE_ENABLED: "true",
      FEISHU_VOICE_TRANSCRIBE_URL: "https://example.com/transcribe",
      FEISHU_VOICE_TIMEOUT_MS: "5000",
    },
    async () =>
      transcribeFeishuAudioMessage(
        {
          message_type: "audio",
          content: JSON.stringify({ file_key: "file_xxx" }),
        },
        { fetchImpl: fakeFetch },
      ),
  );
  assert.equal(res.ok, true);
  assert.equal(res.text, "请输出周报");
});
