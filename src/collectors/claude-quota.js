import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG, displayPath } from '../config.js';
import { makeUsageMetric } from '../lib/progress.js';
import { formatResetKstFromIso, resetLabelOrIdle } from '../lib/time.js';

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// Claude 사용률(%)을 실시간 usage API로 확보한다.
// 안전 원칙(교차검증 2026-07-09 검증):
//  - 읽기 전용. access token을 refresh하지 않고 write하지 않는다(refresh는 Claude Code 본체에만 맡김 → 로그인 안 깨짐).
//  - 토큰 값은 로그·캐시·스냅샷 어디에도 출력/저장하지 않는다. 응답의 PII(email·user_id)도 저장하지 않는다.
//  - 필드가 없거나 조회 실패면 가짜 %를 만들지 않고 정직히 미표시(unavailable) 또는 마지막 성공값(stale)을 표시한다.
export async function collectClaudeQuota(options = {}) {
  const warningThreshold = options.warningThreshold ?? CONFIG.warningThreshold;
  const dangerThreshold = options.dangerThreshold ?? CONFIG.dangerThreshold;
  const cachePath = options.cachePath ?? CONFIG.claude.quotaCachePath;
  const endpoint = options.endpoint ?? CONFIG.claude.usageEndpoint;
  const audit = [];

  // 1) 키체인에서 access token + 만료시각 확보 (읽기 전용, 값 미출력)
  let token = null;
  let expiresAt = null;
  let planType = null;
  let refreshAlive = false;
  let reason = null;
  // stale/미표시 사유 코드 — 표시 계층이 원인별 안내(갱신 버튼·폴백)를 고르는 근거(R29).
  // token-expired(갱신 버튼으로 해결) / login-required(재로그인만 해결 — 버튼 보여주면 가짜 희망) /
  // no-token(로그인 이력 없음) / keychain-denied / fetch-failed. 토큰 값이 아니라 분류만 실린다.
  let staleReason = null;
  try {
    const cred = await resolveCredential(options);
    token = cred.accessToken;
    expiresAt = cred.expiresAt;
    planType = cred.subscriptionType; // 예: "max" (등급 표시용, 토큰 아님)
    // refresh token은 "살아있는지"만 본다(값은 읽지도 옮기지도 않음). 만료시각이 없으면 살아있다고 가정.
    refreshAlive = cred.hasRefreshToken && (!Number.isFinite(cred.refreshTokenExpiresAt) || Date.now() < cred.refreshTokenExpiresAt);
  } catch (error) {
    if (error?.code === 44) {
      // security 종료코드 44 = 항목 없음(errSecItemNotFound) → CLI 로그인 이력이 없는 것(접근 거부 아님).
      reason = '키체인에 Claude Code 자격이 없음 — CLI 로그인 필요.';
      staleReason = 'no-token';
    } else {
      // 키체인 접근 실패(예: 백그라운드에서 GUI 승인 프롬프트가 못 떠서). 가짜값 대신 정직 처리.
      reason = `키체인 접근 실패: ${error.message}`;
      staleReason = 'keychain-denied';
    }
  }

  const tokenValid = isLiveToken({ accessToken: token, expiresAt });

  // 2) 유효 토큰이 있을 때만 실시간 조회 (만료면 refresh하지 않는다)
  if (tokenValid) {
    try {
      const payload = await fetchUsage(token, endpoint, CONFIG.claude.betaHeader);
      const metrics = mapLimits(payload, warningThreshold, dangerThreshold);
      if (metrics.length > 0) {
        await saveCache(cachePath, metrics);
        audit.push({ source: 'claude.oauth.usage', status: 'confirmed', detail: '실시간 사용률 조회 성공(토큰 미출력).' });
        return { status: 'ok', metrics, measuredAt: new Date().toISOString(), fresh: true, planType, staleReason: null, audit };
      }
      reason = '응답에 limits가 없어 사용률을 만들지 않음(가짜값 금지).';
      staleReason = 'fetch-failed';
    } catch (error) {
      reason = `usage 조회 실패: ${error.message}`;
      staleReason = 'fetch-failed';
    }
  } else if (!reason) {
    if (!token) {
      // 항목은 있는데 토큰이 비어 있음 = CLI가 갱신 실패 후 정리한 상태(실측 2026-07-10) → 재로그인만 해결.
      reason = '키체인에 access token 없음(로그인 풀림) — claude 실행 후 /login 필요.';
      staleReason = 'login-required';
    } else if (refreshAlive) {
      reason = 'access token 만료 — 갱신은 Claude Code에 맡김(refresh 안 함).';
      staleReason = 'token-expired';
    } else {
      reason = 'access token 만료 + refresh token도 만료/없음 — 재로그인(/login)만 해결.';
      staleReason = 'login-required';
    }
  }

  // 3) 실시간 실패 → 마지막 성공값(stale)을 "오래됨"으로 정직 표시
  const cached = await loadCache(cachePath, warningThreshold, dangerThreshold);
  if (cached) {
    audit.push({ source: displayPath(cachePath), status: 'warning', detail: `실시간 조회 불가(${reason}) → 마지막 성공값 표시.` });
    return { status: 'stale', metrics: cached.metrics, measuredAt: cached.measuredAt, fresh: false, planType, staleReason, audit };
  }

  audit.push({ source: 'claude.oauth.usage', status: 'unavailable', detail: reason ?? '사용률 미확보.' });
  return { status: 'unavailable', metrics: [], measuredAt: null, fresh: false, planType, staleReason, audit };
}

