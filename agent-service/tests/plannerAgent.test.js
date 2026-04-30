const test = require("node:test");
const assert = require("node:assert/strict");

const { parsePlanJson, ruleBasedPlan } = require("../src/plannerAgent");

test("parsePlanJson: 解析严格 JSON plan", () => {
  const raw = JSON.stringify({
    plan_version: 1,
    steps: [
      { id: "step_a", label: "A", kind: "logic" },
      { id: "step_b", label: "B", kind: "llm" },
      { id: "step_c", label: "C", kind: "guard" },
      { id: "step_d", label: "D", kind: "tool", tool: "docs.create" },
      { id: "step_e", label: "E", kind: "tool", tool: "slides.create" },
      { id: "step_f", label: "F", kind: "logic" },
      { id: "step_g", label: "G", kind: "logic" },
      { id: "step_h", label: "H", kind: "tool", tool: "im.messages_send" },
    ],
    risks: { needs_confirm: true, reason: "need confirm" },
  });

  const plan = parsePlanJson(raw);
  assert.equal(plan.planVersion, 1);
  assert.equal(plan.steps.length, 8);
  assert.equal(plan.risks.needsConfirm, true);
  assert.equal(plan.risks.reason, "need confirm");
  assert.ok(plan.steps.every((s) => s.status === "pending"));
});

test("ruleBasedPlan: doc+slides 输出 8-12 步且包含关键 tool 步", () => {
  const plan = ruleBasedPlan({ targetArtifacts: ["doc", "slides"], dryRun: true });
  assert.ok(plan.steps.length >= 8 && plan.steps.length <= 12);
  const ids = new Set(plan.steps.map((s) => s.stepId));
  assert.ok(ids.has("step_risk_guard"));
  assert.ok(ids.has("step_create_doc"));
  assert.ok(ids.has("step_create_slides"));
  assert.ok(ids.has("step_send_delivery_message"));
});

