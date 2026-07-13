import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG, displayPath } from '../config.js';
import { listFilesRecursive, readJsonlObjects } from '../lib/jsonl.js';
import { makeUsageMetric } from '../lib/progress.js';
import { formatUsd } from '../lib/money.js';
import {
  formatResetKst,
  toIsoFromEpochSeconds,
  windowStartFromReset,
  formatKstDateRange,
  kstDateKey,
  kstMonthCycleStart,
  kstWeekStartMonday
} from '../lib/time.js';
import { withNodeDirOnPath } from '../lib/node-path.js';

const execFileAsync = promisify(execFile);

// Codex 사용률(5시간/주간)을 실시간 usage API(wham/usage)로 확보한다.
// 안전 원칙(Claude quota와 동일): 읽기 전용, 토큰 refresh·write 안 함, 토큰·이메일·user_id 미저장/미출력.
// API 실패 시에만 세션 파일(오래될 수 있음)로 폴백한다 — 가짜값 대신 정직한 stale.
export async function collectCodexUsage(options = {}) {
  const warningThreshold = options.warningThreshold ?? CONFIG.warningThreshold;
  const dangerThreshold = options.dangerThreshold ?? CONFIG.dangerThreshold;
  const authPath = options.authPath ?? CONFIG.codex.authPath;
  const usageEndpoint = options.usageEndpoint ?? CONFIG.codex.usageEndpoint;
  const sessionsDir = options.sessionsDir ?? CONFIG.codex.sessionsDir;
  const audit = [];
  const ccusagePath = await findExecutable('ccusage');

  // 1) 실시간 usage API 우선 (Codex CLI를 안 써도 앱과 같은 실시간 값이 잡힌다)
  let apiError = null;
  try {
    const payload = await fetchCodexUsage(authPath, usageEndpoint);
    const result = mapApiUsage(payload, warningThreshold, dangerThreshold);
    if (result.metrics.length > 0) {
      const costFacts = ccusagePath ? await collectCodexCostFacts(ccusagePath) : { items: [] };
      audit.push({ source: 'codex.wham.usage', status: 'confirmed', detail: '실시간 사용률 조회 성공(토큰 미출력).' });
      if (costFacts.failed) {
        audit.push({ source: 'ccusage', status: 'warning', detail: `ccusage 실행 실패 — 비용 미표시. (${costFacts.failed})` });
      }
      return {
        status: 'ok',
        name: 'Codex',
        planType: payload.plan_type ?? null,
        metrics: result.metrics,
        facts: costFacts.items,
        measuredAt: new Date().toISOString(),
        fresh: true,
        usageCredits: result.availableCount,
        latestRateLimit: { timestamp: new Date().toISOString(), source: 'wham/usage', planType: payload.plan_type ?? null },
        audit
      };
    }
    apiError = '응답에 rate_limit 창이 없음';
  } catch (error) {
    apiError = error.message;
  }
  audit.push({ source: 'codex.wham.usage', status: 'error', detail: `실시간 조회 불가(${apiError}) → 세션 파일 폴백.` });

  // 2) 폴백: 로컬 세션 파일(Codex CLI 사용 시점의 값 — 안 쓰면 오래됨)
  return collectFromSessions(sessionsDir, ccusagePath, warningThreshold, dangerThreshold, audit);
}

// Codex는 창 종류 이름표(kind)를 안 주므로, API 슬롯 위치가 아니라 창 "길이"(window_minutes)로 5시간/주간을 가른다.
// (위치로 가정하면 5시간이 사라졌을 때 주간이 primary 슬롯으로 올라와 "주간에 5시간 라벨"이 붙는다 — 실측 2026-07-13.
//  창 길이는 API·세션 파일 둘 다 항상 주므로, 길이로 판단하면 슬롯이 뒤바뀌거나 하나가 없어져도 라벨이 안 어긋난다.)
const SLOT_PRIMARY = { id: 'codex-primary', label: '5시간', showWindow: false, slot: '5h' };
const SLOT_SECONDARY = { id: 'codex-secondary', label: '주간', showWindow: true, slot: 'weekly' };
// 표시·상태바 대표 선택 순서: 5시간(짧은 창) 먼저, 주간 나중 — 슬롯이 뒤바뀌어도 종류 순서를 유지.
const WINDOW_ORDER = { 'codex-primary': 0, 'codex-secondary': 1 };