// oauth/usage 응답의 limits[]를 R2/R3/R4로 매핑한다(실측 스키마 2026-07-09).
//   kind=session       → 현재 세션(5시간)
//   kind=weekly_all    → 주간 전체
//   kind=weekly_scoped → 주간 <모델>(scope.model.display_name), 예: Fable
// (export는 테스트용 — 모델 종료 시 사라짐/0% 숨김 거동을 유닛으로 고정)
export function mapLimits(payload, warningThreshold, dangerThreshold) {
  const limits = Array.isArray(payload?.limits) ? payload.limits : [];
  const order = { session: 0, weekly_all: 1, weekly_scoped: 2 };
  const out = [];
  for (const lim of limits) {
    if (!lim || !Number.isFinite(lim.percent)) continue; // 필드 없으면 스킵(가짜% 금지)
    let id;
    let label;
    if (lim.kind === 'session') {
      id = 'claude-session';
      label = '5시간'; // Codex와 표기 통일(창 길이 기준)
    } else if (lim.kind === 'weekly_all') {
      id = 'claude-weekly';
      label = '주간';
    } else if (lim.kind === 'weekly_scoped') {
      // 모델 전용 사용률(예: Fable)은 종료 예정 영역 — API가 항목을 빼면 자동으로 사라지고,
      // 항목은 오는데 0%면 정보가치가 없어 표시하지 않는다(제품 결정 2026-07-09).
      // 5시간·주간 전체의 0%는 리셋 직후의 정상 상태라 그대로 표시한다.
      const model = lim.scope?.model?.display_name;
      if (!model || !(lim.percent > 0)) continue;
      id = `claude-weekly-${String(model).toLowerCase()}`;
      label = String(model); // "주간 Fable" → "Fable" (제품 결정 2026-07-10 — 핵심만 간결하게)
    } else {
      continue;
    }
    out.push({
      _order: order[lim.kind] ?? 9,
      metric: makeUsageMetric({
        id,
        label,
        usedPercent: lim.percent,
        resetAt: lim.resets_at ?? null,
        // 리셋 직후엔 활성 창이 없어 resets_at이 안 온다(0%) → "사용 시작 전"으로 설명.
        resetLabel: resetLabelOrIdle(lim.resets_at, lim.percent),
        source: `claude.oauth.usage.limits.${lim.kind}`,
        warningThreshold,
        dangerThreshold
      })
    });
  }
  return out.sort((a, b) => a._order - b._order).map((entry) => entry.metric);
}

