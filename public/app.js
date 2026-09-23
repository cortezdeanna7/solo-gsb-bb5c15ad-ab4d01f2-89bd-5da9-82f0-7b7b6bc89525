'use strict';

const fileInput = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const fileName = document.getElementById('file-name');
const imposeBtn = document.getElementById('impose-btn');
const preflightBtn = document.getElementById('preflight-btn');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const previewEl = document.getElementById('preview');
const sheetsEl = document.getElementById('sheets');
const downloadBtn = document.getElementById('download-btn');
const signatureModeInput = document.getElementById('signature-mode');
const maxSheetsField = document.getElementById('max-sheets-field');
const maxSheetsInput = document.getElementById('max-sheets');
const summaryListEl = document.getElementById('summary-list');
const signatureSummaryEl = document.getElementById('signature-summary');

const reportEl = document.getElementById('report');
const reportVerdictEl = document.getElementById('report-verdict');
const reportSummaryEl = document.getElementById('report-summary');
const issueListEl = document.getElementById('issue-list');
const reportEmptyEl = document.getElementById('report-empty');
const reportDownloadBtn = document.getElementById('report-download-btn');
const pageTableBody = document.getElementById('page-table-body');
const pageDetailCount = document.getElementById('page-detail-count');
const filterChips = document.querySelectorAll('.filter-chip');
const filterCountEls = document.querySelectorAll('.chip-count');

const MAX_SHEETS = 20;

let selectedFile = null;
let resultBlobUrl = null;
let resultBaseName = 'booklet';
let preflightReport = null;
let activeLevelFilter = 'all';

signatureModeInput.addEventListener('change', () => {
  maxSheetsField.hidden = !signatureModeInput.checked;
});

/**
 * 校验每帖最多纸张数：仅接受 1～20 的整数。
 * @returns {number|null} 合法时返回整数，非法时返回 null（并已设置错误提示）
 */
function readMaxSheets() {
  const raw = maxSheetsInput.value;
  if (!/^\s*\d+\s*$/.test(raw)) {
    setStatus(`请填写每帖最多纸张数（1～${MAX_SHEETS} 的整数）`, 'error');
    return null;
  }
  const value = Number(raw.trim());
  if (value < 1 || value > MAX_SHEETS) {
    setStatus(`每帖最多纸张数必须在 1～${MAX_SHEETS} 之间`, 'error');
    return null;
  }
  return value;
}

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = kind ? `status ${kind}` : 'status';
}

function clearResult() {
  if (resultBlobUrl) {
    URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = null;
  }
  summaryEl.hidden = true;
  previewEl.hidden = true;
  sheetsEl.innerHTML = '';
  summaryListEl.innerHTML = '';
  signatureSummaryEl.hidden = true;
  signatureSummaryEl.innerHTML = '';
  clearQuote();
}

/**
 * 重新选择文件时清空上一份校验报告；报告 JSON 通过 Blob 下载。
 */
function clearReport() {
  preflightReport = null;
  reportEl.hidden = true;
  issueListEl.innerHTML = '';
  pageTableBody.innerHTML = '';
  reportSummaryEl.innerHTML = '';
  reportVerdictEl.textContent = '';
  activeLevelFilter = 'all';
  updateFilterChips();
}

function selectFile(file) {
  clearResult();
  clearReport();
  if (!file) {
    selectedFile = null;
    fileName.textContent = '';
    imposeBtn.disabled = true;
    preflightBtn.disabled = true;
    return;
  }
  if (file.type && file.type !== 'application/pdf') {
    setStatus('请选择 PDF 文件', 'error');
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  resultBaseName = (file.name || 'booklet').replace(/\.pdf$/i, '');
  imposeBtn.disabled = false;
  preflightBtn.disabled = false;
  setStatus(`已选择：${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`, 'info');
}

// ---------- 印前校验 ----------

const SEVERITY_LABELS = { error: '错误', warning: '警告', info: '提示' };

function formatRange(issue) {
  if (issue.pageFrom === null || issue.pageTo === null) return '整篇文档';
  return issue.pageFrom === issue.pageTo
    ? `第 ${issue.pageFrom} 页`
    : `第 ${issue.pageFrom}～${issue.pageTo} 页`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

preflightBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  preflightBtn.disabled = true;
  imposeBtn.disabled = true;
  setStatus('正在执行印前校验，不会生成拼版文件…', 'info');

  const form = new FormData();
  form.append('pdf', selectedFile);

  try {
    const resp = await fetch('/api/preflight', { method: 'POST', body: form });
    if (!resp.ok) {
      let message = `校验失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }
    preflightReport = await resp.json();
    renderReport(preflightReport);
    const { summary } = preflightReport;
    if (summary.error > 0) {
      setStatus(`校验完成：发现 ${summary.error} 个错误、${summary.warning} 个警告、`
        + `${summary.info} 个提示。仍可继续拼版，请先评估错误项。`, 'error');
    } else if (summary.warning > 0 || summary.info > 0) {
      setStatus(`校验完成：${summary.warning} 个警告、${summary.info} 个提示，不影响继续拼版。`, 'info');
    } else {
      setStatus('校验完成：未发现印前问题，可以直接拼版。', 'info');
    }
  } catch (err) {
    setStatus(err.message || '印前校验失败', 'error');
  } finally {
    preflightBtn.disabled = false;
    imposeBtn.disabled = false;
  }
});

function renderReport(report) {
  reportEl.hidden = false;

  const { summary, referenceSize } = report;
  reportVerdictEl.className = `report-verdict ${summary.passed ? 'ok' : 'bad'}`;
  reportVerdictEl.textContent = summary.passed
    ? `结论：未发现错误级问题（${report.pageCount} 页；主尺寸 ${referenceSize.widthMm} × `
      + `${referenceSize.heightMm} mm）。警告/提示可选择性处理，拼版不受阻断。`
    : `结论：发现 ${summary.error} 个错误级问题（${report.pageCount} 页；主尺寸 `
      + `${referenceSize.widthMm} × ${referenceSize.heightMm} mm）。建议修复后再印刷，`
      + '但仍可继续拼版。';

  renderReportSummary(summary);
  renderIssueList(report.issues);
  renderPageTable(report.pages);

  filterCountEls.forEach((el) => {
    const level = el.dataset.count;
    el.textContent = level === 'all' ? report.issues.length : summary[level];
  });
}

function renderReportSummary(summary) {
  reportSummaryEl.innerHTML = '';
  const cards = [
    { level: 'error', label: '错误', count: summary.error },
    { level: 'warning', label: '警告', count: summary.warning },
    { level: 'info', label: '提示', count: summary.info },
    { level: 'pages', label: '涉及页面', count: summary.pagesWithIssues },
  ];
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = `report-stat ${card.level}`;
    div.innerHTML = `<span class="stat-num">${card.count}</span>`
      + `<span class="stat-label">${card.label}</span>`;
    reportSummaryEl.appendChild(div);
  }
}

function updateFilterChips() {
  filterChips.forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.level === activeLevelFilter);
  });
}

filterChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    activeLevelFilter = chip.dataset.level;
    updateFilterChips();
    if (preflightReport) renderIssueList(preflightReport.issues);
  });
});

function renderIssueList(issues) {
  issueListEl.innerHTML = '';
  const visible = activeLevelFilter === 'all'
    ? issues
    : issues.filter((issue) => issue.severity === activeLevelFilter);

  reportEmptyEl.hidden = visible.length !== 0;

  for (const issue of visible) {
    const li = document.createElement('li');
    li.className = `issue ${issue.severity}`;

    const head = document.createElement('div');
    head.className = 'issue-head';
    const badge = document.createElement('span');
    badge.className = `severity-badge ${issue.severity}`;
    badge.textContent = SEVERITY_LABELS[issue.severity];
    const title = document.createElement('span');
    title.className = 'issue-title';
    title.textContent = issue.title;
    const range = document.createElement('span');
    range.className = 'issue-range';
    range.textContent = formatRange(issue)
      + (issue.pageCount > 1 ? `（连续 ${issue.pageCount} 页）` : '');
    head.append(badge, title, range);
    li.appendChild(head);

    const message = document.createElement('p');
    message.className = 'issue-message';
    message.textContent = issue.message;
    li.appendChild(message);

    if (issue.values && issue.values.length) {
      const dl = document.createElement('dl');
      dl.className = 'issue-values';
      for (const value of issue.values) {
        const dt = document.createElement('dt');
        dt.textContent = value.label;
        const dd = document.createElement('dd');
        dd.textContent = value.value;
        dl.append(dt, dd);
      }
      li.appendChild(dl);
    }

    const advice = document.createElement('p');
    advice.className = 'issue-advice';
    advice.innerHTML = `<strong>修复建议：</strong>${escapeHtml(issue.advice)}`;
    li.appendChild(advice);

    issueListEl.appendChild(li);
  }
}

function renderPageTable(pages) {
  pageTableBody.innerHTML = '';
  pageDetailCount.textContent = String(pages.length);
  const frag = document.createDocumentFragment();
  for (const p of pages) {
    const tr = document.createElement('tr');
    tr.className = p.issues.length ? 'has-issue' : 'clean';
    const issueText = p.issues.length
      ? p.issues.map((i) => SEVERITY_LABELS[i.severity] + '·' + i.title).join('；')
      : '—';
    tr.innerHTML = `<td>第 ${p.page} 页</td>`
      + `<td>${p.effectiveWidth.toFixed(1)} × ${p.effectiveHeight.toFixed(1)} pt`
      + `（${p.widthMm} × ${p.heightMm} mm）</td>`
      + `<td>${p.rotation}°</td>`
      + `<td>${p.transparent ? '是' : '否'}</td>`
      + `<td>${p.textExtractable === null ? '无法判定' : (p.textExtractable ? '可提取' : '不可提取')}</td>`
      + `<td class="page-issues">${escapeHtml(issueText)}</td>`;
    frag.appendChild(tr);
  }
  pageTableBody.appendChild(frag);
}

reportDownloadBtn.addEventListener('click', () => {
  if (!preflightReport) return;
  const json = JSON.stringify(preflightReport, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${resultBaseName}-印前校验报告.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  selectFile(file);
});

['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  selectFile(file);
});

imposeBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  const useSignatures = signatureModeInput.checked;
  let maxSheets = null;
  if (useSignatures) {
    maxSheets = readMaxSheets();
    if (maxSheets === null) return;
  }

  imposeBtn.disabled = true;
  setStatus('正在拼版，请稍候…', 'info');
  clearResult();

  const form = new FormData();
  form.append('pdf', selectedFile);
  if (useSignatures) {
    form.append('signatureMode', 'on');
    form.append('maxSheetsPerSignature', String(maxSheets));
  }

  try {
    const resp = await fetch('/api/impose', { method: 'POST', body: form });

    if (!resp.ok) {
      let message = `拼版失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }

    const planHeader = resp.headers.get('X-Imposition-Plan');
    if (!planHeader) throw new Error('响应缺少拼版方案');
    const plan = JSON.parse(decodeURIComponent(planHeader));

    const blob = await resp.blob();
    resultBlobUrl = URL.createObjectURL(blob);

    renderSummary(plan);
    renderPreview(plan);
    setStatus('拼版完成，可预览页序或下载 PDF。', 'info');
    requestQuote(plan);
  } catch (err) {
    setStatus(err.message || '拼版失败', 'error');
  } finally {
    imposeBtn.disabled = false;
  }
});

