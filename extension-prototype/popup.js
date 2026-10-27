"use strict";

const MAX_CHARACTERS = 30000;
const readButton = document.getElementById("read-button");
const copyButton = document.getElementById("copy-button");
const statusElement = document.getElementById("status");
const errorElement = document.getElementById("error");
const resultElement = document.getElementById("result");
const titleElement = document.getElementById("page-title");
const urlElement = document.getElementById("page-url");
const countElement = document.getElementById("character-count");
const truncationElement = document.getElementById("truncation");
const textElement = document.getElementById("page-text");
const modeElement = document.getElementById("extraction-mode");
const qualityElement = document.getElementById("quality-notice");
const structuredElement = document.getElementById("structured-result");

// 固定文本规则集中在此处，不读取 DOM，也不推测招聘者信息。
function cleanBossJD(rawText) {
  let endIndex = rawText.length;
  let boundary = null;
  for (const marker of ["竞争力分析", "认证资质"]) {
    const index = rawText.indexOf(marker);
    if (index >= 0 && index < endIndex) {
      endIndex = index;
      boundary = marker;
    }
  }
  // 只匹配最开头的操作区域；可保留前置“职位描述”标题，遇到正文即停止。
  const leadingActions = /^(\s*职位描述[：:]?[ \t]*(?:\r?\n|$))?[ \t\r\n]*(?:(?:微信扫码分享|举[ \t\r\n]*报)(?=[ \t]*(?:\r?\n|$|微信扫码分享|举[ \t\r\n]*报))[ \t\r\n]*)+/;
  const text = rawText.slice(0, endIndex).replace(leadingActions, "$1");
  return { text, boundary };
}

