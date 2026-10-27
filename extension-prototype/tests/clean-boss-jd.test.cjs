// 固定前缀与两个结束标记的测试；不构造 DOM 或招聘者匹配规则。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
vm.runInContext(source, context);
const clean = raw => context.cleanBossJD(raw).text;
const raw = fs.readFileSync(path.join(__dirname, "fixtures", "boss-user-raw.txt"), "utf8");
const tail = "竞争力分析\n公司介绍\n更多职位";

const expectedJD = raw.slice(raw.indexOf("职位描述"));
assert.equal(clean(raw), expectedJD, "无结束边界时只清理开头操作区，正文逐字不变");
assert.equal(context.cleanBossJD(raw).boundary, null);
assert.equal(clean(raw + tail), expectedJD, "命中时仅移除固定边界及其后内容");
assert.equal(clean("正文竞争力分析尾部竞争力分析其他内容"), "正文");
assert.equal(clean("竞争力分析尾部"), "");
assert.equal(clean(""), "");
assert.equal(clean("  正文\n\n竞争力分析尾部"), "  正文\n\n", "不能擅自 trim");
const beforeBoundary = raw + "林女士\n刚刚活跃\n示例公司\n·\n招聘经理\n";
assert.equal(clean(beforeBoundary + tail), expectedJD + beforeBoundary.slice(raw.length), "边界前的招聘者文字也不能触发其他清洗规则");

for (const prefix of ["微信扫码分享\n举报\n", "微信扫码分享 举报\n", "微信扫码分享 举\n报\n", "举报\n微信扫码分享\n", "举\n报\n"]) {
  assert.equal(clean(prefix + "MySQL\nPython\n完整 JD 正文"), "MySQL\nPython\n完整 JD 正文");
}
assert.equal(clean("职位描述\n微信扫码分享\n举\n报\nMySQL\nPython"), "职位描述\nMySQL\nPython");
for (const text of ["负责举报系统研发，支持微信扫码分享。", "举报系统开发要求", "举报 处理流程及问题排查", "岗位职责\n微信扫码分享\n举报\n不得删除的正文"]) assert.equal(clean(text), text);
for (const suffix of ["认证资质尾部", "竞争力分析尾部", "认证资质尾部竞争力分析其他", "竞争力分析尾部认证资质其他"]) {
  assert.equal(clean(raw + suffix), expectedJD);
}
assert.equal(context.cleanBossJD(raw + "认证资质尾部竞争力分析").boundary, "认证资质");
assert.equal(context.cleanBossJD(raw + "竞争力分析尾部认证资质").boundary, "竞争力分析");
const cleaned = clean(raw + tail);
const headings = [...cleaned.matchAll(/^(岗位职责|任职要求|加分项)[：:]?\s*$/gm)];
const counts = headings.map((heading, index) => {
  const section = cleaned.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? cleaned.length);
  return [heading[1], [...section.matchAll(/^\d+\./gm)].length];
});
assert.deepEqual(counts, [["岗位职责", 7], ["任职要求", 8], ["加分项", 2]]);
assert.ok(cleaned.includes("MySQL") && cleaned.includes("Python"));
assert.ok(cleaned.trimEnd().endsWith("具有 LoRA / QLoRA 微调、模型部署或推理优化经验。"));
for (const word of ["竞争力分析", "公司介绍", "更多职位"]) assert.ok(!cleaned.includes(word));
console.log("PASS 真实 JD 原文逐字保留，职责/要求/加分项 7/8/2，技能及末句保留。");
console.log("PASS 首次固定边界、未命中原样返回、空文本、边界在开头、换行保留；两个结束标记取最早；前缀与正文同词不误删。");
