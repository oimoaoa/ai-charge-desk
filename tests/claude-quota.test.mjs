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
assert.equal(noneResult.staleReason, 'no-token', 'keychain item not found(44) = 로그인 이력 없음 (R29)');

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
assert.equal(staleResult.staleReason, 'no-token', 'stale carries a structured reason (R29)');

// (2b) 사유 분류(R29 — 실측 2026-07-10 로그인 풀림 사건 반영):
//   만료 + refresh 살아있음 → token-expired(갱신 버튼으로 해결)
//   만료 + refresh 죽음/없음 → login-required(재로그인만 해결 — 버튼 금지)
//   항목은 있는데 토큰 비어있음(CLI가 갱신 실패 후 정리) → login-required
const cred = (over) => async () => ({
  accessToken: 'test-token-not-used', expiresAt: Date.now() - 1000, subscriptionType: 'max',
  hasRefreshToken: true, refreshTokenExpiresAt: Date.now() + 3_600_000, ...over
});
const expired = await collectClaudeQuota({ readCredential: cred({}), cachePath: emptyCache });
assert.equal(expired.staleReason, 'token-expired', 'expired access + alive refresh → token-expired');
const refreshDead = await collectClaudeQuota({ readCredential: cred({ refreshTokenExpiresAt: Date.now() - 1000 }), cachePath: emptyCache });
assert.equal(refreshDead.staleReason, 'login-required', 'expired access + dead refresh → login-required');
const cleared = await collectClaudeQuota({ readCredential: cred({ accessToken: null, hasRefreshToken: false }), cachePath: emptyCache });
assert.equal(cleared.staleReason, 'login-required', 'cleared tokens(로그인 풀림) → login-required');

// (2c) v0.1.6 — 같은 서비스명 중복(유령) 항목 fallback. 커뮤니티 리포트('토론토구리네'님) 실측:
//     acct 없는 만료 유령이 첫 매치를 가로채 CLI가 매일 갱신하는 진짜 항목(acct=사용자명)이 영영 안 읽힘.
//   ⓐ 첫 매치 만료 + 사용자명 정조준으로 살아있는 항목 → 그 토큰으로 실시간 조회까지 간다
//      (막힌 로컬 포트 endpoint로 네트워크 없이 검증 — staleReason이 만료 분류가 아니라 fetch-failed면 성공).
//   ⓑ 둘 다 만료 → 정조준 항목(진짜) 기준으로 기존 사유 분류 유지.
//   ⓒ 정상 환경(첫 매치 생존) → 정조준 호출 자체가 없어야 함(동작·비용 불변).
const ghostStore = (realAlive) => ({
  '(first)': { accessToken: 'ghost', expiresAt: Date.now() - 1000, subscriptionType: 'max', hasRefreshToken: true, refreshTokenExpiresAt: null },
  'testuser': { accessToken: 'real', expiresAt: realAlive ? Date.now() + 3_600_000 : Date.now() - 1000, subscriptionType: 'max', hasRefreshToken: true, refreshTokenExpiresAt: Date.now() + 86_400_000 }
});
const ghostOptions = (store, reads) => ({
  readCredential: async (service, account) => {
    reads.push(account ?? '(first)');
    const c = store[account ?? '(first)'];
    if (!c) throw Object.assign(new Error('item not found'), { code: 44 });
    return c;
  },
  fallbackAccount: 'testuser',
  cachePath: emptyCache,
  endpoint: 'http://127.0.0.1:9/usage' // 막힌 포트 — 외부 네트워크 없이 즉시 실패
});
const reads1 = [];
const ghostHit = await collectClaudeQuota(ghostOptions(ghostStore(true), reads1));
assert.equal(ghostHit.staleReason, 'fetch-failed', '정조준으로 살아있는 토큰을 골라 조회까지 감(만료 분류 아님)');
assert.deepEqual(reads1, ['(first)', 'testuser'], '첫 매치 → 사용자명 정조준 순서');
const reads2 = [];
const ghostDead = await collectClaudeQuota(ghostOptions(ghostStore(false), reads2));
assert.equal(ghostDead.staleReason, 'token-expired', '둘 다 만료 + refresh 생존 → token-expired(진짜 항목 기준 분류)');
const reads3 = [];
const healthy = { '(first)': { accessToken: 'live', expiresAt: Date.now() + 3_600_000, subscriptionType: 'max', hasRefreshToken: true, refreshTokenExpiresAt: null } };
await collectClaudeQuota(ghostOptions(healthy, reads3));
assert.deepEqual(reads3, ['(first)'], '정상 환경은 정조준 호출 없음(비용·동작 불변)');

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
