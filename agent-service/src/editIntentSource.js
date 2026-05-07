/**
 * 合并编辑意图输入源（非编辑场景或需带上下文的旧行为可继续用）：
 * - 默认只使用“本轮用户输入 + 显式 target 链接”，减少历史上下文串扰。
 * - 用户显式提到「上文/前文/继续」时，才补充 contextSummary/recentMessages。
 */
function mergeEditIntentSource(input) {
  if (!input || typeof input !== "object") return "";
  const main = String(input.input || "").trim();
  const useContext = /上文|前文|上一条|继续|同上|沿用|参考前面|基于前面/.test(main);
  const recent =
    useContext && Array.isArray(input.recentMessages) && input.recentMessages.length
      ? input.recentMessages.map((x) => String(x || "").trim()).filter(Boolean).join("\n")
      : "";
  const extra = [];
  if (typeof input.docTarget === "string" && input.docTarget.trim()) extra.push(input.docTarget.trim());
  if (typeof input.slidesTarget === "string" && input.slidesTarget.trim()) extra.push(input.slidesTarget.trim());
  const parts = [main, useContext ? String(input.contextSummary || "") : "", recent, extra.join("\n")];
  return parts.filter(Boolean).join("\n");
}

/** 编辑解析专用：仅本轮指令句 + 调用方显式附带的 doc/slides 目标，不包含 contextSummary / 历史消息 */
function editInstructionText(input) {
  if (!input || typeof input !== "object") return "";
  const main = String(input.input || "").trim();
  const extra = [];
  if (typeof input.docTarget === "string" && input.docTarget.trim()) extra.push(input.docTarget.trim());
  if (typeof input.slidesTarget === "string" && input.slidesTarget.trim()) extra.push(input.slidesTarget.trim());
  return [main, extra.filter(Boolean).join("\n")].filter(Boolean).join("\n");
}

module.exports = { mergeEditIntentSource, editInstructionText };
