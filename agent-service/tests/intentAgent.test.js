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

test("intentAgent: Fast Path (>=0.8) 走规则，不调用LLM", async () => {
  await withEnv(
    {
      DOUBAO_API_KEY: "x",
      DOUBAO_ENDPOINT_ID: "y",
      INTENT_FAST_THRESHOLD: "0.8",
      INTENT_SLOW_THRESHOLD: "0.6",
    },
    async () => {
      let called = 0;
      const prevFetch = global.fetch;
      global.fetch = async () => {
        called += 1;
        return mockDoubaoResponse({ output_type: "ppt", ppt_type: "review", doc_type: "report", scenario: "review", confidence: 0.9, reasoning: "llm" })();
      };
      try {
        const r = await analyzeIntent({ text: "请生成评审PPT", contextSummary: "", recentMessages: [] });
        assert.equal(r.decisionPath, "fast");
        assert.equal(r.source, "rule");
        assert.deepEqual(r.slots.targetArtifacts, ["slides"]);
        assert.equal(called, 0);
      } finally {
        global.fetch = prevFetch;
      }
    },
  );
});

test("intentAgent: Slow Path (<0.6) 调用LLM", async () => {
  await withEnv(
    {
      DOUBAO_API_KEY: "x",
      DOUBAO_ENDPOINT_ID: "y",
      INTENT_FAST_THRESHOLD: "0.8",
      INTENT_SLOW_THRESHOLD: "0.6",
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
        assert.equal(r.decisionPath, "slow");
        assert.equal(r.source, "llm");
        assert.equal(called, 1);
      } finally {
        global.fetch = prevFetch;
      }
    },
  );
});

test("intentAgent: Hybrid 区间有显式类型词 -> 走规则", async () => {
  await withEnv(
    {
      DOUBAO_API_KEY: "x",
      DOUBAO_ENDPOINT_ID: "y",
      INTENT_FAST_THRESHOLD: "0.99",
      INTENT_SLOW_THRESHOLD: "0.9",
    },
    async () => {
      let called = 0;
      const prevFetch = global.fetch;
      global.fetch = async () => {
        called += 1;
        return mockDoubaoResponse({ output_type: "doc", doc_type: "solution", ppt_type: "report", scenario: "discussion", confidence: 0.7, reasoning: "llm" })();
      };
      try {
        const r = await analyzeIntent({ text: "整理成需求文档", contextSummary: "", recentMessages: [] });
        assert.equal(r.decisionPath, "hybrid_fast");
        assert.equal(r.source, "rule");
        assert.equal(r.slots.parseIntentV2.doc_type, "prd");
        assert.equal(called, 0);
      } finally {
        global.fetch = prevFetch;
      }
    },
  );
});

test("intentAgent: Hybrid 区间无显式类型词 -> 调用LLM", async () => {
  await withEnv(
    {
      DOUBAO_API_KEY: "x",
      DOUBAO_ENDPOINT_ID: "y",
      INTENT_FAST_THRESHOLD: "0.99",
      INTENT_SLOW_THRESHOLD: "0.9",
    },
    async () => {
      let called = 0;
      const prevFetch = global.fetch;
      global.fetch = async () => {
        called += 1;
        return mockDoubaoResponse({
          output_type: "doc",
          doc_type: "meeting_summary",
          ppt_type: "report",
          scenario: "discussion",
          confidence: 0.71,
          reasoning: "llm",
        })();
      };
      try {
        const r = await analyzeIntent({ text: "整理一下刚才聊的需求", contextSummary: "", recentMessages: [] });
        assert.equal(r.decisionPath, "hybrid_slow");
        assert.equal(r.source, "llm");
        assert.equal(called, 1);
      } finally {
        global.fetch = prevFetch;
      }
    },
  );
});

