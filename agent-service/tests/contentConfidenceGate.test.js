const test = require("node:test");
const assert = require("node:assert/strict");

const { readContentConfidenceMin, aggregateContentConfidence } = require("../src/contentConfidenceGate");

test("aggregateContentConfidence: 仅文档用 rewrittenConfidence 或 confidence", () => {
  assert.equal(aggregateContentConfidence({ confidence: 0.3 }, false), 0.3);
  assert.equal(aggregateContentConfidence({ confidence: 0.5, rewrittenConfidence: 0.8 }, false), 0.8);
});

test("aggregateContentConfidence: doc+slides 取 min（保守）", () => {
  const agg = aggregateContentConfidence(
    { confidence: 0.9, rewrittenSlidesConfidence: 0.4, rewrittenSlidesPlan: { confidence: 0.99 } },
    true,
  );
  assert.equal(agg, 0.4);
});

test("readContentConfidenceMin: 环境变量解析为 0..1", () => {
  const prev = process.env.CONTENT_CONFIDENCE_MIN;
  try {
    process.env.CONTENT_CONFIDENCE_MIN = "0.95";
    assert.equal(readContentConfidenceMin(), 0.95);
    delete process.env.CONTENT_CONFIDENCE_MIN;
    assert.equal(readContentConfidenceMin(), 0);
  } finally {
    if (prev === undefined) delete process.env.CONTENT_CONFIDENCE_MIN;
    else process.env.CONTENT_CONFIDENCE_MIN = prev;
  }
});
