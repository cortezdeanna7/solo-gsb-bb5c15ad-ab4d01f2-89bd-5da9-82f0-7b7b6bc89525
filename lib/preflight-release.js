'use strict';

/**
 * 批量印前校验的「交付放行判定」（release decision）。
 *
 * 在原检测报告（lib/preflight.js 的错误/警告/提示）之上叠加一层可配置的
 * 处置策略（policy）：
 *   - 按问题代码（code）把命中的问题处置为 block（阻断）/ warn（警告）/ ignore（忽略）；
 *   - 未显式配置的代码沿用默认：错误 → 阻断，警告 → 警告，提示 → 忽略。
 *
 * 逐文件判定（decision）：
 *   - 命中任一 block 代码 → block（阻断，不予放行）；
 *   - 否则命中任一 warn 代码 → review（需复核）；
 *   - 否则（无问题或命中代码均为 ignore）→ pass（通过，准予放行）；
 *   - 文件无法校验（缺失/非 PDF/损坏/加密）→ undetermined（未判定）。
 *
 * 整批判定按 阻断 > 未判定 > 需复核 > 通过 聚合：任一批阻断即整批阻断；
 * 无阻断但存在无法校验文件时整批未判定（不得盲目放行）；其余依次降级。
 *
 * 本模块只做判定与策略解析，不改变单文件检测报告及 summary.passed 的含义。
 */

const { ISSUE_META } = require('./preflight');

/** 未显式配置时按检测严重级别的默认处置 */
const DEFAULT_ACTION_BY_SEVERITY = { error: 'block', warning: 'warn', info: 'ignore' };

const ACTIONS = ['block', 'warn', 'ignore'];
const ACTION_RANK = { block: 0, warn: 1, ignore: 2 };

/** 处置 -> 该处置在放行判定中的结论（ignore 等同于放行） */
const ACTION_DECISION = { block: 'block', warn: 'review', ignore: 'pass' };

/** 整批聚合优先级：阻断 > 未判定 > 需复核 > 通过 */
const BATCH_DECISION_RANK = { block: 0, undetermined: 1, review: 2, pass: 3 };

const RELEASE_DECISIONS = ['block', 'review', 'pass', 'undetermined'];

/**
 * 解析放行策略。
 *
 * 接受：
 *   - undefined / null / 空字符串：空策略（全部走默认处置）；
 *   - 字符串：须为合法 JSON，形如 { "rules": { "transparency": "ignore" } }，
 *     也接受直接以代码为键的裸映射 { "transparency": "ignore" }；
 *   - 对象：同上述两种形态。
 *
 * 顶层 JSON 非法或 rules 不是对象时抛错（调用方据此返回 400）；
 * 未知代码或非法处置值不抛错，登记到 ignoredRules 后忽略，避免阻断批量流程。
 *
 * @returns {{ rules: Object<string,string>, ignoredRules: Array<{code:string, action:string, reason:string}> }>
 */
function parseReleasePolicy(input) {
  const ignoredRules = [];
  if (input === undefined || input === null || input === '') {
    return { rules: {}, ignoredRules };
  }

  let obj = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch (_) {
      const err = new Error('放行策略不是合法的 JSON，请检查策略配置');
      err.code = 'invalid_policy_json';
      throw err;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    const err = new Error('放行策略必须是 JSON 对象（如 {"rules":{"transparency":"ignore"}}）');
    err.code = 'invalid_policy_shape';
    throw err;
  }

  const rawRules = Object.prototype.hasOwnProperty.call(obj, 'rules') ? obj.rules : obj;
  if (!rawRules || typeof rawRules !== 'object' || Array.isArray(rawRules)) {
    const err = new Error('放行策略的 rules 必须是「问题代码 → 处置」的 JSON 对象');
    err.code = 'invalid_policy_shape';
    throw err;
  }

  const rules = {};
  for (const [code, action] of Object.entries(rawRules)) {
    if (!Object.prototype.hasOwnProperty.call(ISSUE_META, code)) {
      ignoredRules.push({ code, action: String(action), reason: 'unknown_code' });
      continue;
    }
    if (!ACTIONS.includes(action)) {
      ignoredRules.push({ code, action: action === null ? 'null' : String(action), reason: 'invalid_action' });
      continue;
    }
    rules[code] = action;
  }
  return { rules, ignoredRules };
}

