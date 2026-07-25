import assert from 'node:assert/strict';
import { makeUsageMetric, usageTier, clampPercent } from '../src/lib/progress.js';

// 제품 기본 경계: 정상 < 70 ≤ 주의 < 90 ≤ 위험.
assert.equal(usageTier(69), 'normal');
assert.equal(usageTier(70), 'warning');
assert.equal(usageTier(89.9), 'warning');
assert.equal(usageTier(90), 'danger');

// 호출부가 별도 임계값을 넘기는 경우도 계약대로 동작한다.
assert.equal(usageTier(30, 80, 90), 'normal');
assert.equal(usageTier(80, 80, 90), 'warning');
assert.equal(usageTier(83, 80, 90), 'warning');
assert.equal(usageTier(90, 80, 90), 'danger');
assert.equal(usageTier(96, 80, 90), 'danger');
assert.equal(usageTier(null, 80, 90), 'unavailable');

assert.equal(clampPercent(120), 100);
assert.equal(clampPercent(-5), 0);
assert.equal(clampPercent('x'), null);

const danger = makeUsageMetric({
  id: 'weekly', label: '주간', usedPercent: 93,
  resetLabel: 'resets', source: 'test', warningThreshold: 80, dangerThreshold: 90
});
assert.equal(danger.tier, 'danger');
assert.equal(danger.isWarning, true);
assert.equal(danger.fillPercent, 93);
assert.equal(danger.remainingPercent, 7);

const normal = makeUsageMetric({
  id: 'session', label: '현재 세션', usedPercent: 11,
  source: 'test', warningThreshold: 80, dangerThreshold: 90
});
assert.equal(normal.tier, 'normal');
assert.equal(normal.isWarning, false);
assert.equal(normal.fillPercent, 11);

const unavailable = makeUsageMetric({ id: 'x', label: 'x', usedPercent: null, source: 'test' });
assert.equal(unavailable.tier, 'unavailable');
assert.equal(unavailable.fillPercent, 0);
assert.equal(unavailable.usedPercent, null);

console.log('progress.test.mjs passed');
