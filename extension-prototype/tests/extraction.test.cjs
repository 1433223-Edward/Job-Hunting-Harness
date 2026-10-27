// 仅使用测试环境已有的 Playwright；扩展不增加运行依赖。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { chromium } = require(process.argv[2] || "playwright");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "popup.js"), "utf8");
const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {} }) } });
vm.runInContext(source, context);
const extractor = context.extractPageText.toString();
const rawJD = fs.readFileSync(path.join(__dirname, "fixtures", "boss-user-raw.txt"), "utf8");
const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const detail = `<section><h2>职位描述</h2><pre>${escape(rawJD)}</pre><div>竞争力分析</div><p>公司介绍及更多职位</p></section>`;
let passed = 0;
(async () => {
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || "msedge", headless: true });
  try {
    const page = await browser.newPage();
    async function extract(html) {
      await page.setContent(html);
      const before = await page.content();
      const result = await page.evaluate(`(${extractor})(30000)`);
      assert.equal(await page.content(), before, "读取不能修改网页 DOM");
      return result;
    }
    async function check(name, html, verify) {
      verify(await extract(html)); passed++; console.log(`PASS ${name}`);
    }
    await check("普通网页全文回退", "<h1>普通文章</h1><p>这里是普通页面正文。</p>", r => {
      assert.equal(r.mode, "fallback"); assert.ok(r.text.includes("普通页面正文"));
    });
    await check("简单 JD 定位及完整读取，不在 DOM 层裁剪", `<nav>导航栏</nav><main>${detail}</main><footer>页脚</footer>`, r => {
      assert.equal(r.mode, "targeted");
      assert.ok(r.text.includes(rawJD));
      assert.ok(r.text.includes("竞争力分析"));
      assert.ok(!r.text.includes("导航栏") && !r.text.includes("页脚"));
      assert.equal(r.text, r.rawText);
    });
    await check("没有标准子章节标题仍可读取", "<section><h2>职位描述</h2><p>负责模型应用开发、数据库服务和日常维护，能够完成需求分析、开发和上线交付。</p></section>", r => assert.equal(r.mode, "targeted"));
    await check("只有标题时回退", "<section><h2>职位描述</h2></section>", r => assert.equal(r.mode, "fallback"));
    await check("隐藏标题不作为定位入口", `<div hidden>${detail}</div><p>普通内容</p>`, r => assert.equal(r.mode, "fallback"));
    await check("多个独立职位时回退", detail + detail, r => assert.equal(r.mode, "fallback"));
    for (const size of [0, 29999, 30000, 30001]) {
      await check(`字符上限 ${size}`, `<p>${"字".repeat(size)}</p>`, r => {
        assert.equal(r.text.length, Math.min(size, 30000));
        assert.equal(r.totalCharacters, size);
        assert.equal(r.truncated, size > 30000);
        assert.equal(r.rawText, r.text);
      });
    }
    const header = "<header><h1>前端工程师</h1><p>20-30K</p><p>公司名称：示例科技</p><p>工作城市：上海</p><p>1-3年</p><p>本科</p></header>";
    await check("保留与裁剪无关的既有摘要读取", header + detail, r => {
      assert.equal(r.job.jobTitle, "前端工程师");
      assert.equal(r.job.company, "示例科技");
      assert.equal(r.job.city, "上海");
      assert.equal(r.job.salary, "20-30K");
    });
    const extracted = await extract(detail);
    const html = fs.readFileSync(path.join(root, "popup.html"), "utf8")
      .replace(/<script[^>]*><\/script>/g, "").replace(/<link[^>]*>/g, "");
    await page.setContent(html);
    await page.evaluate(data => {
      window.testResult = data;
      window.chrome = {
        tabs: { query: async () => [{ id: 1, url: "https://www.zhipin.com/job_detail/test.html" }] },
        scripting: { executeScript: async options => {
          window.injection = { id: options.target.tabId, limit: options.args[0], functionName: options.func.name };
          return [{ result: window.testResult }];
        } }
      };
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.copied = text; } } });
    }, extracted);
    await page.addScriptTag({ content: source });
    await page.evaluate(() => readCurrentPage());
    const expected = context.cleanBossJD(extracted.text).text;
    assert.equal(await page.locator("#page-text").inputValue(), expected);
    assert.ok(expected.includes(rawJD.slice(rawJD.indexOf("职位描述"))));
    assert.ok(!expected.includes("竞争力分析") && !expected.includes("公司介绍"));
    assert.equal(await page.locator("#raw-text").inputValue(), extracted.rawText);
    assert.ok((await page.locator("#quality-notice").innerText()).includes("已命中"));
    assert.deepEqual(await page.evaluate(() => window.injection), { id: 1, limit: 30000, functionName: "extractPageText" });
    await page.evaluate(() => copyExtractedText());
    assert.equal(await page.evaluate(() => window.copied), expected);
    passed++; console.log("PASS 真实 JD＋构造边界：完整正文保留、尾部移除、显示与复制一致、原文独立保留");

    await page.evaluate(raw => { window.testResult = { ...window.testResult, text: raw, rawText: raw }; }, rawJD);
    await page.evaluate(() => readCurrentPage());
    assert.equal(await page.locator("#page-text").inputValue(), context.cleanBossJD(rawJD).text);
    assert.ok((await page.locator("#quality-notice").innerText()).includes("未命中"));
    await page.evaluate(() => copyExtractedText());
    assert.equal(await page.evaluate(() => window.copied), context.cleanBossJD(rawJD).text);
    assert.equal(await page.locator("#raw-text").inputValue(), rawJD);
    passed++; console.log("PASS 真实样本无结束边界：仅清理开头操作区，正文与复制一致，提示未命中");

    for (const suffix of ["认证资质\n竞争力分析\n公司介绍", "竞争力分析\n认证资质\n公司介绍"]) {
      await page.evaluate(raw => { window.testResult = { ...window.testResult, text: raw, rawText: raw }; }, rawJD + suffix);
      await page.evaluate(() => readCurrentPage());
      assert.equal(await page.locator("#page-text").inputValue(), context.cleanBossJD(rawJD).text);
      assert.ok((await page.locator("#quality-notice").innerText()).includes(suffix.split("\n")[0]));
      await page.evaluate(() => copyExtractedText());
      assert.equal(await page.evaluate(() => window.copied), context.cleanBossJD(rawJD).text);
      passed++; console.log("PASS 双结束标记取最早位置，显示与复制一致");
    }

    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("denied"); }; });
    await page.evaluate(() => copyExtractedText());
    assert.ok((await page.locator("#error").innerText()).includes("手动复制"));
    passed++; console.log("PASS 剪贴板失败提示");

    for (const [name, setup, message] of [
      ["标签页不存在", () => { chrome.tabs.query = async () => []; }, "不存在"],
      ["特殊页面", () => { chrome.tabs.query = async () => [{ id: 1, url: "chrome://extensions" }]; }, "HTTP/HTTPS"],
      ["禁止注入", () => { chrome.tabs.query = async () => [{ id: 1, url: "https://example.com" }]; chrome.scripting.executeScript = async () => { throw new Error("Cannot access contents of url"); }; }, "Chrome 不允许"],
      ["一般注入失败", () => { chrome.scripting.executeScript = async () => { throw new Error("Injection failed"); }; }, "脚本注入"],
      ["无返回结果", () => { chrome.scripting.executeScript = async () => []; }, "脚本注入"]
    ]) {
      await page.evaluate(setup);
      await page.evaluate(() => readCurrentPage());
      assert.ok((await page.locator("#error").innerText()).includes(message));
      assert.equal(await page.locator("#read-button").isDisabled(), false);
      assert.equal(await page.locator("#copy-button").isDisabled(), true);
      assert.equal(await page.locator("#page-text").inputValue(), "");
      assert.equal(await page.locator("#raw-text").inputValue(), "");
      passed++; console.log(`PASS ${name}及失败后清理旧结果`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.permissions, ["activeTab", "scripting"]);
    console.log(`完成 ${passed} 组回归：无头 Edge、模拟 Chrome API；未测试真实 Chrome 扩展或 BOSS 页面。`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