downloadBtn.addEventListener('click', () => {
  if (!resultBlobUrl) return;
  const a = document.createElement('a');
  a.href = resultBlobUrl;
  a.download = `${resultBaseName}-拼版.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

const ORIENTATION_LABELS = {
  portrait: '竖版',
  landscape: '横版',
  square: '方形',
};

function ptToMm(pt) {
  return ((pt * 25.4) / 72).toFixed(1);
}

function appendSummaryItem(label, value) {
  const li = document.createElement('li');
  const strong = document.createElement('strong');
  strong.textContent = value;
  li.append(`${label}：`, strong);
  summaryListEl.appendChild(li);
}

function renderSummary(plan) {
  const sheetCount = plan.signatureMode ? plan.sheetCount : plan.sheets.length;
  appendSummaryItem('原始页数', `${plan.sourceCount} 页`);
  appendSummaryItem('末尾补白', `${plan.paddedCount} 页`);
  if (plan.signatureMode) {
    appendSummaryItem(
      '签帖数量',
      `${plan.signatureCount} 帖（每帖最多 ${plan.maxSheetsPerSignature} 张纸）`,
    );
  }
  appendSummaryItem('用纸数量', `${sheetCount} 张（每张正反 4 页）`);
  if (plan.panel) {
    const { width, height, orientation } = plan.panel;
    appendSummaryItem(
      '统一面板',
      `${width.toFixed(1)} × ${height.toFixed(1)} pt（约 ${ptToMm(width)} × ${ptToMm(height)} mm）`,
    );
    appendSummaryItem('页面方向', ORIENTATION_LABELS[orientation] || orientation);
  }

  if (plan.signatureMode) {
    renderSignatureSummary(plan);
  }
  summaryEl.hidden = false;
}

function renderSignatureSummary(plan) {
  const wrap = document.createElement('div');

  const hint = document.createElement('p');
  hint.className = 'signature-hint';
  hint.textContent = `按原页序切分为 ${plan.signatureCount} 帖，各帖仅在帖末补白；`
    + '结果 PDF 按帖号顺序连续输出，下载仍为一个文件。';
  wrap.appendChild(hint);

  const table = document.createElement('table');
  table.className = 'signature-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr>'
    + '<th>帖号</th><th>原始页范围</th><th>原始页数</th>'
    + '<th>帖末补白</th><th>帖内纸张编号</th><th>用纸</th>'
    + '</tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const sig of plan.signatures) {
    const tr = document.createElement('tr');
    const range = sig.sourceCount === 1
      ? `第 ${sig.startPage} 页`
      : `第 ${sig.startPage} ～ ${sig.endPage} 页`;
    const sheetNums = sig.sheets.map((s) => s.sheet).join(', ');
    tr.innerHTML = `<td>第 ${sig.signature} 帖</td>`
      + `<td>${range}</td>`
      + `<td>${sig.sourceCount} 页</td>`
      + `<td>${sig.blanks} 页</td>`
      + `<td class="sheet-nums">第 ${sheetNums} 张</td>`
      + `<td>${sig.sheets.length} 张</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  signatureSummaryEl.innerHTML = '';
  signatureSummaryEl.appendChild(wrap);
  signatureSummaryEl.hidden = false;
}

/**
 * 统一遍历方案中的纸张：整册模式直接遍历 plan.sheets；
 * 签帖模式按帖序遍历，并在每帖前插入帖标题分组。
 */
function forEachSheet(plan, callbacks) {
  if (plan.signatureMode) {
    for (const sig of plan.signatures) {
      callbacks.onSignature(sig);
      for (const sheet of sig.sheets) {
        callbacks.onSheet(sheet, sig);
      }
    }
  } else {
    for (const sheet of plan.sheets) {
      callbacks.onSheet(sheet, null);
    }
  }
}

function renderPreview(plan) {
  const frag = document.createDocumentFragment();
  // 预览按真实纸张比例渲染：宽 = 2 × 面板宽，高 = 面板高
  const sheetRatio = plan.panel && plan.panel.height > 0
    ? (2 * plan.panel.width) / plan.panel.height
    : 2;

  forEachSheet(plan, {
    onSignature(sig) {
      const group = document.createElement('div');
      group.className = 'signature-group';
      const range = sig.sourceCount === 1
        ? `第 ${sig.startPage} 页`
        : `第 ${sig.startPage} ～ ${sig.endPage} 页`;
      group.textContent = `第 ${sig.signature} 帖 · 原始页 ${range} · 帖末补白 ${sig.blanks} 页`
        + ` · 用纸 ${sig.sheets.length} 张`;
      frag.appendChild(group);
    },
    onSheet(sheet, sig) {
      const card = document.createElement('div');
      card.className = 'sheet';

      const title = document.createElement('div');
      title.className = 'sheet-title';
      if (sig) {
        title.textContent = `第 ${sig.signature} 帖 · 帖内第 ${sheet.sheet} 张纸 / 共 ${sig.sheets.length} 张`;
      } else {
        title.textContent = `第 ${sheet.sheet} 张纸 / 共 ${plan.sheets.length} 张`;
      }
      card.appendChild(title);

      card.appendChild(buildSide('正面', sheet.front, false, sheetRatio));
      card.appendChild(buildSide('背面', sheet.back, true, sheetRatio));

      frag.appendChild(card);
    },
  });
  sheetsEl.appendChild(frag);
  previewEl.hidden = false;
}

function buildSide(labelText, side, isBack, sheetRatio) {
  const sideEl = document.createElement('div');
  sideEl.className = 'side';

  const label = document.createElement('span');
  label.className = isBack ? 'side-label back' : 'side-label';
  label.textContent = labelText;
  sideEl.appendChild(label);

  const spread = document.createElement('div');
  spread.className = 'spread';
  spread.style.aspectRatio = String(sheetRatio);
  spread.appendChild(buildPanel(side.left, 'left'));
  spread.appendChild(buildPanel(side.right, 'right'));

  sideEl.appendChild(spread);
  return sideEl;
}

function buildPanel(slot, position) {
  const panel = document.createElement('div');
  panel.className = slot.blank ? 'panel blank' : 'panel';

  const pos = document.createElement('span');
  pos.className = `pos ${position}`;
  pos.textContent = position === 'left' ? '左' : '右';
  panel.appendChild(pos);

  if (slot.blank) {
    const tag = document.createElement('span');
    tag.className = 'blank-tag';
    tag.textContent = '空白页';
    panel.appendChild(tag);
  } else {
    const num = document.createElement('span');
    num.textContent = `第 ${slot.page} 页`;
    panel.appendChild(num);
  }
  return panel;
}

// ---------- 印前报告差异对比 ----------

const diffBaselineInput = document.getElementById('diff-baseline-input');
const diffDeliveryInput = document.getElementById('diff-delivery-input');
const diffBaselineName = document.getElementById('diff-baseline-name');
const diffDeliveryName = document.getElementById('diff-delivery-name');
const diffBtn = document.getElementById('diff-btn');
const diffStatusEl = document.getElementById('diff-status');
const diffReportEl = document.getElementById('diff-report');
const diffVerdictEl = document.getElementById('diff-verdict');
const diffMetaEl = document.getElementById('diff-meta');
const diffSummaryEl = document.getElementById('diff-summary');
const diffIssueListEl = document.getElementById('diff-issue-list');
const diffIssueEmptyEl = document.getElementById('diff-issue-empty');
const diffPageTableBody = document.getElementById('diff-page-table-body');
const diffPageCount = document.getElementById('diff-page-count');
const diffDownloadBtn = document.getElementById('diff-download-btn');
const diffFilterChips = document.querySelectorAll('.diff-filter-chip');

const DIFF_GROUP_LABELS = { added: '新增问题', resolved: '已解决', persistent: '仍存在' };
const DIFF_STATUS_LABELS = { added: '新增页', removed: '移除页', retained: '保留页' };

let diffBaselineFile = null;
let diffDeliveryFile = null;
let diffReportData = null;
let activeDiffGroup = 'added';

function setDiffStatus(text, kind) {
  diffStatusEl.textContent = text || '';
  diffStatusEl.className = kind ? `status ${kind}` : 'status';
}

function updateDiffButton() {
  diffBtn.disabled = !diffBaselineFile || !diffDeliveryFile;
}

/**
 * 重新选择任一对比文件时清空上一次差异结果。
 */
function clearDiffReport() {
  diffReportData = null;
  diffReportEl.hidden = true;
  diffIssueListEl.innerHTML = '';
  diffPageTableBody.innerHTML = '';
  diffSummaryEl.innerHTML = '';
  diffMetaEl.innerHTML = '';
  diffVerdictEl.textContent = '';
}

function pickDiffFile(input, nameEl, which) {
  const file = input.files && input.files[0];
  clearDiffReport();
  if (!file) {
    if (which === 'baseline') {
      diffBaselineFile = null;
      nameEl.textContent = '点击选择基准 PDF';
    } else {
      diffDeliveryFile = null;
      nameEl.textContent = '点击选择待交付 PDF';
    }
    updateDiffButton();
    return;
  }
  if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    setDiffStatus('请选择 PDF 文件', 'error');
    input.value = '';
    return;
  }
  if (which === 'baseline') {
    diffBaselineFile = file;
  } else {
    diffDeliveryFile = file;
  }
  nameEl.textContent = `${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`;
  setDiffStatus('', '');
  updateDiffButton();
}

