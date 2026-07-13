import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCodexUsage, mapApiUsage } from '../src/collectors/codex.js';

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

// --- 창 길이 기반 분류: 슬롯 위치가 아니라 window_minutes로 5시간/주간을 가른다 (2026-07-13 버그 회귀 방지) ---

// A) 5시간 소멸 → 주간이 primary 슬롯으로 올라옴(secondary=null). "5시간" 라벨이 붙으면 안 되고 "주간"으로. (실측 재현)
{
  const { metrics } = mapApiUsage({
    rate_limit: {
      primary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 1784511085 },
      secondary_window: null
    }
  }, 70, 90);
  assert.equal(metrics.length, 1, '5시간 소멸 → 창 1개만(주간 자연 소멸 없이 남음)');
  assert.equal(metrics[0].id, 'codex-secondary', '주간 창은 codex-secondary');
  assert.equal(metrics[0].label, '주간', '주간 데이터에 "5시간" 라벨이 붙으면 안 됨(구 버그)');
  assert.equal(metrics[0].usedPercent, 2);
}

// B) 정상: primary=5시간(300분) + secondary=주간(10080분) → 2개, 순서(5시간 먼저) 유지.
{
  const { metrics } = mapApiUsage({
    rate_limit: {
      primary_window: { used_percent: 15, limit_window_seconds: 18000, reset_at: 1783578112 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1783922825 }
    }
  }, 70, 90);
  assert.equal(metrics.length, 2);
  assert.deepEqual(metrics.map((m) => m.label), ['5시간', '주간']);
}

// C) 슬롯이 뒤바뀌어도 길이로 정정: 5시간이 secondary 슬롯에 와도 "5시간"으로, 먼저 정렬.
{
  const { metrics } = mapApiUsage({
    rate_limit: {
      primary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1783922825 },
      secondary_window: { used_percent: 15, limit_window_seconds: 18000, reset_at: 1783578112 }
    }
  }, 70, 90);
  assert.deepEqual(metrics.map((m) => m.label), ['5시간', '주간'], '슬롯 위치와 무관하게 길이로 판정 + 정렬');
}

// D) 주간 소멸 → 5시간만: primary=5시간, secondary=null → 5시간 1개.
{
  const { metrics } = mapApiUsage({
    rate_limit: {
      primary_window: { used_percent: 15, limit_window_seconds: 18000, reset_at: 1783578112 },
      secondary_window: null
    }
  }, 70, 90);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].id, 'codex-primary');
  assert.equal(metrics[0].label, '5시간');
}

// E) 세션 폴백 경로에서도 창 소멸 대응: primary만(주간 길이) → 주간 1개.
{
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-charge-codex-b-'));
  const sdir = path.join(dir, 'sessions');
  await fs.promises.mkdir(sdir, { recursive: true });
  await fs.promises.writeFile(path.join(sdir, 'r.jsonl'),
    `${JSON.stringify({ timestamp: '2026-07-13T00:00:00.000Z', type: 'event_msg', payload: {
      type: 'token_count',
      rate_limits: { limit_id: 'codex', primary: { used_percent: 2, window_minutes: 10080, resets_at: 1784511085 }, plan_type: 'plus' }
    } })}\n`);
  const r = await collectCodexUsage({ sessionsDir: sdir, authPath: path.join(dir, 'no-auth.json'), warningThreshold: 70, dangerThreshold: 90 });
  assert.equal(r.metrics.length, 1, '세션 폴백도 5시간 소멸 시 주간 1개');
  assert.equal(r.metrics[0].label, '주간');
  assert.equal(r.metrics[0].id, 'codex-secondary');
}

// F) 창 길이 미상(window_minutes/limit_window_seconds 없음) → 슬롯 위치로 5시간 단정하지 않고 스킵 .
{
  const { metrics } = mapApiUsage({
    rate_limit: {
      primary_window: { used_percent: 5, reset_at: 1784511085 },
      secondary_window: null
    }
  }, 70, 90);
  assert.equal(metrics.length, 0, '창 길이 미상 → 슬롯 추정 없이 미표시(구버그 재도입 방지)');
}

// G) 미지의 장기 창(20160분 초과, 예: 월간 30일) → "주간" 오라벨 대신 스킵 .
{
  const { metrics } = mapApiUsage({
    rate_limit: {
      primary_window: { used_percent: 5, limit_window_seconds: 2592000, reset_at: 1784511085 },
      secondary_window: null
    }
  }, 70, 90);
  assert.equal(metrics.length, 0, '미지 길이(30일) → 억지 라벨 없이 미표시');
}

console.log('codex-collector.test.mjs passed');
