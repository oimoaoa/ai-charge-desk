import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectClaudeQuota, mapLimits } from '../src/collectors/claude-quota.js';

// 존재하지 않는 키체인 서비스명을 주면 키체인 읽기가 실패한다 → 실시간 조회 불가.
// 그때 (1) 캐시가 있으면 stale로 마지막 성공값 표시, (2) 없으면 정직히 unavailable 이어야 한다.
const BOGUS_SERVICE = 'ai-charge-desk-test-no-such-service-xyz';
const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-charge-claude-'));

// (1) 캐시 없음 → unavailable (가짜 % 만들지 않음)
const emptyCache = path.join(root, 'empty-cache.json');
const noneResult = await collectClaudeQuota({ keychainService: BOGUS_SERVICE, cachePath: emptyCache });
assert.equal(noneResult.status, 'unavailable', 'no keychain + no cache → unavailable');
assert.equal(noneResult.metrics.length, 0, 'unavailable must not invent metrics');

// (2) 캐시 있음 → stale로 마지막 성공값 표시 + 라벨 재계산
const cachePath = path.join(root, 'quota-cache.json');
await fs.promises.writeFile(cachePath, JSON.stringify({
  measuredAt: '2026-07-09T09:00:00.000Z',
  metrics: [
    { id: 'claude-session', label: '현재 세션', usedPercent: 75, resetAt: '2026-07-09T15:00:00.000Z', source: 'claude.oauth.usage.limits.session' }
  ]
}));
const staleResult = await collectClaudeQuota({
  keychainService: BOGUS_SERVICE,
  cachePath,
  warningThreshold: 70,
  dangerThreshold: 90
});
assert.equal(staleResult.status, 'stale', 'no keychain + cache → stale');
assert.equal(staleResult.metrics.length, 1);
assert.equal(staleResult.metrics[0].usedPercent, 75);
assert.equal(staleResult.metrics[0].tier, 'warning', '75% with 70/90 thresholds → warning');
assert.equal(staleResult.measuredAt, '2026-07-09T09:00:00.000Z', 'stale keeps original measured time');

// (3) 모델 전용(weekly_scoped) 사용률의 종료 대비 거동 — 2026-07-12 Fable 창 종료 대비.
//   ⓐ scoped 0% → 숨김(정보가치 없음) ⓑ session/weekly_all 0% → 리셋 직후 정상이라 표시
//   ⓒ API가 scoped 항목 자체를 안 내려주면 → 자동으로 없음
const payload = {
  limits: [
    { kind: 'session', percent: 0, resets_at: '2026-07-12T08:00:00Z' },
    { kind: 'weekly_all', percent: 0, resets_at: '2026-07-12T08:00:00Z' },
    { kind: 'weekly_scoped', percent: 0, resets_at: '2026-07-12T08:00:00Z', scope: { model: { display_name: 'Fable' } } }
  ]
};
const zeroMetrics = mapLimits(payload, 70, 90);
assert.deepEqual(zeroMetrics.map((m) => m.id), ['claude-session', 'claude-weekly'], 'scoped 0% is hidden; session/weekly 0% stay');

payload.limits[2].percent = 3;
const activeMetrics = mapLimits(payload, 70, 90);
assert.deepEqual(activeMetrics.map((m) => m.id), ['claude-session', 'claude-weekly', 'claude-weekly-fable'], 'scoped >0% is shown');

const withoutScoped = mapLimits({ limits: payload.limits.slice(0, 2) }, 70, 90);
assert.deepEqual(withoutScoped.map((m) => m.id), ['claude-session', 'claude-weekly'], 'missing scoped limit simply disappears');

console.log('claude-quota.test.mjs passed');