/**
 * 解析单个问题代码在当前策略下的处置与来源。
 *
 * @returns {{ action: 'block'|'warn'|'ignore', source: 'rule'|'default' }}
 */
function resolveIssueAction(code, severity, rulesMap) {
  if (rulesMap && rulesMap.has(code)) {
    return { action: rulesMap.get(code), source: 'rule' };
  }
  return { action: DEFAULT_ACTION_BY_SEVERITY[severity] || 'warn', source: 'default' };
}

function describeAction(action) {
  if (action === 'block') return '阻断';
  if (action === 'warn') return '警告';
  return '忽略';
}

/**
 * 对一个成功校验的文件执行放行判定。
 *
 * @param {object} report lib/preflight.js 的完整单文件报告
 * @param {Map<string,string>} rulesMap 显式策略 code -> action
 * @returns {{ decision: string, reason: string, triggered: Array<object> }}
 */
function decideCompletedFile(report, rulesMap) {
  const agg = new Map();
  for (const issue of report.issues) {
    const { action, source } = resolveIssueAction(issue.code, issue.severity, rulesMap);
    let entry = agg.get(issue.code);
    if (!entry) {
      entry = {
        code: issue.code,
        severity: issue.severity,
        title: issue.title,
        action,
        actionSource: source,
        count: 0,
      };
      agg.set(issue.code, entry);
    }
    entry.count += 1;
  }

  const triggered = [...agg.values()].sort((a, b) => {
    const rankDiff = ACTION_RANK[a.action] - ACTION_RANK[b.action];
    if (rankDiff !== 0) return rankDiff;
    return a.code.localeCompare(b.code);
  });

  let decision = 'pass';
  let reason = '未发现印前问题，准予放行。';
  if (triggered.some((t) => t.action === 'block')) {
    decision = 'block';
    const codes = triggered.filter((t) => t.action === 'block').map((t) => `${t.code}（阻断）`);
    reason = `触发阻断处置的问题代码：${codes.join('、')}，不予放行。`;
  } else if (triggered.some((t) => t.action === 'warn')) {
    decision = 'review';
    const codes = triggered.filter((t) => t.action === 'warn').map((t) => `${t.code}（警告）`);
    reason = `无阻断问题；需人工复核的问题代码：${codes.join('、')}。`;
  } else if (triggered.length) {
    reason = `触发的问题代码（${triggered.map((t) => t.code).join('、')}）均配置为忽略，准予放行。`;
  }

  return { decision, reason, triggered };
}

/**
 * 无法校验文件的放行判定：固定为未判定。
 */
function decideFailedFile(errorCode) {
  return {
    decision: 'undetermined',
    reason: `文件无法校验${errorCode ? `（${errorCode}）` : ''}，缺少检测结果，放行判定无法进行。`,
    triggered: [],
  };
}

/**
 * 汇总整批放行结论。
 *
 * @param {Array<{index:number, decision:string}>} fileReleases 与 files 同序
 * @param {{ rules: object, ignoredRules: array }} policy
 * @returns {object} 批量报告中的 release 节（策略 + 整批判定 + 计数）
 */
function buildBatchRelease(fileReleases, policy) {
  const summary = { blocked: 0, review: 0, passed: 0, undetermined: 0 };
  let batchDecision = 'pass';
  for (const release of fileReleases) {
    if (release.decision === 'block') summary.blocked += 1;
    else if (release.decision === 'review') summary.review += 1;
    else if (release.decision === 'undetermined') summary.undetermined += 1;
    else summary.passed += 1;

    if (BATCH_DECISION_RANK[release.decision] < BATCH_DECISION_RANK[batchDecision]) {
      batchDecision = release.decision;
    }
  }

  return {
    policy: {
      defaults: { ...DEFAULT_ACTION_BY_SEVERITY },
      rules: { ...(policy.rules || {}) },
      ignoredRules: (policy.ignoredRules || []).map((item) => ({ ...item })),
    },
    decision: batchDecision,
    summary,
  };
}

module.exports = {
  DEFAULT_ACTION_BY_SEVERITY,
  ACTIONS,
  RELEASE_DECISIONS,
  parseReleasePolicy,
  resolveIssueAction,
  decideCompletedFile,
  decideFailedFile,
  buildBatchRelease,
  describeAction,
};