// 같은 서비스명 항목이 여러 개일 때 첫 매치(계정명 없는 만료 유령)가 진짜(acct=맥 사용자명) 항목을
// 가릴 수 있다 — v0.1.6, 커뮤니티 리포트('토론토구리네'님 진단: 갱신·재로그인이 전부 무효처럼 보였던 원인).
// 첫 매치가 죽어 있으면 맥 사용자명으로 "한 번만" 정조준한다. 항목 나열(dump-keychain)은 필요 이상으로
// 넓은 동작이라 쓰지 않는다(최소 권한 — 실측된 유령 사례는 전부 acct=사용자명 정조준으로 해결됨).
async function resolveCredential(options) {
  const read = options.readCredential ?? readKeychainCredential;
  if (options.keychainService) return read(options.keychainService); // 테스트·고정용: 기존 단일 조회 그대로
  let first = null;
  let firstError = null;
  try {
    first = await read(KEYCHAIN_SERVICE);
    if (isLiveToken(first)) return first; // 정상 환경(항목 1개)은 여기서 끝 — 동작·비용 불변
  } catch (error) {
    firstError = error;
  }
  let targeted = null;
  try {
    targeted = await read(KEYCHAIN_SERVICE, options.fallbackAccount ?? os.userInfo().username);
  } catch { /* 정조준 항목 없음 → 첫 매치 결과로 정직 분류 */ }
  // 정조준 항목은 CLI가 실제로 갱신하는 쪽 — 죽어 있어도 사유 분류(R29)의 근거로 우선한다.
  if (targeted) return targeted;
  if (first) return first;
  throw firstError ?? Object.assign(new Error('keychain credential not found'), { code: 44 });
}

function isLiveToken(cred) {
  return Boolean(cred?.accessToken) && Number.isFinite(cred.expiresAt) && Date.now() < cred.expiresAt - 60_000;
}

async function readKeychainCredential(service, account) {
  const args = ['find-generic-password', '-s', service];
  if (account) args.push('-a', account); // 계정 정조준 — 같은 서비스명 중복 시 첫 매치(유령) 회피
  args.push('-w');
  const { stdout } = await execFileAsync('security', args, { timeout: 5000 });
  const parsed = JSON.parse(stdout.trim());
  const oauth = parsed?.claudeAiOauth ?? parsed;
  return {
    accessToken: oauth?.accessToken ?? null,
    expiresAt: Number.isFinite(Number(oauth?.expiresAt)) ? Number(oauth.expiresAt) : null,
    subscriptionType: oauth?.subscriptionType ?? null,
    // refresh token은 존재 여부·만료시각만(값은 반환하지 않음 — 우리는 refresh하지 않는다).
    hasRefreshToken: Boolean(oauth?.refreshToken),
    refreshTokenExpiresAt: Number.isFinite(Number(oauth?.refreshTokenExpiresAt)) ? Number(oauth.refreshTokenExpiresAt) : null
  };
}

async function fetchUsage(token, endpoint, betaHeader) {
  const res = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'anthropic-beta': betaHeader,
      'anthropic-version': '2023-06-01'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 캐시: 사용률(%)·리셋시각만 저장한다. 토큰·이메일·user_id 등은 저장하지 않는다.
async function saveCache(cachePath, metrics) {
  const slim = metrics.map((m) => ({
    id: m.id,
    label: m.label,
    usedPercent: m.usedPercent,
    resetAt: m.resetAt,
    source: m.source
  }));
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.promises.writeFile(cachePath, `${JSON.stringify({ measuredAt: new Date().toISOString(), metrics: slim }, null, 2)}\n`);
}

async function loadCache(cachePath, warningThreshold, dangerThreshold) {
  try {
    const data = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
    const metrics = (data.metrics ?? [])
      .filter((m) => Number.isFinite(m.usedPercent))
      .map((m) => makeUsageMetric({
        id: m.id,
        label: m.label,
        usedPercent: m.usedPercent,
        resetAt: m.resetAt ?? null,
        resetLabel: formatResetKstFromIso(m.resetAt),
        source: m.source,
        warningThreshold,
        dangerThreshold
      }));
    return metrics.length > 0 ? { metrics, measuredAt: data.measuredAt ?? null } : null;
  } catch {
    return null;
  }
}