diffBaselineInput.addEventListener('change', () => {
  pickDiffFile(diffBaselineInput, diffBaselineName, 'baseline');
});
diffDeliveryInput.addEventListener('change', () => {
  pickDiffFile(diffDeliveryInput, diffDeliveryName, 'delivery');
});

diffBtn.addEventListener('click', async () => {
  if (!diffBaselineFile || !diffDeliveryFile) return;
  diffBtn.disabled = true;
  setDiffStatus('正在分别校验两份 PDF 并生成差异对比…', 'info');

  const form = new FormData();
  form.append('baseline', diffBaselineFile);
  form.append('delivery', diffDeliveryFile);

  try {
    const resp = await fetch('/api/preflight/diff', { method: 'POST', body: form });
    if (!resp.ok) {
      let message = `差异对比失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }
    diffReportData = await resp.json();
    activeDiffGroup = 'added';
    updateDiffFilterChips();
    renderDiffReport(diffReportData);
    const { summary } = diffReportData;
    if (summary.added.total > 0) {
      setDiffStatus(`对比完成：新增 ${summary.added.total} 项、已解决 ${summary.resolved.total} 项、`
        + `仍存在 ${summary.persistent.total} 项问题（按页计；文档级问题各计 1 项）。`, 'error');
    } else if (summary.persistent.total > 0) {
      setDiffStatus(`对比完成：无新增问题；已解决 ${summary.resolved.total} 项，`
        + `仍有 ${summary.persistent.total} 项问题存在。`, 'info');
    } else {
      setDiffStatus('对比完成：基准中的问题已全部解决，且未引入新问题。', 'info');
    }
  } catch (err) {
    clearDiffReport();
    setDiffStatus(err.message || '差异对比失败', 'error');
  } finally {
    diffBtn.disabled = false;
  }
});

function renderDiffMeta(data) {
  const { baseline, delivery, pageCount } = data;
  const deltaText = pageCount.delta === 0
    ? '页数一致'
    : (pageCount.delta > 0
      ? `增加 ${pageCount.delta} 页`
      : `减少 ${Math.abs(pageCount.delta)} 页`);
  const fileLine = (label, info) => {
    const name = info.file && info.file.name ? info.file.name : '未命名 PDF';
    return `<div class="diff-meta-item"><span class="diff-meta-label">${label}</span>`
      + `<span class="diff-meta-value">${escapeHtml(name)} · ${info.pageCount} 页</span></div>`;
  };
  diffMetaEl.innerHTML = fileLine('基准 PDF', baseline)
    + fileLine('待交付 PDF', delivery)
    + `<div class="diff-meta-item"><span class="diff-meta-label">页数变化</span>`
    + `<span class="diff-meta-value">${baseline.pageCount} → ${delivery.pageCount} 页（${deltaText}）`
    + `，新增页 ${pageCount.addedPages.length} / 移除页 ${pageCount.removedPages.length}</span></div>`;
}

function renderDiffSummary(data) {
  diffSummaryEl.innerHTML = '';
  const { summary } = data;
  const cards = [
    { level: 'error', label: '新增问题', count: summary.added.total },
    { level: 'ok', label: '已解决', count: summary.resolved.total },
    { level: 'warning', label: '仍存在', count: summary.persistent.total },
    { level: 'pages', label: '页数变化', count: data.pageCount.delta, signed: true },
  ];
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = `report-stat ${card.level}`;
    const numText = card.signed && card.count > 0 ? `+${card.count}` : String(card.count);
    div.innerHTML = `<span class="stat-num">${numText}</span>`
      + `<span class="stat-label">${card.label}</span>`;
    diffSummaryEl.appendChild(div);
  }
}

function renderDiffVerdict(data) {
  const addedErrors = countSeverity(data.added, 'error');
  const resolvedErrors = countSeverity(data.resolved, 'error');
  const persistentErrors = countSeverity(data.persistent, 'error');
  diffVerdictEl.className = 'report-verdict '
    + (addedErrors > 0 || persistentErrors > 0 ? 'bad' : 'ok');
  diffVerdictEl.textContent = addedErrors > 0
    ? `结论：待交付版本引入了 ${addedErrors} 个错误级问题（仍存在错误 ${persistentErrors} 个，`
      + `已解决错误 ${resolvedErrors} 个），建议修复后再交付。`
    : (persistentErrors > 0
      ? `结论：未引入新的错误级问题；仍有 ${persistentErrors} 个错误级问题未解决`
        + `（已解决 ${resolvedErrors} 个），请确认后交付。`
      : `结论：待交付版本无错误级问题（已解决 ${resolvedErrors} 个错误，无残留错误）。`);
}

function countSeverity(entries, severity) {
  return entries
    .filter((entry) => entry.severity === severity)
    .reduce((sum, entry) => sum + (entry.documentLevel ? 1 : entry.pages.length), 0);
}

function updateDiffFilterChips() {
  diffFilterChips.forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.group === activeDiffGroup);
  });
}

diffFilterChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    activeDiffGroup = chip.dataset.group;
    updateDiffFilterChips();
    if (diffReportData) renderDiffIssueList(diffReportData);
  });
});

function formatDiffPageList(pages) {
  if (!pages.length) return '—';
  return pages.map((p) => `第 ${p} 页`).join('、');
}

function renderDiffIssueList(data) {
  diffIssueListEl.innerHTML = '';
  const groups = { added: data.added, resolved: data.resolved, persistent: data.persistent };
  const entries = groups[activeDiffGroup];

  diffIssueEmptyEl.hidden = entries.length !== 0;
  diffIssueEmptyEl.textContent = entries.length === 0
    ? {
      added: '未发现新增问题：待交付版本没有引入新的印前问题。',
      resolved: '没有已解决的问题：基准中的问题在待交付版本中依然存在（或基准本无问题）。',
      persistent: '没有仍存在的问题：两个版本未在相同页码/文档级上同时命中同一问题。',
    }[activeDiffGroup]
    : '';

  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = `issue ${entry.severity} diff-${activeDiffGroup}`;

    const head = document.createElement('div');
    head.className = 'issue-head';
    const typeBadge = document.createElement('span');
    typeBadge.className = `diff-tag ${activeDiffGroup}`;
    typeBadge.textContent = DIFF_GROUP_LABELS[activeDiffGroup];
    const severityBadge = document.createElement('span');
    severityBadge.className = `severity-badge ${entry.severity}`;
    severityBadge.textContent = SEVERITY_LABELS[entry.severity];
    const title = document.createElement('span');
    title.className = 'issue-title';
    title.textContent = entry.title;
    const range = document.createElement('span');
    range.className = 'issue-range';
    range.textContent = entry.documentLevel
      ? '整篇文档'
      : `${formatDiffPageList(entry.pages)}（${entry.pages.length} 页）`;
    head.append(typeBadge, severityBadge, title, range);
    li.appendChild(head);

    const dl = document.createElement('dl');
    dl.className = 'issue-values';
    const appendValue = (label, value) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value || '—';
      dl.append(dt, dd);
    };
    if (entry.documentLevel) {
      appendValue('基准说明', entry.baselineDetail);
      appendValue('待交付说明', entry.deliveryDetail);
      if (activeDiffGroup === 'persistent' && entry.detailChanged) {
        const note = document.createElement('p');
        note.className = 'diff-detail-changed';
        note.textContent = '问题仍存在，但检测值已发生变化，见上。';
        li.appendChild(note);
      }
    } else {
      const detailText = (items) => items.length
        ? items.map((d) => `第 ${d.page} 页：${d.detail || '存在'}`).join('；')
        : '';
      if (activeDiffGroup === 'added') {
        appendValue('待交付检测值', detailText(entry.deliveryDetails));
      } else if (activeDiffGroup === 'resolved') {
        appendValue('基准检测值', detailText(entry.baselineDetails));
      } else {
        appendValue('基准检测值', detailText(entry.baselineDetails));
        appendValue('待交付检测值', detailText(entry.deliveryDetails));
        if (entry.detailChangedPages.length) {
          const note = document.createElement('p');
          note.className = 'diff-detail-changed';
          note.textContent = `检测值变化：${formatDiffPageList(entry.detailChangedPages)}`;
          li.appendChild(note);
        }
      }
    }
    li.appendChild(dl);

    if (entry.advice) {
      const advice = document.createElement('p');
      advice.className = 'issue-advice';
      advice.innerHTML = `<strong>修复建议：</strong>${escapeHtml(entry.advice)}`;
      li.appendChild(advice);
    }

    diffIssueListEl.appendChild(li);
  }
}

function metricCell(record) {
  if (!record) return '—';
  const text = record.textExtractable === null
    ? '无法判定'
    : (record.textExtractable ? '可提取' : '不可提取');
  return `${record.mediaWidth} × ${record.mediaHeight} pt`
    + ` / ${record.rotation}° / ${record.transparent ? '透明' : '不透明'} / ${text}`;
}

function changeMarks(changes) {
  if (!changes) return '';
  const marks = [];
  if (changes.sizeChanged) marks.push('尺寸变化');
  if (changes.rotationChanged) marks.push('旋转变化');
  if (changes.transparencyChanged) marks.push('透明度变化');
  if (changes.textChanged) marks.push('文字可提取性变化');
  return marks.length
    ? `<span class="diff-change-marks">${marks.map(escapeHtml).join('、')}</span>`
    : '';
}

function issueCodeChips(codes, group, codeTitles) {
  if (!codes.length) return '—';
  return codes
    .map((code) => `<span class="diff-code-chip ${group}">${escapeHtml(codeTitles[code] || code)}</span>`)
    .join(' ');
}

function renderDiffPageTable(data) {
  diffPageTableBody.innerHTML = '';
  diffPageCount.textContent = String(data.pages.length);

  // 代码 -> 标题，取自三个分组中的条目（兜底直接显示代码）
  const codeTitles = {};
  for (const group of ['added', 'resolved', 'persistent']) {
    for (const entry of data[group]) codeTitles[entry.code] = entry.title;
  }

  const frag = document.createDocumentFragment();
  for (const row of data.pages) {
    const tr = document.createElement('tr');
    tr.className = `diff-page-${row.status}`;
    const statusText = DIFF_STATUS_LABELS[row.status];
    const metrics = row.status === 'retained'
      ? `${metricCell(row.baseline)} → ${metricCell(row.delivery)}`
      : (row.baseline ? metricCell(row.baseline) : metricCell(row.delivery));
    tr.innerHTML = `<td>第 ${row.page} 页</td>`
      + `<td><span class="diff-page-status ${row.status}">${statusText}</span></td>`
      + `<td>${escapeHtml(metrics)} ${changeMarks(row.changes)}</td>`
      + `<td>${issueCodeChips(row.issues.added, 'added', codeTitles)}</td>`
      + `<td>${issueCodeChips(row.issues.resolved, 'resolved', codeTitles)}</td>`
      + `<td>${issueCodeChips(row.issues.persistent, 'persistent', codeTitles)}</td>`;
    frag.appendChild(tr);
  }
  diffPageTableBody.appendChild(frag);
}

function renderDiffReport(data) {
  renderDiffVerdict(data);
  renderDiffMeta(data);
  renderDiffSummary(data);
  document.getElementById('diff-count-added').textContent = String(data.added.length);
  document.getElementById('diff-count-resolved').textContent = String(data.resolved.length);
  document.getElementById('diff-count-persistent').textContent = String(data.persistent.length);
  renderDiffIssueList(data);
  renderDiffPageTable(data);
  diffReportEl.hidden = false;
}

diffDownloadBtn.addEventListener('click', () => {
  if (!diffReportData) return;
  const json = JSON.stringify(diffReportData, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '印前报告差异对比.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------- 印刷用纸规格维护 ----------

const PAPER_STORAGE_KEY = 'booklet-imposer-papers-v1';
const PAPER_LIMIT = 8;
const DEFAULT_PAPERS = [
  { name: 'A3 铜版纸', widthMm: 420, heightMm: 297, pricePerSheet: 0.8, setupFee: 50 },
  { name: 'A2 胶版纸', widthMm: 424, heightMm: 594, pricePerSheet: 2.2, setupFee: 80 },
  { name: '正度对开 787×1092', widthMm: 546, heightMm: 787, pricePerSheet: 1.6, setupFee: 60 },
];

const paperTableBody = document.getElementById('paper-table-body');
const paperAddBtn = document.getElementById('paper-add-btn');
const paperResetBtn = document.getElementById('paper-reset-btn');
const paperErrorEl = document.getElementById('paper-error');

const quoteBoxEl = document.getElementById('quote-box');
const quoteStatusEl = document.getElementById('quote-status');
const quoteResultEl = document.getElementById('quote-result');
const quoteRefreshBtn = document.getElementById('quote-refresh-btn');
const quoteDownloadBtn = document.getElementById('quote-download-btn');

let paperRows = [];
let lastPlan = null;
let quoteData = null;
let chosenOptionIndex = null;

/**
 * 从 localStorage 读取已保存的纸张规格；损坏/缺失时回退默认值。
 * @returns {Array<object>}
 */
function loadStoredPapers() {
  try {
    const raw = localStorage.getItem(PAPER_STORAGE_KEY);
    if (!raw) return DEFAULT_PAPERS.map((p) => ({ ...p }));
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)
      && parsed.length > 0
      && parsed.every((p) => p && typeof p === 'object')) {
      return parsed.slice(0, PAPER_LIMIT).map((p, i) => ({
        name: typeof p.name === 'string' ? p.name : `纸张 ${i + 1}`,
        widthMm: String(p.widthMm ?? ''),
        heightMm: String(p.heightMm ?? ''),
        pricePerSheet: String(p.pricePerSheet ?? ''),
        setupFee: String(p.setupFee ?? ''),
      }));
    }
  } catch (_) { /* 存储损坏时使用默认 */ }
  return DEFAULT_PAPERS.map((p) => ({ ...p }));
}

function persistPapers() {
  try {
    localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify(paperRows));
  } catch (_) { /* 隐私模式等场景下忽略持久化失败 */ }
}

/**
 * 从表格中读取当前全部纸张规格。
 * @returns {{ papers: Array, errors: Array<string> }}
 */
function readPaperInputs() {
  const papers = [];
  const errors = [];
  paperTableBody.querySelectorAll('tr.paper-row').forEach((tr, i) => {
    const inputs = tr.querySelectorAll('input');
    const [nameInput, widthInput, heightInput, priceInput, setupInput] = inputs;
    const name = nameInput.value.trim() || `纸张 ${i + 1}`;
    const widthMm = Number(widthInput.value);
    const heightMm = Number(heightInput.value);
    const pricePerSheet = Number(priceInput.value);
    const setupFee = Number(setupInput.value);

    let bad = false;
    for (const input of [widthInput, heightInput, priceInput, setupInput]) {
      input.classList.toggle('invalid', false);
    }
    if (!(widthMm > 0)) {
      widthInput.classList.add('invalid');
      bad = true;
    }
    if (!(heightMm > 0)) {
      heightInput.classList.add('invalid');
      bad = true;
    }
    if (!(pricePerSheet >= 0)) {
      priceInput.classList.add('invalid');
      bad = true;
    }
    if (!(setupFee >= 0)) {
      setupInput.classList.add('invalid');
      bad = true;
    }
    if (bad) {
      errors.push(`纸张「${name}」的宽/高必须为正数，单价与开机费不能为负`);
      return;
    }
    papers.push({ name, widthMm, heightMm, pricePerSheet, setupFee });
  });
  return { papers, errors };
}

function syncPaperRowsFromDom() {
  paperRows = [];
  paperTableBody.querySelectorAll('tr.paper-row').forEach((tr) => {
    const inputs = tr.querySelectorAll('input');
    paperRows.push({
      name: inputs[0].value,
      widthMm: inputs[1].value,
      heightMm: inputs[2].value,
      pricePerSheet: inputs[3].value,
      setupFee: inputs[4].value,
    });
  });
  persistPapers();
  paperAddBtn.disabled = paperRows.length >= PAPER_LIMIT;
}

function addPaperRow(paper = { name: '', widthMm: '', heightMm: '', pricePerSheet: '', setupFee: '' }) {
  const tr = document.createElement('tr');
  tr.className = 'paper-row';

  const mkCell = (value, { type = 'number', step, min, placeholder } = {}) => {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = type;
    input.className = 'paper-input';
    if (type === 'number') {
      input.step = step || 'any';
      if (min !== undefined) input.min = min;
    }
    if (placeholder) input.placeholder = placeholder;
    input.value = value === null || value === undefined ? '' : String(value);
    input.addEventListener('input', () => {
      syncPaperRowsFromDom();
      paperErrorEl.textContent = '';
      markQuoteStale();
    });
    td.appendChild(input);
    return td;
  };

  tr.appendChild(mkCell(paper.name, { type: 'text', placeholder: '如 A3 铜版' }));
  tr.appendChild(mkCell(paper.widthMm, { min: 0, placeholder: '宽' }));
  tr.appendChild(mkCell(paper.heightMm, { min: 0, placeholder: '高' }));
  tr.appendChild(mkCell(paper.pricePerSheet, { min: 0, placeholder: '0.00' }));
  tr.appendChild(mkCell(paper.setupFee, { min: 0, placeholder: '0.00' }));

  const opTd = document.createElement('td');
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'paper-del-btn';
  delBtn.textContent = '删除';
  delBtn.addEventListener('click', () => {
    tr.remove();
    syncPaperRowsFromDom();
    paperErrorEl.textContent = '';
    markQuoteStale();
  });
  opTd.appendChild(delBtn);
  tr.appendChild(opTd);

  paperTableBody.appendChild(tr);
}

function renderPaperRows(rows) {
  paperTableBody.innerHTML = '';
  for (const paper of rows) addPaperRow(paper);
  syncPaperRowsFromDom();
}

paperAddBtn.addEventListener('click', () => {
  if (paperTableBody.querySelectorAll('tr.paper-row').length >= PAPER_LIMIT) return;
  addPaperRow();
  syncPaperRowsFromDom();
});

paperResetBtn.addEventListener('click', () => {
  renderPaperRows(DEFAULT_PAPERS.map((p) => ({
    name: p.name,
    widthMm: String(p.widthMm),
    heightMm: String(p.heightMm),
    pricePerSheet: String(p.pricePerSheet),
    setupFee: String(p.setupFee),
  })));
  paperErrorEl.textContent = '';
  markQuoteStale();
});

renderPaperRows(loadStoredPapers());

// ---------- 用纸报价 ----------

function clearQuote() {
  quoteData = null;
  lastPlan = null;
  chosenOptionIndex = null;
  quoteBoxEl.hidden = true;
  quoteResultEl.hidden = true;
  quoteResultEl.innerHTML = '';
  quoteStatusEl.textContent = '';
  quoteStatusEl.className = 'status';
}

/**
 * 纸张规格编辑后，若已有拼版结果，提示报价可能已过期（不自动请求）。
 */
function markQuoteStale() {
  if (lastPlan && quoteData && !quoteRefreshBtn.dataset.stale) {
    quoteRefreshBtn.dataset.stale = '1';
    quoteRefreshBtn.classList.add('stale');
    quoteStatusEl.textContent = '纸张规格已修改，点击「按当前纸张重新报价」更新。';
    quoteStatusEl.className = 'status info';
  }
}

async function requestQuote(plan) {
  lastPlan = plan;
  quoteRefreshBtn.disabled = true;
  quoteRefreshBtn.dataset.stale = '';
  quoteRefreshBtn.classList.remove('stale');
  quoteBoxEl.hidden = false;
  quoteResultEl.hidden = true;
  quoteStatusEl.textContent = '正在根据拼版方案计算用纸报价…';
  quoteStatusEl.className = 'status info';

  const { papers, errors } = readPaperInputs();
  syncPaperRowsFromDom();
  if (errors.length) {
    paperErrorEl.textContent = errors.join('；');
    quoteRefreshBtn.disabled = false;
    quoteStatusEl.textContent = '纸张规格存在未填或非法项，已暂停报价，请先修正后重新报价。';
    quoteStatusEl.className = 'status error';
    return;
  }
  paperErrorEl.textContent = '';
  if (papers.length === 0) {
    quoteRefreshBtn.disabled = false;
    quoteStatusEl.textContent = '尚未维护任何纸张规格，请先在上方增加至少一种。';
    quoteStatusEl.className = 'status error';
    return;
  }

  try {
    const resp = await fetch('/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, papers }),
    });
    if (!resp.ok) {
      let message = `报价失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 使用默认提示 */ }
      throw new Error(message);
    }
    quoteData = await resp.json();
    chosenOptionIndex = quoteData.selected ? quoteData.selected.index : null;
    renderQuoteResult();
    if (quoteData.feasible) {
      quoteStatusEl.textContent = `已选最低成本方案：${quoteData.selected.name}`
        + `（有效利用率 ${quoteData.selected.utilizationPercent}%，总价 ¥${quoteData.selected.totalCost.toFixed(2)}）。`;
      quoteStatusEl.className = 'status info';
    } else {
      quoteStatusEl.textContent = '维护的纸张均无法容纳版面，见下方原因。';
      quoteStatusEl.className = 'status error';
    }
  } catch (err) {
    quoteData = null;
    quoteResultEl.hidden = true;
    quoteStatusEl.textContent = err.message || '报价失败';
    quoteStatusEl.className = 'status error';
  } finally {
    quoteRefreshBtn.disabled = false;
  }
}

