const { UPDATE_BLOCK, toBlockOp } = require("./editBlockOps");

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function buildEditPlan({ input, editIntent, intent }) {
  const base = editIntent && typeof editIntent === "object" ? editIntent : {};
  if (!base.isEdit) return { isEdit: false, reason: "not_edit" };
  const target = base.target === "slides" || base.target === "doc" ? base.target : intent?.output_type === "ppt" ? "slides" : "doc";
  const operation = toBlockOp(base.operation);
  const selector = base.selector && typeof base.selector === "object" ? base.selector : {};
  const payload = base.payload && typeof base.payload === "object" ? base.payload : {};
  const confidence = clamp01(Number(base.confidence ?? 0.5));
  const maxChanges = 1;
  // 编辑模式只允许 block/slide 原子操作；mode 仅保留给非编辑旧链路兼容。
  const mode = "append";
  const needsConfirm = base.needsConfirm === true;
  return {
    isEdit: true,
    target,
    operation,
    selector,
    payload,
    confidence,
    maxChanges,
    mode,
    needsConfirm,
  };
}

function buildEditPreview(plan) {
  if (!plan || !plan.isEdit) return "";
  const selectorSummary = [];
  if (plan.selector?.anchorText) selectorSummary.push(`anchor="${String(plan.selector.anchorText).slice(0, 80)}"`);
  const pi = plan.selector?.pageIndex ?? plan.selector?.page_index;
  if (pi != null && pi !== "") selectorSummary.push(`page=${pi}`);
  if (plan.selector?.lastPage) selectorSummary.push("page=last");
  if (plan.selector?.bulletIndex) selectorSummary.push(`bullet=${plan.selector.bulletIndex}`);
  const payloadSummary = [];
  if (plan.payload?.to) payloadSummary.push(`to="${String(plan.payload.to).slice(0, 80)}"`);
  if (plan.payload?.content) payloadSummary.push(`content="${String(plan.payload.content).slice(0, 80)}"`);
  if (plan.payload?.title) payloadSummary.push(`title="${String(plan.payload.title).slice(0, 80)}"`);
  if (plan.payload?.maxBullets) payloadSummary.push(`maxBullets=${plan.payload.maxBullets}`);
  if (plan.payload?.blockId) payloadSummary.push(`blockId=${String(plan.payload.blockId).slice(0, 40)}`);
  if (plan.payload?.slideId) payloadSummary.push(`slideId=${String(plan.payload.slideId).slice(0, 40)}`);
  return [
    `编辑计划：target=${plan.target} operation=${plan.operation} mode=${plan.mode}`,
    selectorSummary.length ? `selector: ${selectorSummary.join(", ")}` : "selector: (auto)",
    payloadSummary.length ? `payload: ${payloadSummary.join(", ")}` : "payload: (none)",
    `confidence=${plan.confidence.toFixed(2)} needsConfirm=${plan.needsConfirm ? "yes" : "no"}`,
  ].join("\n");
}

module.exports = {
  buildEditPlan,
  buildEditPreview,
  UPDATE_BLOCK,
};
