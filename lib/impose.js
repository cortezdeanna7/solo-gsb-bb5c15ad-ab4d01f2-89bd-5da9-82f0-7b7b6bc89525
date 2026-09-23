'use strict';

const { PDFDocument, degrees } = require('pdf-lib');

/**
 * 分册签帖模式下，每帖纸张数上限（每纸容纳 4 页，即单帖容量上限 = 4 × 20 = 80 页）。
 */
const MAX_SHEETS_PER_SIGNATURE = 20;

/**
 * 骑马钉（saddle-stitch）拼版核心逻辑。
 *
 * 每张纸正反两页（两个 output PDF page），每排放两个原始页，即每张纸容纳 4 页：
 *   - 正面（front）：末页(左) | 首页(右)
 *   - 背面（back） ：第 2 页(左) | 倒数第 2 页(右)
 *   其余纸张按同样方式逐层向内递进。
 * 页数不是 4 的倍数时，在文档末尾补空白页。
 *
 * 分册签帖模式：按原页序把文档切成容量为 4 × 每帖纸张数的连续签帖，每帖
 * 独立按上述骑马钉规则排版，仅在各帖自身末尾补白；最后一帖不足上限时按
 * 实际页数所需纸张数收尾。结果按帖号顺序连续输出到同一个 PDF。
 *
 * 混合尺寸适配：各页尺寸或旋转方向不一致时，按每页旋转后的有效宽高取
 * 全部页面宽高的最大值作为统一面板尺寸；每页按其显示方向 1:1 居中放入
 * 对应半区，空余区域保持透明留白。
 */

/**
 * 根据原始页数返回需要补的空白页数（0~3）。
 * @param {number} sourceCount
 * @returns {number}
 */
function blanksForCount(sourceCount) {
  return (4 - (sourceCount % 4)) % 4;
}

/**
 * 生成拼版页序方案。
 *
 * 返回的每张纸：
 *   { sheet: 1, front: { left: 页码|null, right: 页码|null },
 *                   back:  { left: 页码|null, right: 页码|null } }
 * 页码从 1 开始；null 表示补齐的空白页（页码标识为 padded: true）。
 *
 * @param {number} sourceCount 原始 PDF 页数
 * @returns {{ sheets: Array, sourceCount: number, paddedCount: number, totalCount: number, blanks: number }}
 */
function buildImpositionPlan(sourceCount) {
  if (!Number.isInteger(sourceCount) || sourceCount < 1) {
    throw new Error('PDF 至少需要包含 1 页');
  }

  const blanks = blanksForCount(sourceCount);
  const totalCount = sourceCount + blanks;
  const sheetsPerSheet = totalCount / 4;

  const sheets = [];
  for (let i = 0; i < sheetsPerSheet; i += 1) {
    // 正面：从尾部取左页、从头部取右页
    const frontLeft = totalCount - 2 * i;       // 末页、倒数第 4、倒数第 8 ...
    const frontRight = 2 * i + 1;               // 首页、第 3 页、第 5 页 ...
    // 背面：从头部取左页、从尾部取右页
    const backLeft = 2 * i + 2;                 // 第 2 页、第 6 页、第 10 页 ...
    const backRight = totalCount - 2 * i - 1;   // 倒数第 2、倒数第 6 ...

    sheets.push({
      sheet: i + 1,
      front: {
        left: pageSlot(frontLeft, sourceCount),
        right: pageSlot(frontRight, sourceCount),
      },
      back: {
        left: pageSlot(backLeft, sourceCount),
        right: pageSlot(backRight, sourceCount),
      },
    });
  }

  return {
    sheets,
    sourceCount,
    paddedCount: blanks,
    totalCount,
    blanks,
  };
}

function pageSlot(position, sourceCount) {
  if (position <= sourceCount) {
    return { page: position, blank: false };
  }
  return { page: null, blank: true };
}

/**
 * 解析并校验「每帖最多纸张数」入参（分册签帖模式）。
 * 仅接受 1 ~ MAX_SHEETS_PER_SIGNATURE（20）之间的整数，其余一律拒绝。
 *
 * @param {*} value
 * @returns {number}
 */