quoteRefreshBtn.addEventListener('click', () => {
  if (lastPlan) requestQuote(lastPlan);
});

const fmtMoney = (v) => `¥${Number(v).toFixed(2)}`;
const fmtMm = (v) => `${Number(v).toFixed(1)} mm`;

/**
 * 渲染报价结果：可行时列出全部纸张并允许切换方案；不可行时给出每种纸张的原因。
 */
function renderQuoteResult() {
  quoteResultEl.innerHTML = '';

  const { layout } = quoteData;
  const layoutLine = document.createElement('p');
  layoutLine.className = 'quote-layout';
  layoutLine.textContent = `单张印张展开尺寸 ${fmtMm(layout.sheet.widthMm)} × ${fmtMm(layout.sheet.heightMm)}`
    + `（统一面板 ${fmtMm(layout.panel.widthMm)} × ${fmtMm(layout.panel.heightMm)}）`
    + `；共 ${layout.sheetCount} 张纸，开机 ${layout.runCount} 次`
    + (layout.signatureMode ? `（${layout.signatureCount} 帖，每帖各 1 次）` : '');
  quoteResultEl.appendChild(layoutLine);

  if (!quoteData.feasible) {
    const banner = document.createElement('div');
    banner.className = 'quote-infeasible';
    banner.textContent = quoteData.reason;
    quoteResultEl.appendChild(banner);
  }

  const list = document.createElement('div');
  list.className = 'quote-options';
  for (const opt of quoteData.options) {
    list.appendChild(renderQuoteOption(opt));
  }
  quoteResultEl.appendChild(list);
  quoteResultEl.hidden = false;
}

