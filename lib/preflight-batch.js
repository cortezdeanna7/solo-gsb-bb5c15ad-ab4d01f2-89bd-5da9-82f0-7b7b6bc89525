'use strict';

/**
 * PDF 印前批量校验（batch preflight）。
 *
 * 一次最多处理 BATCH_PREFLIGHT_MAX_FILES 个 PDF：按输入顺序逐个复用
 * lib/preflight.js 的单文件校验。单个文件缺失、为空、非 PDF、损坏或加密时，
 * 只在该文件的结果中记录失败原因与失败代码，不抛出、不阻断其余文件。
 *
 * 汇总信息：
 *   - 顶层 summary：成功校验/失败文件数与全部文件的错误/警告/提示总数；
 *   - issueTotals：按问题代码（code）汇总出现次数（同一文件内同一代码的
 *     一个区段计 1 次，文档级问题计 1 次）及涉及文件（索引 + 文件名）。
 *
 * 单文件接口（/api/preflight）与本模块完全独立，二者输出结构均保持不变。
 */

const { preflightPdf } = require('./preflight');

/** 单次批量校验允许的文件数量上限（含校验失败的文件） */
const BATCH_PREFLIGHT_MAX_FILES = 10;

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/** 失败文件提示文案：与服务端单文件接口的错误文案保持一致的口径 */
const FAILURE_MESSAGES = {
  not_pdf: '仅支持 PDF 文件',
  invalid_pdf: '文件不是有效的 PDF（可能已损坏或被加密），无法进行印前校验',
  encrypted_pdf: 'PDF 已加密，无法进行印前校验',
  empty_document: 'PDF 不包含任何页面，无法进行印前校验',
};

/**
 * 判断上传内容是否为 PDF：以 PDF 文件头魔数为准；部分浏览器以
 * application/octet-stream 上传时，回退校验文件名后缀。
 */
function looksLikePdf(buffer, originalname, mimetype) {
  if (!buffer || buffer.length === 0) return false;
  if (buffer.slice(0, 5).toString('latin1') === '%PDF-') return true;
  return (!mimetype || mimetype === 'application/octet-stream')
    && /\.pdf$/i.test(originalname || '');
}

/**
 * 对一组文件按顺序执行印前校验，返回完整批量报告。
 *
 * @param {Array<{ buffer: Buffer, originalname?: string, size?: number }>} files
 *        已完成 multipart 解析的文件（顺序即上传顺序）
 * @returns {Promise<object>} 批量报告对象（可直接 JSON 序列化下载）
 */
async function preflightPdfBatch(files) {
  const generatedAt = new Date().toISOString();
  const results = [];
  // code -> { count, files: Set, filesMeta: [{index, name}] }
  const codeAgg = new Map();

  let completed = 0;
  let failed = 0;
  let passedFiles = 0;
  let totalError = 0;
  let totalWarning = 0;
  let totalInfo = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const fileName = file && file.originalname ? file.originalname : null;
    const sizeBytes = typeof file.size === 'number' ? file.size : (file.buffer ? file.buffer.length : null);

    // 空文件（0 字节）无法按魔数判定，直接记为该文件失败，不阻断后续文件
    if (!file.buffer || file.buffer.length === 0
      || !looksLikePdf(file.buffer, file.originalname, file.mimetype)) {
      results.push({
        index,
        status: 'failed',
        file: { name: fileName, sizeBytes },
        pageCount: null,
        passed: false,
        errorCode: 'not_pdf',
        error: FAILURE_MESSAGES.not_pdf,
        counts: { error: 0, warning: 0, info: 0, issuesTotal: 0, pagesWithIssues: 0 },
        report: null,
      });
      failed += 1;
      continue;
    }

    let report;
    try {
      report = await preflightPdf(file.buffer, { fileName, sizeBytes });
    } catch (err) {
      const errorCode = (err && err.errCode) || 'invalid_pdf';
      results.push({
        index,
        status: 'failed',
        file: { name: fileName, sizeBytes },
        pageCount: null,
        passed: false,
        errorCode,
        error: FAILURE_MESSAGES[errorCode]
          || `无法校验该 PDF：${err && err.message ? err.message : '未知错误'}`,
        counts: { error: 0, warning: 0, info: 0, issuesTotal: 0, pagesWithIssues: 0 },
        report: null,
      });
      failed += 1;
      continue;
    }

    const { summary } = report;
    completed += 1;
    totalError += summary.error;
    totalWarning += summary.warning;
    totalInfo += summary.info;
    if (summary.passed) passedFiles += 1;

    // 同一文件内同一代码只计 1 次（区段已在单文件报告中合并）
    for (const issue of report.issues) {
      let entry = codeAgg.get(issue.code);
      if (!entry) {
        entry = {
          code: issue.code,
          severity: issue.severity,
          title: issue.title,
          count: 0,
          filesSet: new Set(),
          files: [],
        };
        codeAgg.set(issue.code, entry);
      }
      entry.count += 1;
      if (!entry.filesSet.has(index)) {
        entry.filesSet.add(index);
        entry.files.push({ index, name: fileName });
      }
    }

    results.push({
      index,
      status: 'completed',
      file: { name: fileName, sizeBytes },
      pageCount: report.pageCount,
      passed: summary.passed,
      errorCode: null,
      error: null,
      counts: {
        error: summary.error,
        warning: summary.warning,
        info: summary.info,
        issuesTotal: summary.issuesTotal,
        pagesWithIssues: summary.pagesWithIssues,
      },
      // 完整单文件报告原样内嵌，保证「下载完整批量 JSON」内容齐备
      report,
    });
  }

  const issueTotals = [...codeAgg.values()]
    .map((entry) => ({
      code: entry.code,
      severity: entry.severity,
      title: entry.title,
      count: entry.count,
      files: entry.files,
      fileCount: entry.files.length,
    }))
    .sort((a, b) => {
      const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (rankDiff !== 0) return rankDiff;
      return a.code.localeCompare(b.code);
    });

  return {
    schemaVersion: 1,
    kind: 'preflight-batch',
    tool: 'booklet-imposer',
    generatedAt,
    limit: BATCH_PREFLIGHT_MAX_FILES,
    summary: {
      total: results.length,
      completed,
      failed,
      passed: passedFiles,
      error: totalError,
      warning: totalWarning,
      info: totalInfo,
      // 所有成功校验的文件均无错误级问题才算整批通过
      allPassed: failed === 0 && passedFiles === results.length,
    },
    issueTotals,
    files: results,
  };
}

module.exports = {
  BATCH_PREFLIGHT_MAX_FILES,
  FAILURE_MESSAGES,
  looksLikePdf,
  preflightPdfBatch,
};