function parseMaxSheetsPerSignature(value) {
  const message = `每帖最多纸张数必须是 1～${MAX_SHEETS_PER_SIGNATURE} 之间的整数`;
  if (typeof value === 'string') {
    if (!/^\s*\d+\s*$/.test(value)) throw new Error(message);
    value = Number(value.trim());
  }
  if (typeof value !== 'number' || !Number.isInteger(value)
    || value < 1 || value > MAX_SHEETS_PER_SIGNATURE) {
    throw new Error(message);
  }
  return value;
}

/**
 * 分册签帖模式下的单个槽位：页码使用全局（整篇文档）1 基页号。
 *
 * @param {number} position 帖内位置（1 基，含补白位置）
 * @param {number} sigSourceCount 该帖实际原始页数
 * @param {number} startPage 该帖首页的全局页号
 * @returns {{ page: number|null, blank: boolean }}
 */
function signatureSlot(position, sigSourceCount, startPage) {
  if (position <= sigSourceCount) {
    return { page: startPage + position - 1, blank: false };
  }
  return { page: null, blank: true };
}

/**
 * 生成分册签帖的拼版页序方案。
 *
 * 按原页序把 sourceCount 页切成容量 4 × maxSheetsPerSignature 的连续签帖：
 *   - 前序各帖装满 4 × max 页；最后一帖按实际页数收尾；
 *   - 仅在各帖自身末尾补白至 4 的倍数（blanks 0~3）；
 *   - 各帖独立按骑马钉规则生成纸张，帖内纸张编号 1 起；
 *   - 槽位页码为全局（整篇文档）1 基页号，便于后续统一绘制。
 *
 * @param {number} sourceCount 原始 PDF 总页数
 * @param {number} maxSheetsPerSignature 每帖最多纸张数（1～20）
 * @returns {{
 *   signatureMode: true,
 *   signatures: Array<{
 *     signature: number,
 *     startPage: number, endPage: number, sourceCount: number,
 *     blanks: number, totalCount: number,
 *     sheets: Array
 *   }>,
 *   sourceCount: number,
 *   paddedCount: number,
 *   sheetCount: number,
 *   signatureCount: number,
 *   maxSheetsPerSignature: number
 * }}
 */
function buildSignaturePlan(sourceCount, maxSheetsPerSignature) {
  if (!Number.isInteger(sourceCount) || sourceCount < 1) {
    throw new Error('PDF 至少需要包含 1 页');
  }
  const maxSheets = parseMaxSheetsPerSignature(maxSheetsPerSignature);
  const capacity = maxSheets * 4;

  const signatures = [];
  let paddedCount = 0;
  let sheetCount = 0;
  for (let start = 1; start <= sourceCount; start += capacity) {
    const sigSourceCount = Math.min(capacity, sourceCount - start + 1);
    const blanks = blanksForCount(sigSourceCount);
    const totalCount = sigSourceCount + blanks;
    const sheetsPerSignature = totalCount / 4;

    const sheets = [];
    for (let i = 0; i < sheetsPerSignature; i += 1) {
      // 同整册规则：正面尾|首，背面首+1|尾-1，逐张向内递进
      const frontLeft = totalCount - 2 * i;
      const frontRight = 2 * i + 1;
      const backLeft = 2 * i + 2;
      const backRight = totalCount - 2 * i - 1;

      sheets.push({
        sheet: i + 1,
        front: {
          left: signatureSlot(frontLeft, sigSourceCount, start),
          right: signatureSlot(frontRight, sigSourceCount, start),
        },
        back: {
          left: signatureSlot(backLeft, sigSourceCount, start),
          right: signatureSlot(backRight, sigSourceCount, start),
        },
      });
    }

    signatures.push({
      signature: signatures.length + 1,
      startPage: start,
      endPage: start + sigSourceCount - 1,
      sourceCount: sigSourceCount,
      blanks,
      totalCount,
      sheets,
    });
    paddedCount += blanks;
    sheetCount += sheets.length;
  }

  return {
    signatureMode: true,
    signatures,
    sourceCount,
    paddedCount,
    sheetCount,
    signatureCount: signatures.length,
    maxSheetsPerSignature: maxSheets,
  };
}

/**
 * 把 PDF 的 /Rotate 角度规范化为 0 / 90 / 180 / 270。
 * 负角、超圈角（如 -90、450）都会折算到标准直角；非 90 倍数按最近直角取整。
 * @param {number} angle
 * @returns {number}
 */
function normalizeRotation(angle) {
  const quarterTurns = Math.round((Number(angle) || 0) / 90);
  return (((quarterTurns % 4) + 4) % 4) * 90;
}