// 此函数按需在网页中执行，不能依赖弹窗中的变量。
function extractPageText(maxCharacters) {
  const warnings = [];
  const excluded = 'nav, aside, footer, [role="navigation"], [role="complementary"], [role="contentinfo"]';
  const visible = element => {
    if (!element || element.closest('[hidden], [aria-hidden="true"], script, style, template')) return false;
    if (!element.getClientRects().length) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const textOf = element => element?.innerText || "";
  const isTitle = element => visible(element) && !element.closest(excluded)
    && /^职位描述[：:]?$/.test(textOf(element).trim());
  const noisy = text => /(?:^|\n)\s*(?:推荐职位|相关推荐|相似职位|热门职位|热门城市|其他职位|公司其他职位|猜你喜欢|友情链接|网站导航|关于我们|隐私政策|版权声明)\s*(?:[：:]|\n|$)/.test(text);
  const hasChrome = element => [...element.querySelectorAll(excluded)].some(visible);

  // 保留简单的标题祖先定位；不再扩大容器或推断 JD 结束位置。
  const titles = document.body ? [...document.body.querySelectorAll("*")]
    .filter(isTitle).filter(node => ![...node.children].some(isTitle)) : [];
  const candidates = new Set();
  for (const title of titles) {
    for (let parent = title.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.closest(excluded)) continue;
      const raw = textOf(parent);
      const titleCount = [...parent.querySelectorAll("*")].filter(isTitle)
        .filter(node => ![...node.children].some(isTitle)).length;
      if (titleCount === 1 && raw.replace(/\s/g, "").length - textOf(title).replace(/\s/g, "").length >= 24) {
        candidates.add(parent);
        break;
      }
    }
  }
  const container = candidates.size === 1 ? [...candidates][0] : null;
  if (!container) warnings.push("未能可靠定位职位详情区域，当前展示的是整页文本，请人工检查。");
  const rawText = textOf(container || document.body);
  const job = { jobTitle: null, company: null, salary: null, city: null, experience: null, education: null };

  // 摘要必须在 JD 之前、含唯一 h1 和招聘条件证据；不从整页猜测公司或城市。
  let summaryText = "";
  const salaryPattern = /\d+(?:\.\d+)?\s*[-–~至]\s*\d+(?:\.\d+)?\s*(?:[kKwW万千]|元)(?:\s*[·・]\s*\d+薪)?|\d+(?:\.\d+)?\s*(?:[kKwW万千]|元)\s*[/／]\s*(?:月|年|天|时)|薪资面议/g;
  const experiencePattern = /(?:\d+\s*[-–~至]\s*)?\d+\s*年(?:以上|及以上)?|经验不限|应届(?:生|毕业生)?|无需经验/g;
  const educationPattern = /(?:博士|硕士|研究生|本科|大专|高中|中专|初中)(?:及以上|以上)?|学历不限/g;
  if (container) {
    const summaryCandidates = new Map();
    for (const heading of [...document.querySelectorAll("h1")].filter(visible)) {
      if (heading.closest(excluded) || !(heading.compareDocumentPosition(container) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      for (let scope = heading.parentElement; scope && scope !== document.body; scope = scope.parentElement) {
        if (scope.contains(container)) break;
        const raw = textOf(scope);
        if (raw.length > 4000 || noisy(raw) || hasChrome(scope)) break;
        if ([...scope.querySelectorAll("h1")].filter(visible).length !== 1) break;
        if (raw.match(salaryPattern) && (raw.match(experiencePattern) || raw.match(educationPattern))) {
          // 同一个 h1 优先最小范围，避免把整个页面摘要当成职位摘要。
          summaryCandidates.set(heading, scope);
          break;
        }
      }
    }
    if (summaryCandidates.size === 1) {
      const [heading, scope] = [...summaryCandidates][0];
      summaryText = textOf(scope);
      job.jobTitle = textOf(heading).trim() || null;
      const unique = values => {
        const distinct = [...new Set(values)];
        return distinct.length === 1 ? distinct[0] : null;
      };
      const labeled = labels => {
        const pattern = new RegExp(`(?:^|\\n)[ \\t]*(?:${labels})[ \\t]*(?:[：:][ \\t]*|\\n[ \\t]*)([^\\n]+)`, "g");
        return unique([...summaryText.matchAll(pattern)].map(match => match[1].trim()).filter(Boolean));
      };
      job.company = labeled("公司名称|公司");
      job.city = labeled("工作城市|城市");
      // 只接受独立条件文本或显式标签，避免把公司成立年份误当成经验。
      const tokens = [...summaryText.split(/\n/), ...[...scope.querySelectorAll("*")]
        .filter(node => visible(node) && !node.children.length).map(textOf)];
      const condition = (pattern, labels, suffix = "") => {
        const exact = new RegExp(`^(?:${pattern.source})(?:${suffix})?$`);
        const prefix = new RegExp(`^(?:${labels})[ \\t]*[：:][ \\t]*`);
        return unique(tokens.map(token => token.trim().replace(prefix, ""))
          .filter(token => exact.test(token)));
      };
      job.salary = condition(salaryPattern, "薪资范围|薪资|薪酬");
      job.experience = condition(experiencePattern, "工作经验要求|工作经验|经验要求|经验", "工作经验|经验");
      job.education = condition(educationPattern, "学历要求|学历", "学历");
    } else warnings.push("未能可靠定位唯一职位摘要，摘要字段标记为未知。");
  }

  const labels = { jobTitle: "职位名称", company: "公司名称", salary: "薪资范围", city: "工作城市", experience: "工作经验", education: "学历要求" };
  const missingFieldLabels = Object.keys(labels).filter(field => !job[field]).map(field => labels[field]);
  return {
    title: document.title,
    url: location.href,
    text: rawText.slice(0, maxCharacters),
    rawText: rawText.slice(0, maxCharacters),
    totalCharacters: rawText.length,
    rawTotalCharacters: rawText.length,
    truncated: rawText.length > maxCharacters,
    rawTruncated: rawText.length > maxCharacters,
    mode: container ? "targeted" : "fallback",
    summaryText,
    job,
    quality: { missingFieldLabels, warnings }
  };
}

function showError(message) {
  errorElement.textContent = message;
  errorElement.hidden = false;
}

function resetResult() {
  titleElement.textContent = "尚未读取";
  urlElement.textContent = "尚未读取";
  countElement.textContent = "尚未读取";
  truncationElement.textContent = "尚未读取";
  textElement.value = "";
  copyButton.disabled = true;
  errorElement.hidden = true;
  errorElement.textContent = "";
  modeElement.textContent = "尚未读取";
  qualityElement.hidden = true;
  qualityElement.textContent = "";
  structuredElement.hidden = true;
  structuredElement.open = false;
  for (const id of ["job-fields", "missing-fields", "summary-text"]) {
    document.getElementById(id).textContent = "";
  }
  document.getElementById("text-label").textContent = "提取的正文文本";
  document.getElementById("raw-result").hidden = true;
  document.getElementById("raw-result").open = false;
  document.getElementById("raw-text").value = "";
  document.getElementById("raw-count").textContent = "";
}

function displayResult(data) {
  // 页面数据只作为文本呈现，避免将页面内容解析成 HTML。
  titleElement.textContent = data.title || "（无标题）";
  urlElement.textContent = data.url;
  countElement.textContent = `原文 ${data.totalCharacters.toLocaleString()}；返回 ${data.text.length.toLocaleString()}`;
  truncationElement.textContent = data.truncated
    ? `已截断，仅显示前 ${MAX_CHARACTERS.toLocaleString()} 个字符。`
    : "未截断";
  textElement.value = data.text;
  document.getElementById("raw-result").hidden = false;
  document.getElementById("raw-text").value = data.rawText;
  document.getElementById("raw-count").textContent = `清洗前 ${data.rawTotalCharacters.toLocaleString()} 个字符；${data.rawTruncated ? "已截断，仅保留前 30000 个字符" : "未截断"}。弹窗关闭后不保存。`;
  copyButton.disabled = !data.text.trim();
  modeElement.textContent = data.mode === "targeted" ? "targeted · 职位详情区域" : "fallback · 整页文本";
  document.getElementById("text-label").textContent = data.mode === "targeted" ? "完整 JD 原文（复制按钮复制此区域）" : "整页文本（备用方案）";
  qualityElement.textContent = data.quality.warnings.join("\n");
  qualityElement.hidden = !qualityElement.textContent;
  structuredElement.hidden = false;
  structuredElement.open = data.mode === "targeted";
  const fields = document.getElementById("job-fields");
  for (const [key, label] of Object.entries({ jobTitle: "职位名称", company: "公司名称", salary: "薪资范围", city: "工作城市", experience: "摘要经验要求", education: "摘要学历要求" })) {
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    term.textContent = label;
    value.textContent = data.job[key] || "未知";
    fields.append(term, value);
  }
  document.getElementById("missing-fields").textContent = `缺失或无法可靠识别：${data.quality.missingFieldLabels.join("、") || "无"}`;
  document.getElementById("summary-text").textContent = data.summaryText || "未可靠定位摘要。";
}


function describeReadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/no tab|tab.*closed|invalid tab|cannot find tab/i.test(message)) {
    return "当前标签页不存在或已经关闭，请打开网页后重试。";
  }
  if (/cannot access|cannot be scripted|extensions gallery|missing host permission/i.test(message)) {
    return "Chrome 不允许读取此页面，或页面跳转后临时授权已失效。请打开普通网页，再重新打开插件重试。";
  }
  return "脚本注入或页面读取失败。请等待网页加载完成，重新打开插件后重试。";
}

