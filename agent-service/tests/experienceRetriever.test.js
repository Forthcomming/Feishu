const test = require("node:test");
const assert = require("node:assert/strict");

const {
  recordExperienceCard,
} = require("../src/feedbackStore");
const { retrieveExperienceCards } = require("../src/experienceRetriever");

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars || {})) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

test("experienceRetriever: 注入开关关闭时返回空", async () => {
  await withEnv({ EXPERIENCE_INJECTION_ENABLED: "false" }, async () => {
    const out = await retrieveExperienceCards({
      conversationId: "c_1",
      intent: { output_type: "doc", doc_type: "prd", scenario: "review" },
    });
    assert.deepEqual(out, []);
  });
});

test("experienceRetriever: 维度匹配 + topK 生效", async () => {
  recordExperienceCard({
    scope: "conversation",
    conversationId: "c_match",
    output_type: "doc",
    doc_type: "prd",
    scenario: "review",
    when: "doc/prd/review",
    tips: ["先列风险再给行动项"],
    antiPatterns: [],
    confidence: 0.9,
    version: 1,
    updatedAt: Date.now(),
  });
  recordExperienceCard({
    scope: "conversation",
    conversationId: "c_match",
    output_type: "doc",
    doc_type: "meeting_summary",
    scenario: "discussion",
    when: "doc/meeting/discussion",
    tips: ["聚焦结论"],
    antiPatterns: [],
    confidence: 0.4,
    version: 1,
    updatedAt: Date.now(),
  });

  await withEnv(
    {
      EXPERIENCE_INJECTION_ENABLED: "true",
      EXPERIENCE_TOP_K: "1",
      EXPERIENCE_SCOPE: "conversation",
    },
    async () => {
      const out = await retrieveExperienceCards({
        conversationId: "c_match",
        intent: { output_type: "doc", doc_type: "prd", scenario: "review" },
      });
      assert.equal(out.length, 1);
      assert.match(String(out[0].when || ""), /doc\/prd\/review/);
    },
  );
});