/**
 * 页面旋转后的有效宽高（即阅读器实际展示的宽高）。
 * 旋转 90°/270° 时宽高互换。
 *
 * @param {PDFPage} page pdf-lib 页面对象
 * @returns {{ rotation: number, width: number, height: number }}
 */
function effectivePageSize(page) {
  const rotation = normalizeRotation(page.getRotation().angle);
  const width = page.getWidth();
  const height = page.getHeight();
  const swapped = rotation === 90 || rotation === 270;
  return {
    rotation,
    width: swapped ? height : width,
    height: swapped ? width : height,
  };
}

/**
 * 混合尺寸适配：以全部页面有效宽、有效高的最大值作为统一面板尺寸，
 * 并据此给出面板方向（portrait 竖版 / landscape 横版 / square 方形）。
 *
 * @param {Array<{ width: number, height: number }>} pageSizes 各页有效宽高
 * @returns {{ width: number, height: number, orientation: string }}
 */
function computePanelSize(pageSizes) {
  if (!pageSizes.length) {
    throw new Error('PDF 不包含任何页面');
  }
  let width = 0;
  let height = 0;
  for (const size of pageSizes) {
    if (size.width > width) width = size.width;
    if (size.height > height) height = size.height;
  }
  let orientation = 'square';
  if (width > height) orientation = 'landscape';
  else if (height > width) orientation = 'portrait';
  return { width, height, orientation };
}

/**
 * 计算源页在半区内的绘制参数：页面按旋转后的显示方向 1:1 居中，不缩放。
 *
 * drawPage 的 rotate 以锚点 (x, y) 为原点**逆时针**旋转，而 PDF /Rotate 为
 * **顺时针**显示旋转，故取相反角度，并把锚点平移到旋转后内容包围盒对应的
 * 角上，使旋转后的内容恰好落在半区居中位置。
 *
 * @param {number} srcWidth 源页介质宽（未旋转）
 * @param {number} srcHeight 源页介质高（未旋转）
 * @param {number} rotation 规范化后的旋转角（0/90/180/270）
 * @param {number} originX 半区左边缘在纸面上的 x 坐标
 * @param {number} panelWidth 统一面板宽
 * @param {number} panelHeight 统一面板高
 * @returns {{ x: number, y: number, rotate: number }}
 */
function slotPlacement(srcWidth, srcHeight, rotation, originX, panelWidth, panelHeight) {
  const swapped = rotation === 90 || rotation === 270;
  const dispW = swapped ? srcHeight : srcWidth;
  const dispH = swapped ? srcWidth : srcHeight;
  const x = originX + (panelWidth - dispW) / 2;
  const y = (panelHeight - dispH) / 2;
  switch (rotation) {
    case 90:
      return { x, y: y + dispH, rotate: -90 };
    case 180:
      return { x: x + dispW, y: y + dispH, rotate: 180 };
    case 270:
      return { x: x + dispW, y, rotate: -270 };
    default:
      return { x, y, rotate: 0 };
  }
}

/**
 * 执行拼版并返回新 PDF 的字节数据。
 *
 * 输出每张纸为横向（landscape）尺寸：宽 = 2 × 面板宽，高 = 面板高。
 * 统一面板尺寸取全部页面旋转后有效宽高的最大值；每个原始页按其显示方向
 * 1:1（不缩放）居中绘制到对应半区，空余区域透明留白。补的空白页不绘制任何内容。
 *
 * 分册签帖模式（options.maxSheetsPerSignature 为 1～20 的整数）：先按容量
 * 4 × 每帖纸张数切成连续签帖，各帖独立补白与骑马钉排版，结果按帖号顺序
 * 连续输出到同一个 PDF。
 *
 * @param {Buffer|Uint8Array} sourceBytes 原始 PDF 字节
 * @param {{ maxSheetsPerSignature?: number }} [options]
 *        maxSheetsPerSignature 缺省/为空时保持整册拼版行为
 * @returns {Promise<{ pdfBytes: Uint8Array, plan: object }>}
 *          plan 中附带 panel：{ width, height, orientation } 统一面板信息
 */
