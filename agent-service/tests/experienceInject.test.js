const test = require("node:test");
const assert = require("node:assert/strict");

const { renderExperienceInjection } = require("../src/experienceInject");

test("experienceInject: 空卡片返回空字符串", () => {
  assert.equal(renderExperienceInjection([]), "");
});

test("experienceInject: 生成可注入文本并裁剪", () => {
  const text = renderExperienceInjection([
    {
      when: "output_type=doc doc_type=prd scenario=review",
      tips: ["先列风险", "再列行动项（owner/ddl）"],
      antiPatterns: ["避免只写概念不写执行项"],
      confidence: 0.83,
    },
  ]);
  assert.match(text, /历史经验建议/);
  assert.match(text, /适用场景/);
  assert.match(text, /建议/);
  assert.match(text, /避免/);
  assert.match(text, /0\.83/);
});
