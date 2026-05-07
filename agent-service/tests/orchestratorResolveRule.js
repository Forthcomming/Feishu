const { editInstructionText } = require("../src/editIntentSource");

/** 测试中强制走规则解析，避免触发真实 LLM（与编辑链路 editInstructionText 对齐）。 */
async function resolveEditIntentRuleOnly(input, { intent, parseEditIntent }) {
  return {
    editIntent: parseEditIntent(editInstructionText(input), {
      intent,
    }),
    source: "rule",
  };
}

module.exports = { resolveEditIntentRuleOnly };