async function readCurrentPage() {
  resetResult();
  readButton.disabled = true;
  resultElement.setAttribute("aria-busy", "true");
  statusElement.textContent = "正在读取当前页面……";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !Number.isInteger(tab.id)) {
      throw new Error("No tab available");
    }
    // 提前识别常见特殊页面；其他禁止注入的情况交给 Chrome 拒绝并捕获。
    if (tab.url && !/^https?:\/\//i.test(tab.url)) {
      statusElement.textContent = "读取未完成。";
      showError("此原型仅支持普通 HTTP/HTTPS 网页。Chrome 内部页面、扩展页面等特殊页面无法读取。");
      return;
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageText,
      args: [MAX_CHARACTERS]
    });
    const data = results[0]?.result;
    if (!data || typeof data.text !== "string") {
      throw new Error("Missing extraction result");
    }
    // 展示和复制共用这一份清洗后的主文本；原始结果独立保留。
    const cleaning = cleanBossJD(data.text);
    const matched = cleaning.boundary !== null;
    const displayData = {
      ...data,
      text: cleaning.text,
      truncated: data.truncated && !matched,
      quality: {
        ...data.quality,
        warnings: [...data.quality.warnings, matched
          ? `已命中“${cleaning.boundary}”边界，该文字及后续内容已移除。`
          : "未命中结束边界，未截断 JD 正文；仅清理已确认的开头操作文字，原始结果可展开查看。"]
      }
    };
    displayResult(displayData);
    if (!displayData.text.trim()) {
      statusElement.textContent = "读取完成，但没有可显示的正文。";
      showError("当前页面没有可读取的正文，或网页内容尚未加载。请等待内容出现后重试。");
    } else {
      statusElement.textContent = "读取完成。";
    }
  } catch (error) {
    statusElement.textContent = "读取失败。";
    showError(describeReadError(error));
  } finally {
    readButton.disabled = false;
    resultElement.setAttribute("aria-busy", "false");
  }
}

async function copyExtractedText() {
  copyButton.disabled = true;
  errorElement.hidden = true;
  try {
    // 仅在用户点击时写入剪贴板，不读取剪贴板。
    await navigator.clipboard.writeText(textElement.value);
    statusElement.textContent = "已复制提取文本。";
  } catch {
    statusElement.textContent = "复制未完成。";
    showError("无法写入剪贴板。请在文本框中选择文本，按 Ctrl+C（macOS 为 Command+C）手动复制。");
  } finally {
    copyButton.disabled = !textElement.value.trim();
  }
}

readButton.addEventListener("click", readCurrentPage);
copyButton.addEventListener("click", copyExtractedText);
