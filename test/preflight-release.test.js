'use strict';

// 交付放行判定纯函数测试：策略解析（默认/自定义/非法）、逐文件判定
// （阻断优先于警告、忽略不影响放行、无法校验为未判定）、整批聚合。
const assert = require('assert');
const {
  parseReleasePolicy,
  resolveIssueAction,
  decideCompletedFile,
  decideFailedFile,
  buildBatchRelease,
} = require('../lib/preflight-release');

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ---------- 策略解析 ----------

check('空输入 -> 空策略（全部走默认）', () => {
  for (const empty of [undefined, null, '']) {
    const parsed = parseReleasePolicy(empty);
    assert.deepStrictEqual(parsed.rules, {});
    assert.deepStrictEqual(parsed.ignoredRules, []);
  }
});

check('默认处置：错误阻断 / 警告警告 / 提示忽略', () => {
  assert.strictEqual(resolveIssueAction('rotated_180', 'error', new Map()).action, 'block');
  assert.strictEqual(resolveIssueAction('transparency', 'warning', new Map()).action, 'warn');
  assert.strictEqual(resolveIssueAction('blank_padding', 'info', new Map()).action, 'ignore');
  const src = resolveIssueAction('transparency', 'warning', new Map());
  assert.strictEqual(src.source, 'default');
});

check('{ rules: {...} } 形态：合法代码 + 合法处置生效并标记来源 rule', () => {
  const parsed = parseReleasePolicy({ rules: { transparency: 'ignore', rotated_180: 'warn' } });
  assert.deepStrictEqual(parsed.rules, { transparency: 'ignore', rotated_180: 'warn' });
  const map = new Map(Object.entries(parsed.rules));
  assert.strictEqual(resolveIssueAction('transparency', 'warning', map).action, 'ignore');
  assert.strictEqual(resolveIssueAction('transparency', 'warning', map).source, 'rule');
  // 未覆盖代码仍走默认
  assert.strictEqual(resolveIssueAction('size_mismatch', 'warning', map).action, 'warn');
});

check('裸映射形态 { code: action } 同样接受', () => {
  const parsed = parseReleasePolicy({ blank_padding: 'block' });
  assert.deepStrictEqual(parsed.rules, { blank_padding: 'block' });
});

check('JSON 字符串策略可解析', () => {
  const parsed = parseReleasePolicy('{"rules":{"rotated_180":"ignore"}}');
  assert.deepStrictEqual(parsed.rules, { rotated_180: 'ignore' });
});

check('非法 JSON / 顶层非对象 / rules 非对象 -> 抛错', () => {
  assert.throws(() => parseReleasePolicy('{not json'), /合法的 JSON/);
  assert.throws(() => parseReleasePolicy('["x"]'), /JSON 对象/);
  assert.throws(() => parseReleasePolicy({ rules: [] }), /rules 必须/);
});

check('未知代码与非法处置值登记到 ignoredRules 但不抛错', () => {
  const parsed = parseReleasePolicy({
    rules: { nope_code: 'block', transparency: 'fatal', size_mismatch: 'ignore' },
  });
  assert.deepStrictEqual(parsed.rules, { size_mismatch: 'ignore' });
  assert.strictEqual(parsed.ignoredRules.length, 2);
  const unknown = parsed.ignoredRules.find((r) => r.code === 'nope_code');
  assert.strictEqual(unknown.reason, 'unknown_code');
  const badAction = parsed.ignoredRules.find((r) => r.code === 'transparency');
  assert.strictEqual(badAction.reason, 'invalid_action');
});

// ---------- 逐文件判定 ----------

function makeReport(issues) {
  return {
    issues: issues.map((code, i) => ({ code, severity: issueSeverity(code), title: code })),
  };
}
function issueSeverity(code) {
  if (code === 'rotated_180') return 'error';
  if (code === 'no_extractable_text' || code === 'blank_padding') return 'info';
  return 'warning';
}

check('无问题文件 -> pass', () => {
  const r = decideCompletedFile(makeReport([]), new Map());
  assert.strictEqual(r.decision, 'pass');
  assert.deepStrictEqual(r.triggered, []);
});

check('默认策略：仅警告 -> review（需复核）', () => {
  const r = decideCompletedFile(makeReport(['transparency', 'size_mismatch']), new Map());
  assert.strictEqual(r.decision, 'review');
  assert.strictEqual(r.triggered.length, 2);
  assert.ok(r.triggered.every((t) => t.action === 'warn'));
});

