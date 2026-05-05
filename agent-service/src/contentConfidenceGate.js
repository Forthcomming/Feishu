// Content quality gate: aggregate confidence from generateContentBundle output.
// Orchestrator compares aggregate (number 0..1) with CONTENT_CONFIDENCE_MIN.

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Threshold from env. Default 0 = gate comparison never trips (agg < 0 is impossible for valid agg).
 */
function readContentConfidenceMin() {
  const raw = process.env.CONTENT_CONFIDENCE_MIN;
  if (raw === undefined || raw === "") return 0;
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * Conservative aggregate: doc path and slides path both matter when slides are requested.
 * @param {object} bundle - generateContentBundle result
 * @param {boolean} wantsSlides
 * @returns {number} 0..1
 */
function aggregateContentConfidence(bundle, wantsSlides) {
  const b = bundle && typeof bundle === "object" ? bundle : {};
  const base = clamp01(b.confidence);
  const docScore = clamp01(b.rewrittenConfidence != null ? b.rewrittenConfidence : base);

  if (!wantsSlides) return docScore;

  const plan = b.rewrittenSlidesPlan && typeof b.rewrittenSlidesPlan === "object" ? b.rewrittenSlidesPlan : null;
  const slidesScore = clamp01(
    b.rewrittenSlidesConfidence != null ? b.rewrittenSlidesConfidence : plan != null ? plan.confidence : docScore,
  );
  return Math.min(docScore, slidesScore);
}

module.exports = { readContentConfidenceMin, aggregateContentConfidence };
