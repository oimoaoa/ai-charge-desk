import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCodexUsage } from '../src/collectors/codex.js';

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-charge-codex-'));
const sessionsDir = path.join(root, 'sessions', '2026', '07', '09');
await fs.promises.mkdir(sessionsDir, { recursive: true });
const filePath = path.join(sessionsDir, 'rollout-test.jsonl');

const lines = [
  JSON.stringify({ timestamp: '2026-07-09T00:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message' } }),
  JSON.stringify({
    timestamp: '2026-07-09T01:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 83, window_minutes: 300, resets_at: 1783578112 },
        secondary: { used_percent: 93, window_minutes: 10080, resets_at: 1783922825 },
        plan_type: 'plus'
      }
    }
  })
];

await fs.promises.writeFile(filePath, `${lines.join('\n')}\n`);

// authPath를 없는 파일로 줘서 실시간 usage API를 건너뛰고 세션 파일 폴백 경로를 검증한다.
// (API 경로는 실제 endpoint로 실측 검증됨 — 2026-07-09.)
const result = await collectCodexUsage({
  sessionsDir,
  authPath: path.join(root, 'no-such-auth.json'),
  warningThreshold: 80,
  dangerThreshold: 90
});
assert.equal(result.status, 'ok');
assert.equal(result.planType, 'plus');
assert.equal(result.fresh, false, 'session fallback should be marked not-fresh');
assert.equal(result.metrics.length, 2);

const [primary, secondary] = result.metrics;
assert.equal(primary.label, '5시간');
assert.equal(primary.usedPercent, 83);
assert.equal(primary.tier, 'warning');
assert.equal(secondary.label, '주간');
assert.equal(secondary.usedPercent, 93);
assert.equal(secondary.tier, 'danger');
assert.ok(typeof secondary.windowLabel === 'string' && secondary.windowLabel.includes('~'));

console.log('codex-collector.test.mjs passed');
