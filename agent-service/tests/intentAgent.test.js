const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeIntent } = require("../src/intentAgent");

async function withEnv(temp, fn) {
  const old = {};
  const keys = Object.keys(temp || {});
  for (const k of keys) {
    old[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    process.env[k] = temp[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

function mockDoubaoResponse(payload) {
  return async () => ({
    ok: true,
    text: async () =>
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
  });
}

test("intentAgent: 强约束命中 -> rule_shortcut，不调 LLM", async () => {
  await withEnv(
    {
      DOUBAO_API_KEY: "x",
      DOUBAO_ENDPOINT_ID: "y",
    },
    async () => {
      let called = 0;
      const prevFetch = global.fetch;
      global.fetch = async () => {
        called += 1;
        return mockDoubaoResponse({
          output_type: "ppt",
          ppt_type: "review",
          doc_type: "report",
          scenario: "review",
          confidence: 0.9,
          reasoning: "llm",
        })();
      };
      try {
        const r = await analyzeIntent({ text: "请生成评审PPT", contextSummary: "", recentMessages: [] });
        assert.equal(r.decisionPath, "rule_shortcut");
        assert.equal(r.source, "rule_shortcut");
        assert.deepEqual(r.slots.targetArtifacts, ["slides"]);
        assert.equal(called, 0);
      } finally {
        global.fetch = prevFetch;
      }
    },
  );
});

test("intentAgent: 未命中强约束 -> 调用 LLM", async () => {
  await withEnv(
    {
      DOUBAO_API_KEY: "x",
      DOUBAO_ENDPOINT_ID: "y",
    },
    async () => {
      let called = 0;
      const prevFetch = global.fetch;
      global.fetch = async (...args) => {
        void args;
        called += 1;
        return mockDoubaoResponse({
          output_type: "doc",
          doc_type: "meeting_summary",
          ppt_type: "report",
          scenario: "discussion",
          confidence: 0.74,
          reasoning: "llm",
        })();
      };
      try {
        const r = await analyzeIntent({ text: "你好", contextSummary: "", recentMessages: [] });
        assert.equal(r.decisionPath, "llm");
        assert.equal(r.source, "llm");
        assert.equal(called, 1);
      } finally {
        global.fetch = prevFetch;
      }
    },
  );
});

test("intentAgent: LLM 失败 -> rule_fallback，needClarify=true", async () => {
  await withEnv(
    {
      DOUBAO_API_KEY: "x",
      DOUBAO_ENDPOINT_ID: "y",
    },
    async () => {
      let called = 0;
      const prevFetch = global.fetch;
      global.fetch = async () => {
        called += 1;
        throw new Error("network");
      };
      try {
        const r = await analyzeIntent({ text: "随便聊聊", contextSummary: "", recentMessages: [] });
        assert.equal(r.decisionPath, "rule_fallback");
        assert.equal(r.source, "rule_fallback");
        assert.equal(r.slots.needClarify, true);
        assert.ok(called >= 1, "llmChat 会重试，fetch 可能多次");
      } finally {
        global.fetch = prevFetch;
      }
    },
  );
});