// Codex 창 길이 → 종류. 알려진 두 창만 확정 라벨: 5시간(실측 300분)·주간(실측 10080분).
//  - ≤360분(6시간): 5시간류 단기창(300분을 여유있게 포함하되 주간과 확실히 가르는 경계).
//  - 360~20160분(~2주): 주간류.
//  - 그 밖(길이 미상 또는 20160분 초과의 미지 장기창): null → 호출부가 그 창을 스킵한다.
// 슬롯 위치(primary/secondary)로 5시간/주간을 "추정"하지 않는다 — 그 추정이 이번 버그의 원인이라,
// 모르면 정직히 미표시한다. 현재 Codex는 두 창뿐이라 이분법으로 충분(YAGNI) —
// 새 길이의 창이 실제 등장하면 그때 라벨을 추가한다(DECISIONS 기록).
function classifyCodexWindow(windowMinutes) {
  if (!Number.isFinite(windowMinutes)) return null;
  if (windowMinutes <= 360) return SLOT_PRIMARY;
  if (windowMinutes <= 20160) return SLOT_SECONDARY;
  return null;
}

// 정규화된 window({used_percent, resets_at, window_minutes}) 하나를 길이로 분류해 metric 배열로 만든다.
// 창이 없거나·사용률이 없거나·창 길이로 종류를 못 정하면 빈 배열 → 그 창은 표시에서 자연히 사라진다
// (모델 소멸과 같은 원리, 제품 설계). 길이 미상을 슬롯 위치로 추정하지 않는다(구버그 재도입 방지).
function codexWindowMetric(windowData, sourceBase, warningThreshold, dangerThreshold) {
  if (!windowData || !Number.isFinite(windowData.used_percent)) return [];
  const kind = classifyCodexWindow(windowData.window_minutes);
  if (!kind) return [];
  return windowMetric(kind.id, windowData, kind.label, warningThreshold, dangerThreshold, kind.showWindow, `${sourceBase}.${kind.slot}`);
}

function sortByWindow(metrics) {
  return metrics.sort((a, b) => (WINDOW_ORDER[a.id] ?? 9) - (WINDOW_ORDER[b.id] ?? 9));
}

// (export는 테스트용 — 창 길이 분류·소멸 거동을 유닛으로 고정. 실제 버그가 이 API 경로에서 났다.)
export function mapApiUsage(payload, warningThreshold, dangerThreshold) {
  const rl = payload?.rate_limit ?? {};
  const metrics = sortByWindow([
    ...codexWindowMetric(normalizeApiWindow(rl.primary_window), 'codex.usage', warningThreshold, dangerThreshold),
    ...codexWindowMetric(normalizeApiWindow(rl.secondary_window), 'codex.usage', warningThreshold, dangerThreshold)
  ]);
  const availableCount = payload?.rate_limit_reset_credits?.available_count;
  return { metrics, availableCount: Number.isFinite(availableCount) ? availableCount : null };
}

// wham/usage 창(primary_window/secondary_window)을 세션 파일과 같은 모양으로 정규화한다.
function normalizeApiWindow(w) {
  if (!w || !Number.isFinite(w.used_percent)) return null;
  return {
    used_percent: w.used_percent,
    resets_at: Number.isFinite(w.reset_at) ? w.reset_at : null,
    window_minutes: Number.isFinite(w.limit_window_seconds) ? Math.round(w.limit_window_seconds / 60) : null
  };
}

