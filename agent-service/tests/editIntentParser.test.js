const test = require("node:test");
const assert = require("node:assert/strict");

const { parseEditIntent } = require("../src/editIntentParser");

test("editIntentParser: doc replace 指令可识别", () => {
  const out = parseEditIntent("把 https://example.com/docx/abc 里的目标段改成本周完成联调", {});
  assert.equal(out.isEdit, true);
  assert.equal(out.target, "doc");
  assert.equal(out.operation, "UPDATE_BLOCK");
  assert.ok(out.selector.anchorText);
  assert.ok(out.payload.to);
});

test("editIntentParser: slides 标题修改可识别页码", () => {
  const out = parseEditIntent("把 https://example.com/slides/xyz 第3页标题改为阶段复盘", {});
  assert.equal(out.isEdit, true);
  assert.equal(out.target, "slides");
  assert.equal(out.selector.pageIndex, 3);
});

test("editIntentParser: 删除操作不附加 needsConfirm（由 LLM/上层决定）", () => {
  const out = parseEditIntent("删除 docx/abc 里关于风险评估的段落", {});
  assert.equal(out.isEdit, true);
  assert.equal(out.operation, "DELETE_BLOCK");
  assert.equal(out.needsConfirm, false);
});

test("editIntentParser: slides 删除最后一页可识别为编辑意图且带定位", () => {
  const out = parseEditIntent("删除 https://example.com/slides/xyz 最后一页", {});
  assert.equal(out.isEdit, true);
  assert.equal(out.target, "slides");
  assert.equal(out.operation, "DELETE_BLOCK");
  assert.equal(out.selector.lastPage, true);
});

test("editIntentParser: 无链接时删除最后一页仍偏向 slides", () => {
  const out = parseEditIntent("删除最后一页", {});
  assert.equal(out.isEdit, true);
  assert.equal(out.target, "slides");
  assert.equal(out.selector.lastPage, true);
});

test("editIntentParser: 句中含改为但仍要求删最后一页时优先 delete", () => {
  const out = parseEditIntent(
    "本周完成联调下周改为灰度发布，删掉最后一页 https://example.com/slides/xyz",
    {},
  );
  assert.equal(out.operation, "DELETE_BLOCK");
  assert.equal(out.selector.lastPage, true);
});

test("editIntentParser: 删掉 口语可触发删除而非 replace", () => {
  const out = parseEditIntent("删掉最后一页 https://example.com/slides/xyz", {});
  assert.equal(out.operation, "DELETE_BLOCK");
});

test("editIntentParser: 合并文本含无关删除/最后一页时仍识别第2页标题改为 replace", () => {
  const merged = [
    "根据下面这篇PPT把第 2 页标题改成「季度总结」",
    "待办：删除最后一页旧稿备份",
    "slides/Al94sJZapl0x6Xdgq1OcEnWSnZc",
  ].join("\n");
  const out = parseEditIntent(merged, {});
  assert.equal(out.isEdit, true);
  assert.equal(out.target, "slides");
  assert.equal(out.operation, "UPDATE_BLOCK");
  assert.equal(out.selector.pageIndex, 2);
  assert.equal(out.selector.lastPage, false);
});

test("editIntentParser: 显式第N页时忽略合并文本里的最后一页", () => {
  const merged = "把第 3 页标题改为复盘\n另请参考最后一页的结论";
  const out = parseEditIntent(merged, {});
  assert.equal(out.operation, "UPDATE_BLOCK");
  assert.equal(out.selector.pageIndex, 3);
  assert.equal(out.selector.lastPage, false);
});

test("editIntentParser: slides 插入解析标题与内容", () => {
  const raw =
    "在 https://example.com/slides/xyz 第2页后新增一页，标题「风险清单」，内容「风险A；风险B」";
  const out = parseEditIntent(raw, {});
  assert.equal(out.isEdit, true);
  assert.equal(out.target, "slides");
  assert.equal(out.operation, "INSERT_BLOCK");
  assert.equal(out.selector.pageIndex, 2);
  assert.equal(out.selector.lastPage, false);
  assert.equal(out.payload.title, "风险清单");
  assert.equal(out.payload.content, "风险A；风险B");
});

test("editIntentParser: doc 插入 长 URL + 长列表锚点 不截断", () => {
  const raw = [
    "在https://jcneyh7qlo8i.feishu.cn/docx/BXJWdiWplo9N3LxjL8cc1bCbnHc 的",
    '"三方翻译接口 Token 成本超支的具体原因？是否有明确的降本方案与排期？"',
    "后面插入：新增风险：第三方限流；对策：队列与重试",
  ].join("");
  const out = parseEditIntent(raw, {});
  assert.equal(out.isEdit, true);
  assert.equal(out.target, "doc");
  assert.equal(out.operation, "INSERT_BLOCK");
  assert.equal(
    out.selector.anchorText,
    "三方翻译接口 Token 成本超支的具体原因？是否有明确的降本方案与排期？",
  );
  assert.ok(String(out.payload.content).includes("第三方限流"));
});