check('默认策略：含错误 -> block，且阻断优先于警告', () => {
  const r = decideCompletedFile(
    makeReport(['transparency', 'rotated_180', 'size_mismatch']),
    new Map(),
  );
  assert.strictEqual(r.decision, 'block');
  // triggered 排序：block 在 warn 之前
  assert.strictEqual(r.triggered[0].code, 'rotated_180');
  assert.strictEqual(r.triggered[0].action, 'block');
});

check('默认策略：仅提示 -> pass（提示默认忽略）', () => {
  const r = decideCompletedFile(
    makeReport(['no_extractable_text', 'blank_padding']),
    new Map(),
  );
  assert.strictEqual(r.decision, 'pass');
  assert.ok(r.triggered.every((t) => t.action === 'ignore'));
});

check('自定义：错误代码降级为忽略，仅警告代码降为忽略 -> pass', () => {
  const rules = new Map([
    ['rotated_180', 'ignore'],
    ['transparency', 'ignore'],
  ]);
  const r = decideCompletedFile(
    makeReport(['rotated_180', 'transparency']),
    rules,
  );
  assert.strictEqual(r.decision, 'pass');
  assert.ok(r.triggered.every((t) => t.action === 'ignore' && t.actionSource === 'rule'));
});

check('自定义：警告升级为阻断时 -> block', () => {
  const rules = new Map([['transparency', 'block']]);
  const r = decideCompletedFile(makeReport(['transparency']), rules);
  assert.strictEqual(r.decision, 'block');
});

check('自定义：提示升级为警告 -> review', () => {
  const rules = new Map([['blank_padding', 'warn']]);
  const r = decideCompletedFile(makeReport(['blank_padding']), rules);
  assert.strictEqual(r.decision, 'review');
});

check('阻断 + 忽略混合 -> 仍为 block；triggered 含被忽略代码', () => {
  const rules = new Map([['size_mismatch', 'ignore']]);
  const r = decideCompletedFile(
    makeReport(['size_mismatch', 'rotated_180']),
    rules,
  );
  assert.strictEqual(r.decision, 'block');
  const ignored = r.triggered.find((t) => t.code === 'size_mismatch');
  assert.strictEqual(ignored.action, 'ignore');
});

check('无法校验文件 -> undetermined，不给出触发代码', () => {
  const r = decideFailedFile('encrypted_pdf');
  assert.strictEqual(r.decision, 'undetermined');
  assert.match(r.reason, /encrypted_pdf/);
  assert.deepStrictEqual(r.triggered, []);
  assert.strictEqual(decideFailedFile().decision, 'undetermined');
});

// ---------- 整批聚合 ----------

check('整批：全通过 -> pass', () => {
  const batch = buildBatchRelease(
    [{ index: 0, decision: 'pass' }, { index: 1, decision: 'pass' }],
    { rules: {}, ignoredRules: [] },
  );
  assert.strictEqual(batch.decision, 'pass');
  assert.deepStrictEqual(batch.summary, { blocked: 0, review: 0, passed: 2, undetermined: 0 });
  assert.deepStrictEqual(batch.policy.defaults,
    { error: 'block', warning: 'warn', info: 'ignore' });
});

check('整批：阻断优先于需复核与通过', () => {
  const batch = buildBatchRelease(
    [{ index: 0, decision: 'pass' }, { index: 1, decision: 'review' },
      { index: 2, decision: 'block' }, { index: 3, decision: 'pass' }],
    { rules: { transparency: 'ignore' }, ignoredRules: [] },
  );
  assert.strictEqual(batch.decision, 'block');
  assert.strictEqual(batch.summary.blocked, 1);
  assert.strictEqual(batch.summary.review, 1);
  assert.strictEqual(batch.summary.passed, 2);
  assert.deepStrictEqual(batch.policy.rules, { transparency: 'ignore' });
});

check('整批：无阻断但有未判定 -> undetermined（不得盲目放行）', () => {
  const batch = buildBatchRelease(
    [{ index: 0, decision: 'pass' }, { index: 1, decision: 'undetermined' },
      { index: 2, decision: 'review' }],
    { rules: {}, ignoredRules: [] },
  );
  assert.strictEqual(batch.decision, 'undetermined');
  assert.strictEqual(batch.summary.undetermined, 1);
});

check('整批：无阻断/未判定，仅有需复核 -> review', () => {
  const batch = buildBatchRelease(
    [{ index: 0, decision: 'review' }, { index: 1, decision: 'pass' }],
    { rules: {}, ignoredRules: [] },
  );
  assert.strictEqual(batch.decision, 'review');
});

console.log(`preflight-release：${passed} 项检查通过`);
