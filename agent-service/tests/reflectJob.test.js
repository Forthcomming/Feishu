const test = require("node:test");
const assert = require("node:assert/strict");

const { recordFeedbackEvent, listExperienceCards } = require("../src/feedbackStore");
const { runReflectJob, toExperienceCards } = require("../src/reflectJob");

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

test("reflectJob: 事件可聚合为经验卡片", () => {
  const cards = toExperienceCards(
    [
      {
        type: "feedback.task_completed",
        state: "completed",
        confirms: { required: true },
        intent: { output_type: "doc", doc_type: "prd", ppt_type: "", scenario: "review" },
      },
      {
        type: "feedback.task_completed",
        state: "failed",
        confirms: { required: false },
        intent: { output_type: "doc", doc_type: "prd", ppt_type: "", scenario: "review" },
      },
    ],
    { conversationId: "c_ref" },
  );
  assert.ok(cards.length >= 1);
  assert.equal(cards[0].output_type, "doc");
  assert.equal(cards[0].doc_type, "prd");
});

test("reflectJob: 开启开关后写入经验库", async () => {
  recordFeedbackEvent({
    v: 1,
    type: "feedback.task_completed",
    taskId: "t_ref_1",
    conversationId: "c_ref_2",
    state: "completed",
    intent: { output_type: "doc", doc_type: "prd", ppt_type: "", scenario: "review" },
    confirms: { required: true },
    at: Date.now(),
  });

  await withEnv({ EXPERIENCE_REFLECT_ENABLED: "true", EXPERIENCE_SCOPE: "conversation" }, async () => {
    const r = await runReflectJob({ conversationId: "c_ref_2" });
    assert.equal(r.ok, true);
    const cards = listExperienceCards({ scope: "conversation", conversationId: "c_ref_2", limit: 20 });
    assert.ok(cards.length > 0);
  });
});
