import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// 대시보드 90% 글자는 서비스 tint 위에서도 WCAG 일반 텍스트 AA(4.5:1)를 넘는다.
const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dashboard', 'styles.css');
const css = fs.readFileSync(cssPath, 'utf8');
const cssColor = (name) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
const rgb = (hex) => hex.slice(1).match(/../g).map((value) => Number.parseInt(value, 16) / 255);
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (foreground, background) => {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};
assert.match(css, /\.metric-used\.danger \{ color: var\(--danger-ink\); \}/);
assert.ok(contrast(cssColor('danger-ink'), cssColor('claude-tint')) >= 4.5, 'Claude tint의 danger 글자 AA 대비');
assert.ok(contrast(cssColor('danger-ink'), cssColor('codex-tint')) >= 4.5, 'Codex tint의 danger 글자 AA 대비');

console.log('progress.test.mjs passed');