async function imposePdf(sourceBytes, options = {}) {
  let srcDoc;
  try {
    srcDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: false });
    // 触发一次页树读取，损坏/被截断的文件会在此处暴露异常
    srcDoc.getPageCount();
  } catch (err) {
    throw new Error('文件不是有效的 PDF（可能已损坏或被加密）');
  }
  const sourceCount = srcDoc.getPageCount();
  if (sourceCount === 0) {
    throw new Error('PDF 不包含任何页面');
  }

  const signatureMode = options.maxSheetsPerSignature !== undefined
    && options.maxSheetsPerSignature !== null
    && options.maxSheetsPerSignature !== '';
  const plan = signatureMode
    ? buildSignaturePlan(sourceCount, options.maxSheetsPerSignature)
    : buildImpositionPlan(sourceCount);

  // 混合尺寸适配：逐页按旋转后的有效宽高计算，统一面板取全部页面宽高的最大值
  const pageInfos = srcDoc.getPages().map((page) => effectivePageSize(page));
  const panel = computePanelSize(pageInfos);
  plan.panel = panel;

  const outDoc = await PDFDocument.create();
  // 将全部源页作为 XObject 嵌入（保留其字体/图片/批注等资源），再逐页绘制到拼版纸上。
  // drawPage 需要 embedPdf 返回的 PDFEmbeddedPage（copyPages 的页面对象不能直接绘制）。
  const indices = Array.from({ length: sourceCount }, (_, i) => i);
  const embeddedPages = await outDoc.embedPdf(srcDoc, indices);

  const sheetWidth = panel.width * 2;
  const sheetHeight = panel.height;

  if (plan.signatureMode) {
    // 各帖依次输出；帖内纸张编号独立 1 起，页码为全局页号
    for (const signature of plan.signatures) {
      for (const sheet of signature.sheets) {
        renderSheet(outDoc, sheet, sheetWidth, sheetHeight, panel, embeddedPages, pageInfos);
      }
    }
    outDoc.setTitle(
      `拼版小册子（${sourceCount} 页 / ${plan.signatureCount} 帖 / ${plan.sheetCount} 张纸）`,
    );
  } else {
    for (const sheet of plan.sheets) {
      renderSheet(outDoc, sheet, sheetWidth, sheetHeight, panel, embeddedPages, pageInfos);
    }
    outDoc.setTitle(`拼版小册子（${sourceCount} 页 / ${plan.sheets.length} 张纸）`);
  }
  outDoc.setProducer('booklet-imposer (pdf-lib)');

  const pdfBytes = await outDoc.save();
  return { pdfBytes, plan };
}

/**
 * 在输出文档中追加一张纸（正面 + 背面两个输出页），并把槽位绘制到半区。
 */
function renderSheet(outDoc, sheet, sheetWidth, sheetHeight, panel, embeddedPages, pageInfos) {
  // 正面：左 | 右
  const front = outDoc.addPage([sheetWidth, sheetHeight]);
  drawSlot(front, sheet.front.left, embeddedPages, pageInfos, 0, panel);
  drawSlot(front, sheet.front.right, embeddedPages, pageInfos, panel.width, panel);

  // 背面：左 | 右
  const back = outDoc.addPage([sheetWidth, sheetHeight]);
  drawSlot(back, sheet.back.left, embeddedPages, pageInfos, 0, panel);
  drawSlot(back, sheet.back.right, embeddedPages, pageInfos, panel.width, panel);
}

/**
 * 把一个槽位（原始页或空白页）绘制到目标纸面上。
 * 原始页面按其旋转后的显示方向 1:1 居中绘制到自己的半区，不缩放；
 * 半区内未被覆盖的区域保持透明留白。
 */
function drawSlot(targetSheet, slot, embeddedPages, pageInfos, originX, panel) {
  if (slot.blank) {
    return; // 补的空白页：保持完全空白
  }
  const embedded = embeddedPages[slot.page - 1];
  const info = pageInfos[slot.page - 1];
  const { x, y, rotate } = slotPlacement(
    embedded.width,
    embedded.height,
    info.rotation,
    originX,
    panel.width,
    panel.height,
  );
  targetSheet.drawPage(embedded, { x, y, rotate: degrees(rotate) });
}

module.exports = {
  MAX_SHEETS_PER_SIGNATURE,
  blanksForCount,
  buildImpositionPlan,
  buildSignaturePlan,
  parseMaxSheetsPerSignature,
  normalizeRotation,
  effectivePageSize,
  computePanelSize,
  slotPlacement,
  imposePdf,
};