function renderQuoteOption(opt) {
  const card = document.createElement('div');
  card.className = 'quote-option';
  if (!opt.fits) card.classList.add('infeasible');
  if (opt.fits && opt.index === chosenOptionIndex) card.classList.add('chosen');

  const head = document.createElement('div');
  head.className = 'quote-option-head';

  const title = document.createElement('div');
  title.className = 'quote-option-title';
  if (opt.fits) {
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'quote-paper';
    radio.checked = opt.index === chosenOptionIndex;
    radio.addEventListener('change', () => {
      chosenOptionIndex = opt.index;
      quoteResultEl.querySelectorAll('.quote-option').forEach((el) => {
        el.classList.toggle('chosen', el.dataset.index === String(opt.index));
      });
    });
    title.appendChild(radio);
  }
  const name = document.createElement('strong');
  name.textContent = opt.name;
  title.appendChild(name);
  const spec = document.createElement('span');
  spec.className = 'quote-option-spec';
  spec.textContent = `${opt.paper.widthMm} × ${opt.paper.heightMm} mm`;
  title.appendChild(spec);
  head.appendChild(title);

  const total = document.createElement('div');
  total.className = 'quote-total';
  total.textContent = opt.fits ? fmtMoney(opt.totalCost) : '无法使用';
  head.appendChild(total);
  card.appendChild(head);

  if (opt.fits) {
    const grid = document.createElement('dl');
    grid.className = 'quote-detail';
    const placementText = opt.placement.rotated ? '纸张旋转 90°' : '纸张原向';
    const items = [
      ['摆放方向', `${placementText}（用纸 ${opt.placement.paperWidthUsedMm} × ${opt.placement.paperHeightUsedMm} mm）`],
      ['有效利用率', `${opt.utilizationPercent}%`],
      ['纸张费', `${fmtMoney(opt.paperCost)}（${opt.sheetCount} 张 × ¥${opt.paper.pricePerSheet}）`],
      ['开机费', `${fmtMoney(opt.setupCost)}（${opt.runCount} 次 × ¥${opt.paper.setupFee}）`],
      ['总价', fmtMoney(opt.totalCost)],
    ];
    for (const [label, value] of items) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      if (label === '总价') dd.className = 'quote-detail-total';
      grid.append(dt, dd);
    }
    card.appendChild(grid);
  } else {
    const reasons = document.createElement('ul');
    reasons.className = 'quote-reasons';
    for (const r of opt.reasons) {
      const li = document.createElement('li');
      li.textContent = r.message;
      reasons.appendChild(li);
    }
    card.appendChild(reasons);
  }

  card.dataset.index = String(opt.index);
  return card;
}

