const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildTaskCompletedFeedback,
  buildUserRatingFeedback,
  publishFeedbackEvent,
  FEEDBACK_SCHEMA_VERSION,
} = require("../src/feedback");

test("buildTaskCompletedFeedback: 字段齐全且不含原文", () => {
  const startedAt = Date.now() - 1234;
  const event = buildTaskCompletedFeedback({
    task: {
      taskId: "task_x",
      conversationId: "conv_x",
      state: "completed",
      lastError: null,
      steps: [
        { stepId: "step_extract_intent", status: "completed" },
        { stepId: "step_risk_guard", status: "completed", requiresConfirm: true },
        { stepId: "step_create_doc", status: "failed" },
      ],
      artifacts: [
        { artifactId: "doc_1", kind: "doc", title: "需求文档", url: "https://example.com/docx/abc" },
        { artifactId: "note_1", kind: "note", title: "trace", url: "" },
      ],
    },
    input: {
      input: "请整理需求并生成文档（包含敏感聊天内容不应被记录）",
      contextSummary: "## 上下文摘要\n- xxx",
    },
    intentMeta: {
      source: "llm",
      decisionPath: "slow",
      confidence: 0.83,
      thresholds: { fast: 0.8, slow: 0.6 },
      output_type: "doc",
      doc_type: "prd",
      ppt_type: "report",
      scenario: "review",
    },
    templateInfo: { kind: "doc", title: "PRD（Agent）", sectionsOrder: ["task", "intent", "summary"] },
    startedAt,
  });

  assert.equal(event.v, FEEDBACK_SCHEMA_VERSION);
  assert.equal(event.type, "feedback.task_completed");
  assert.equal(event.taskId, "task_x");
  assert.equal(event.conversationId, "conv_x");
  assert.equal(event.state, "completed");
  assert.ok(event.durationMs >= 1000);

  assert.equal(event.intent.source, "llm");
  assert.equal(event.intent.decisionPath, "slow");
  assert.equal(event.intent.confidence, 0.83);
  assert.deepEqual(event.intent.thresholds, { fast: 0.8, slow: 0.6 });
  assert.equal(event.intent.output_type, "doc");
  assert.equal(event.intent.doc_type, "prd");
  assert.equal(event.intent.scenario, "review");

  assert.equal(event.template.kind, "doc");
  assert.deepEqual(event.template.sectionsOrder, ["task", "intent", "summary"]);

  assert.equal(event.artifacts.length, 2);
  assert.equal(event.artifacts[0].kind, "doc");
  assert.equal(event.artifacts[0].urlPresent, true);
  assert.equal(event.artifacts[1].urlPresent, false);

  assert.deepEqual(event.confirms.requiredSteps, ["step_risk_guard"]);
  assert.deepEqual(event.confirms.cancelledSteps, ["step_create_doc"]);
  assert.equal(event.confirms.required, true);

  assert.ok(event.inputLen > 0);
  assert.ok(event.contextLen > 0);

  // Privacy guard: must not contain raw chat or context body anywhere in serialized event.
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes("敏感聊天内容"));
  assert.ok(!serialized.includes("## 上下文摘要"));
});

test("buildUserRatingFeedback: 校验、截断、默认值", () => {
  const longNote = "x".repeat(800);
  const event = buildUserRatingFeedback({
    taskId: "task_y",
    conversationId: "conv_y",
    artifactId: "doc_2",
    rating: "down",
    note: longNote,
    tags: ["ok", 123, "tooLong" + "z".repeat(100)],
  });
  assert.equal(event.v, FEEDBACK_SCHEMA_VERSION);
  assert.equal(event.type, "feedback.user_rating");
  assert.equal(event.taskId, "task_y");
  assert.equal(event.rating, "down");
  assert.equal(event.note.length, 500);
  assert.equal(event.tags.length, 2);
  assert.equal(event.tags[1].length <= 32, true);

  const fallback = buildUserRatingFeedback({ taskId: "t", rating: "weird" });
  assert.equal(fallback.rating, "up");
});

test("publishFeedbackEvent: 走 POST，body 含 v/type/taskId（与 realtime-server 路由校验对齐）", async () => {
  const captured = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    captured.push({ url: String(url), init });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await publishFeedbackEvent({ v: 1, type: "feedback.task_completed", taskId: "task_pub_1", state: "completed" });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(captured.length, 1);
  const c = captured[0];
  assert.equal(c.init.method, "POST");
  assert.match(c.url, /\/api\/feedback-events$/);
  const parsed = JSON.parse(c.init.body);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.type, "feedback.task_completed");
  assert.equal(parsed.taskId, "task_pub_1");
});

test("publishFeedbackEvent: realtime 不可达时静默失败，不抛异常", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("network down");
  };
  try {
    await assert.doesNotReject(async () => {
      await publishFeedbackEvent({ v: 1, type: "feedback.task_completed", taskId: "t" });
    });
  } finally {
    global.fetch = originalFetch;
  }
});