async function fetchCodexUsage(authPath, endpoint) {
  if (!fs.existsSync(authPath)) throw new Error('auth.json 없음');
  const auth = JSON.parse(await fs.promises.readFile(authPath, 'utf8'));
  const token = auth?.tokens?.access_token ?? auth?.access_token;
  const accountId = auth?.tokens?.account_id ?? null;
  if (!token) throw new Error('access token 없음');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (accountId) headers['chatgpt-account-id'] = accountId;
  const res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function collectFromSessions(sessionsDir, ccusagePath, warningThreshold, dangerThreshold, audit) {
  const files = await listFilesRecursive(sessionsDir, (filePath) => filePath.endsWith('.jsonl'));
  if (files.length === 0) {
    return {
      status: 'unavailable',
      name: 'Codex',
      planType: null,
      metrics: [],
      facts: ccusagePath ? (await collectCodexCostFacts(ccusagePath)).items : [],
      measuredAt: null,
      fresh: false,
      usageCredits: null,
      latestRateLimit: null,
      audit: [...audit, { source: displayPath(sessionsDir), status: 'missing', detail: 'No Codex session JSONL files found.' }]
    };
  }

  let latest = null;
  let malformedLines = 0;
  for (const filePath of await sortNewestFirst(files)) {
    const result = await readJsonlObjects(filePath, (entry) => {
      const rateLimits = entry?.payload?.rate_limits;
      if (!rateLimits) return;
      const timestamp = entry.timestamp ?? entry.payload?.timestamp;
      if (!timestamp) return;
      if (!latest || new Date(timestamp) > new Date(latest.timestamp)) {
        latest = { timestamp, filePath, rateLimits };
      }
    });
    malformedLines += result.malformed;
    if (latest) break;
  }

  audit.push({
    source: displayPath(sessionsDir),
    status: latest ? 'warning' : 'unavailable',
    detail: latest ? `세션 파일 폴백: ${path.basename(latest.filePath)}(오래됐을 수 있음).` : '세션에서 rate_limits를 못 찾음.'
  });
  if (malformedLines > 0) {
    audit.push({ source: displayPath(sessionsDir), status: 'warning', detail: `${malformedLines} malformed JSONL lines skipped.` });
  }

  if (!latest) {
    return {
      status: 'unavailable',
      name: 'Codex',
      planType: null,
      metrics: [],
      facts: ccusagePath ? (await collectCodexCostFacts(ccusagePath)).items : [],
      measuredAt: null,
      fresh: false,
      usageCredits: null,
      latestRateLimit: null,
      audit
    };
  }

  // 세션 파일의 rate_limits.primary/secondary도 window_minutes를 담으므로 API와 같은 길이 기반 분류를 쓴다.
  const metrics = sortByWindow([
    ...codexWindowMetric(latest.rateLimits.primary, 'codex.session', warningThreshold, dangerThreshold),
    ...codexWindowMetric(latest.rateLimits.secondary, 'codex.session', warningThreshold, dangerThreshold)
  ]);

  const costFacts = ccusagePath ? await collectCodexCostFacts(ccusagePath) : { items: [] };
  if (costFacts.failed) {
    audit.push({ source: 'ccusage', status: 'warning', detail: `ccusage 실행 실패 — 비용 미표시. (${costFacts.failed})` });
  }

  return {
    status: metrics.length > 0 ? 'ok' : 'unavailable',
    name: 'Codex',
    planType: latest.rateLimits.plan_type ?? null,
    metrics,
    facts: costFacts.items,
    measuredAt: latest.timestamp,
    fresh: false,
    usageCredits: null,
    latestRateLimit: {
      timestamp: latest.timestamp,
      filePath: displayPath(latest.filePath),
      source: 'session',
      planType: latest.rateLimits.plan_type ?? null
    },
    audit
  };
}

function windowMetric(id, windowData, label, warningThreshold, dangerThreshold, showWindow, sourceBase) {
  if (!windowData || !Number.isFinite(windowData.used_percent)) return [];
  const start = windowStartFromReset(windowData.resets_at, windowData.window_minutes);
  const end = toIsoFromEpochSeconds(windowData.resets_at);
  const windowLabel = showWindow && start && end ? formatKstDateRange(start, end) : null;
  return [makeUsageMetric({
    id,
    label,
    usedPercent: windowData.used_percent,
    resetAt: end,
    // 리셋 직후엔 활성 창이 없어 resets_at이 없을 수 있다(0%) → "사용 시작 전"으로 설명.
    resetLabel: Number.isFinite(windowData.resets_at)
      ? formatResetKst(windowData.resets_at)
      : (windowData.used_percent === 0 ? '사용 시작 전 — 다음 사용부터 창 시작' : '리셋 시각 미확인'),
    windowMinutes: windowData.window_minutes,
    windowStart: start ? start.toISOString() : null,
    windowEnd: end,
    windowLabel,
    source: sourceBase,
    warningThreshold,
    dangerThreshold
  })];
}

// 오늘·주간(월~일)·월간(1일~) 3단. 각 구간 = 총액(라벨 없음) + 모델별.
// 주의: ccusage는 Codex의 "모델별 비용"을 안 주므로(총액 costUSD만) 모델별은 토큰으로 표기한다.
async function collectCodexCostFacts(ccusagePath) {
  try {
    const now = new Date();
    const monday = kstWeekStartMonday(now);
    const monthStart = kstMonthCycleStart(now, CONFIG.monthlyCycleStartDay);
    const todayStart = new Date(`${kstDateKey(now)}T00:00:00+09:00`);
    const since = [monday, monthStart, todayStart].reduce((a, b) => (a < b ? a : b));
    const { stdout } = await execFileAsync(
      ccusagePath,
      ['codex', 'daily', '--breakdown', '--json', '--since', kstDateKey(since).replaceAll('-', '')],
      { timeout: 20000, maxBuffer: 10 * 1024 * 1024, env: withNodeDirOnPath() }
    );
    const daily = JSON.parse(stdout).daily ?? [];

    return {
      items: [
        ...codexRangeItems(daily, monthStart, now, 'monthly'),
        ...codexRangeItems(daily, monday, now, 'weekly'),
        ...codexRangeItems(daily, todayStart, now, 'today')
      ]
    };
  } catch (error) {
    // 실행 실패(≠사용량 0)는 비용을 못 구한 것 — 빈 값 + 실패 사유(호출부가 audit에 기록).
    return { items: [], failed: error.message };
  }
}

// 사용량이 0이어도(월초·새 설치) 총액 $0.0은 표시한다 — "성공했는데 0"과 "못 구함"을 섞지 않기 위함.
function codexRangeItems(daily, startDate, now, group) {
  const startKey = kstDateKey(startDate);
  const buckets = daily.filter((day) => day.date >= startKey);
  const totalCost = buckets.reduce((sum, day) => sum + numberOrZero(day.costUSD), 0);
  const totalTokens = buckets.reduce((sum, day) => sum + numberOrZero(day.totalTokens), 0);

  const items = [{
    label: '', // 그룹 헤더가 타이틀 역할
    value: formatUsd(totalCost),
    rawCost: totalCost,
    detail: `${compactNumber(totalTokens)} tokens`,
    period: formatKstDateRange(startDate, now),
    source: `ccusage.codex.daily.${group}`,
    group
  }];

  // 모델별: Codex는 모델 단위 비용이 없어 토큰으로 표기.
  const byModel = new Map();
  for (const day of buckets) {
    for (const [name, model] of Object.entries(day.models ?? {})) {
      const acc = byModel.get(name) ?? { tokens: 0, reasoning: 0 };
      acc.tokens += numberOrZero(model.totalTokens);
      acc.reasoning += numberOrZero(model.reasoningOutputTokens);
      byModel.set(name, acc);
    }
  }
  const models = [...byModel.entries()]
    .map(([name, acc]) => ({
      label: name,
      value: `${compactNumber(acc.tokens)} tokens`,
      rawTokens: acc.tokens,
      detail: `reasoning ${compactNumber(acc.reasoning)}`,
      source: `ccusage.codex.daily.${group}.breakdown`,
      group: `${group} by model`
    }))
    .filter((model) => model.rawTokens > 0)
    .sort((a, b) => b.rawTokens - a.rawTokens)
    .slice(0, 8);

  return [...items, ...models];
}

async function sortNewestFirst(files) {
  const withStats = await Promise.all(files.map(async (filePath) => {
    const stat = await fs.promises.stat(filePath);
    return { filePath, mtimeMs: stat.mtimeMs };
  }));
  return withStats.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.filePath);
}

function compactNumber(value) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

async function findExecutable(name) {
  const candidates = [
    path.join(CONFIG.projectRoot, 'node_modules', '.bin', name),
    path.join(process.env.HOME ?? '', '.bun', 'bin', name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  try {
    const { stdout } = await execFileAsync('/bin/zsh', ['-lc', `command -v ${name}`], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