quoteDownloadBtn.addEventListener('click', () => {
  if (!quoteData) return;
  // 下载内容反映用户在页面上切换后选中的纸张方案
  const chosen = quoteData.feasible
    ? quoteData.options.find((o) => o.fits && o.index === chosenOptionIndex) || quoteData.selected
    : null;
  const payload = {
    ...quoteData,
    selected: chosen,
    chosenPaperIndex: chosen ? chosen.index : null,
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${resultBaseName}-用纸报价.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------- 批量印前校验 ----------

const BATCH_FILE_LIMIT = 10;

const batchFilesInput = document.getElementById('batch-files-input');
const batchPickName = document.getElementById('batch-pick-name');
const batchFileListEl = document.getElementById('batch-file-list');
const batchRunBtn = document.getElementById('batch-run-btn');
const batchClearBtn = document.getElementById('batch-clear-btn');
const batchStatusEl = document.getElementById('batch-status');
const batchReportEl = document.getElementById('batch-report');
const batchVerdictEl = document.getElementById('batch-verdict');
const batchSummaryEl = document.getElementById('batch-summary');
const batchTableBody = document.getElementById('batch-table-body');
const batchFileCountEl = document.getElementById('batch-file-count');
const batchCodeTableBody = document.getElementById('batch-code-table-body');
const batchCodeCountEl = document.getElementById('batch-code-count');
const batchDownloadBtn = document.getElementById('batch-download-btn');

let batchFiles = [];
let batchReportData = null;

const BATCH_STATUS_LABELS = {
  completed_passed: '通过',
  completed_failed: '有错误',
  failed: '校验失败',
};

const BATCH_FAILURE_TEXT = {
  not_pdf: '不是 PDF 文件（文件头不是 %PDF-，或文件为空）',
  invalid_pdf: '文件损坏或无法解析，不是有效的 PDF',
  encrypted_pdf: 'PDF 已加密，无法校验',
  empty_document: 'PDF 不包含任何页面',
};

function setBatchStatus(text, kind) {
  batchStatusEl.textContent = text || '';
  batchStatusEl.className = kind ? `status ${kind}` : 'status';
}

function updateBatchButtons() {
  batchRunBtn.disabled = batchFiles.length === 0;
  batchClearBtn.disabled = batchFiles.length === 0;
}

function clearBatchReport() {
  batchReportData = null;
  batchReportEl.hidden = true;
  batchTableBody.innerHTML = '';
  batchCodeTableBody.innerHTML = '';
  batchSummaryEl.innerHTML = '';
  batchVerdictEl.textContent = '';
}

function renderBatchFileList() {
  batchFileListEl.innerHTML = '';
  if (batchFiles.length === 0) {
    batchFileListEl.hidden = true;
    batchPickName.textContent = '点击选择 1～10 个 PDF 文件';
    return;
  }
  batchFileListEl.hidden = false;
  batchPickName.textContent = `已选择 ${batchFiles.length} 个 PDF（点击可重新选择）`;
  const frag = document.createDocumentFragment();
  batchFiles.forEach((file, i) => {
    const li = document.createElement('li');
    li.className = 'batch-file-item';
    const idx = document.createElement('span');
    idx.className = 'batch-file-idx';
    idx.textContent = String(i + 1);
    const name = document.createElement('span');
    name.className = 'batch-file-name-item';
    name.textContent = file.name;
    const size = document.createElement('span');
    size.className = 'batch-file-size';
    size.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
    li.append(idx, name, size);
    frag.appendChild(li);
  });
  batchFileListEl.appendChild(frag);
}

batchFilesInput.addEventListener('change', () => {
  const picked = Array.from(batchFilesInput.files || []);
  clearBatchReport();
  if (picked.length === 0) {
    batchFiles = [];
    renderBatchFileList();
    updateBatchButtons();
    return;
  }
  if (picked.length > BATCH_FILE_LIMIT) {
    setBatchStatus(`批量校验一次最多选择 ${BATCH_FILE_LIMIT} 个 PDF，当前选了 ${picked.length} 个。`, 'error');
    batchFiles = [];
    batchFilesInput.value = '';
    renderBatchFileList();
    updateBatchButtons();
    return;
  }
  // 前端给出类型提示；即使选错也照常上传，由服务端在该文件结果中标记 not_pdf
  const nonPdf = picked.filter((f) => f.type && f.type !== 'application/pdf'
    && !/\.pdf$/i.test(f.name));
  if (nonPdf.length) {
    setBatchStatus(`所选文件中 ${nonPdf.length} 个不是 .pdf 文件，校验时会分别记录失败原因。`, 'error');
  } else {
    setBatchStatus('', '');
  }
  batchFiles = picked;
  renderBatchFileList();
  updateBatchButtons();
});

batchClearBtn.addEventListener('click', () => {
  batchFiles = [];
  batchFilesInput.value = '';
  clearBatchReport();
  renderBatchFileList();
  updateBatchButtons();
  setBatchStatus('', '');
});

batchRunBtn.addEventListener('click', async () => {
  if (batchFiles.length === 0) return;
  batchRunBtn.disabled = true;
  batchClearBtn.disabled = true;
  setBatchStatus(`正在按顺序校验 ${batchFiles.length} 个 PDF，不生成拼版文件…`, 'info');
  clearBatchReport();

  const form = new FormData();
  batchFiles.forEach((file) => form.append('pdfs', file));

  try {
    const resp = await fetch('/api/preflight/batch', { method: 'POST', body: form });
    if (!resp.ok) {
      let message = `批量校验失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }
    batchReportData = await resp.json();
    renderBatchReport(batchReportData);
    const { summary } = batchReportData;
    if (summary.failed > 0) {
      setBatchStatus(`批量校验完成：${summary.completed} 个成功、${summary.failed} 个文件无法校验；`
        + `成功文件共发现 ${summary.error} 个错误、${summary.warning} 个警告、${summary.info} 个提示。`, 'error');
    } else if (summary.error > 0) {
      setBatchStatus(`批量校验完成：${summary.passed} / ${summary.total} 个文件通过；`
        + `共 ${summary.error} 个错误、${summary.warning} 个警告、${summary.info} 个提示。`, 'error');
    } else if (summary.warning > 0 || summary.info > 0) {
      setBatchStatus(`批量校验完成：全部 ${summary.total} 个文件无错误级问题；`
        + `${summary.warning} 个警告、${summary.info} 个提示。`, 'info');
    } else {
      setBatchStatus(`批量校验完成：全部 ${summary.total} 个文件通过，未发现印前问题。`, 'info');
    }
  } catch (err) {
    clearBatchReport();
    setBatchStatus(err.message || '批量校验失败', 'error');
  } finally {
    batchRunBtn.disabled = false;
    batchClearBtn.disabled = false;
  }
});

function renderBatchSummary(summary) {
  batchSummaryEl.innerHTML = '';
  const cards = [
    { level: 'pages', label: '文件总数', count: summary.total },
    { level: 'ok', label: '校验通过', count: summary.passed },
    { level: 'error', label: '无法校验', count: summary.failed },
    { level: 'error', label: '错误', count: summary.error },
    { level: 'warning', label: '警告', count: summary.warning },
    { level: 'info', label: '提示', count: summary.info },
  ];
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = `report-stat ${card.level}`;
    div.innerHTML = `<span class="stat-num">${card.count}</span>`
      + `<span class="stat-label">${card.label}</span>`;
    batchSummaryEl.appendChild(div);
  }
}

/**
 * 在可展开行下方插入整行明细：失败文件显示失败原因；成功文件复用单文件
 * 报告的问题区段渲染逻辑（徽章 + 标题 + 范围 + 说明 + 修复建议）。
 */
function buildBatchDetailRow(item) {
  const detailTr = document.createElement('tr');
  detailTr.className = 'batch-detail-row';
  const td = document.createElement('td');
  td.colSpan = 8;
  const inner = document.createElement('div');
  inner.className = 'batch-detail-inner';

  if (item.status === 'failed') {
    const p = document.createElement('p');
    p.className = 'batch-fail-reason';
    p.textContent = `失败原因：${item.error
      || (BATCH_FAILURE_TEXT[item.errorCode] || '未知错误')}`;
    inner.appendChild(p);
  } else {
    const report = item.report;
    if (!report || !report.issues.length) {
      const p = document.createElement('p');
      p.className = 'batch-clean';
      p.textContent = '未发现印前问题，可以直接拼版。';
      inner.appendChild(p);
    } else {
      const list = document.createElement('ul');
      list.className = 'issue-list';
      for (const issue of report.issues) {
        list.appendChild(buildBatchIssueElement(issue));
      }
      inner.appendChild(list);
    }
  }
  td.appendChild(inner);
  detailTr.appendChild(td);
  return detailTr;
}

function buildBatchIssueElement(issue) {
  const li = document.createElement('li');
  li.className = `issue ${issue.severity}`;

  const head = document.createElement('div');
  head.className = 'issue-head';
  const badge = document.createElement('span');
  badge.className = `severity-badge ${issue.severity}`;
  badge.textContent = SEVERITY_LABELS[issue.severity];
  const title = document.createElement('span');
  title.className = 'issue-title';
  title.textContent = issue.title;
  const range = document.createElement('span');
  range.className = 'issue-range';
  range.textContent = formatRange(issue)
    + (issue.pageCount > 1 ? `（连续 ${issue.pageCount} 页）` : '');
  head.append(badge, title, range);
  li.appendChild(head);

  const message = document.createElement('p');
  message.className = 'issue-message';
  message.textContent = issue.message;
  li.appendChild(message);

  if (issue.values && issue.values.length) {
    const dl = document.createElement('dl');
    dl.className = 'issue-values';
    for (const value of issue.values) {
      const dt = document.createElement('dt');
      dt.textContent = value.label;
      const dd = document.createElement('dd');
      dd.textContent = value.value;
      dl.append(dt, dd);
    }
    li.appendChild(dl);
  }

  const advice = document.createElement('p');
  advice.className = 'issue-advice';
  advice.innerHTML = `<strong>修复建议：</strong>${escapeHtml(issue.advice)}`;
  li.appendChild(advice);
  return li;
}

function renderBatchTable(files) {
  batchTableBody.innerHTML = '';
  batchFileCountEl.textContent = String(files.length);
  const frag = document.createDocumentFragment();
  files.forEach((item) => {
    const tr = document.createElement('tr');
    const failed = item.status === 'failed';
    tr.className = failed ? 'batch-row failed' : 'batch-row';

    const state = failed
      ? BATCH_STATUS_LABELS.failed
      : (item.passed ? BATCH_STATUS_LABELS.completed_passed : BATCH_STATUS_LABELS.completed_failed);
    const stateClass = failed ? 'failed' : (item.passed ? 'ok' : 'bad');
    const counts = item.counts || { error: 0, warning: 0, info: 0, issuesTotal: 0 };

    tr.innerHTML = `<td class="batch-idx">${item.index + 1}</td>`
      + `<td><span class="batch-state ${stateClass}">${state}</span></td>`
      + `<td class="batch-name">${escapeHtml(item.file && item.file.name ? item.file.name : '未命名文件')}</td>`
      + `<td>${item.pageCount === null ? '—' : `${item.pageCount} 页`}</td>`
      + `<td>${counts.error}</td><td>${counts.warning}</td><td>${counts.info}</td>`
      + `<td>${counts.issuesTotal}${failed ? ` <span class="batch-row-hint">（点击查看原因）</span>` : ''}</td>`;

    // 点击主行切换该文件的明细行展开状态
    const detailTr = buildBatchDetailRow(item);
    detailTr.hidden = true;
    tr.addEventListener('click', () => {
      const willOpen = detailTr.hidden;
      detailTr.hidden = !willOpen;
      tr.classList.toggle('expanded', willOpen);
    });
    frag.appendChild(tr);
    frag.appendChild(detailTr);
  });
  batchTableBody.appendChild(frag);
}

function renderBatchCodeTotals(issueTotals) {
  batchCodeTableBody.innerHTML = '';
  batchCodeCountEl.textContent = String(issueTotals.length);
  if (!issueTotals.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="6" class="batch-code-empty">全部文件均未发现印前问题。</td>';
    batchCodeTableBody.appendChild(tr);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const item of issueTotals) {
    const tr = document.createElement('tr');
    const fileText = item.files
      .map((f) => `${f.index + 1}. ${f.name || '未命名文件'}`)
      .join('；');
    tr.innerHTML = `<td><code>${escapeHtml(item.code)}</code></td>`
      + `<td><span class="severity-badge ${item.severity}">${SEVERITY_LABELS[item.severity]}</span></td>`
      + `<td>${escapeHtml(item.title)}</td>`
      + `<td>${item.count}</td>`
      + `<td>${item.fileCount}</td>`
      + `<td class="batch-code-files">${escapeHtml(fileText)}</td>`;
    frag.appendChild(tr);
  }
  batchCodeTableBody.appendChild(frag);
}

function renderBatchReport(data) {
  batchReportEl.hidden = false;
  const { summary } = data;
  batchVerdictEl.className = `report-verdict ${summary.allPassed ? 'ok' : 'bad'}`;
  if (summary.failed > 0) {
    batchVerdictEl.textContent = `结论：共 ${summary.total} 个文件，${summary.completed} 个完成校验`
      + `（其中 ${summary.passed} 个通过），${summary.failed} 个文件无法校验（缺失/非 PDF/损坏/加密），`
      + '请展开对应行查看失败原因。';
  } else if (summary.allPassed) {
    batchVerdictEl.textContent = `结论：全部 ${summary.total} 个文件均无错误级问题，警告/提示可选择性处理。`;
  } else {
    batchVerdictEl.textContent = `结论：${summary.total} 个文件全部完成校验，其中 ${summary.passed} 个通过；`
      + `共 ${summary.error} 个错误级问题，建议修复后再印刷。`;
  }
  renderBatchSummary(summary);
  renderBatchTable(data.files);
  renderBatchCodeTotals(data.issueTotals);
}

batchDownloadBtn.addEventListener('click', () => {
  if (!batchReportData) return;
  const json = JSON.stringify(batchReportData, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '批量印前校验报告.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
