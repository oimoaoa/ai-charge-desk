import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG, displayPath } from '../config.js';
import { listFilesRecursive, readJsonlObjects } from '../lib/jsonl.js';
import { makeUsageMetric } from '../lib/progress.js';
import {
  formatResetKst,
  toIsoFromEpochSeconds,
  windowStartFromReset,
  formatKstDateRange,
  kstDateKey,
  kstMonthCycleStart,
  kstWeekStartMonday
} from '../lib/time.js';

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

function mapApiUsage(payload, warningThreshold, dangerThreshold) {
  const rl = payload?.rate_limit ?? {};
  const primary = normalizeApiWindow(rl.primary_window);
  const secondary = normalizeApiWindow(rl.secondary_window);
  const metrics = [];
  metrics.push(...windowMetric('codex-primary', primary, '5시간', warningThreshold, dangerThreshold, false, 'codex.usage.primary'));
  metrics.push(...windowMetric('codex-secondary', secondary, '주간', warningThreshold, dangerThreshold, true, 'codex.usage.secondary'));
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

  const metrics = [];
  metrics.push(...windowMetric('codex-primary', latest.rateLimits.primary, '5시간', warningThreshold, dangerThreshold, false, 'codex.session.primary'));
  metrics.push(...windowMetric('codex-secondary', latest.rateLimits.secondary, '주간', warningThreshold, dangerThreshold, true, 'codex.session.secondary'));

  const costFacts = ccusagePath ? await collectCodexCostFacts(ccusagePath) : { items: [] };

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
    resetLabel: Number.isFinite(windowData.resets_at) ? formatResetKst(windowData.resets_at) : 'reset unknown',
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
      { timeout: 20000, maxBuffer: 10 * 1024 * 1024 }
    );
    const daily = JSON.parse(stdout).daily ?? [];
    if (daily.length === 0) return { items: [] };

    return {
      items: [
        ...codexRangeItems(daily, monthStart, now, 'monthly'),
        ...codexRangeItems(daily, monday, now, 'weekly'),
        ...codexRangeItems(daily, todayStart, now, 'today')
      ]
    };
  } catch {
    return { items: [] };
  }
}

function codexRangeItems(daily, startDate, now, group) {
  const startKey = kstDateKey(startDate);
  const buckets = daily.filter((day) => day.date >= startKey);
  if (buckets.length === 0) return [];
  const totalCost = buckets.reduce((sum, day) => sum + numberOrZero(day.costUSD), 0);
  const totalTokens = buckets.reduce((sum, day) => sum + numberOrZero(day.totalTokens), 0);

  const items = [{
    label: '', // 그룹 헤더가 타이틀 역할
    value: `$${totalCost.toFixed(1)}`,
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
