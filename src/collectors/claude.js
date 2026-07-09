import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG, displayPath } from '../config.js';
import { makeUsageMetric } from '../lib/progress.js';
import { formatUsd } from '../lib/money.js';
import { collectClaudeQuota } from './claude-quota.js';
import { formatResetKstFromIso, formatKstDateRange, kstMonthCycleStart, kstWeekStartMonday } from '../lib/time.js';

const execFileAsync = promisify(execFile);

export async function collectClaudeUsage(options = {}) {
  const warningThreshold = options.warningThreshold ?? CONFIG.warningThreshold;
  const dangerThreshold = options.dangerThreshold ?? CONFIG.dangerThreshold;
  const audit = [];
  const ccusagePath = await findExecutable('ccusage');
  const cost = ccusagePath ? await collectCost(ccusagePath) : { today: [], weekly: [], monthly: [] };
  const metrics = [];
  let latestUsage = null;

  // quota(%): /api/oauth/usage 실시간 조회(읽기 전용·refresh 안 함). 실패 시 마지막 성공값(stale)·미표시.
  const quota = await collectClaudeQuota({ warningThreshold, dangerThreshold });
  metrics.push(...quota.metrics);
  audit.push(...quota.audit);
  // measuredAt이 없어도(캐시조차 없는 미표시) 사유 코드는 전달한다 — 표시 계층이 안내 문구를 고를 근거.
  latestUsage = {
    measuredAt: quota.measuredAt ?? null,
    fresh: quota.fresh,
    quotaStatus: quota.status,
    staleReason: quota.staleReason ?? null
  };

  audit.push({
    source: 'ccusage',
    status: ccusagePath ? 'confirmed' : 'missing',
    detail: ccusagePath
      ? `Found ccusage at ${displayPath(ccusagePath)}.`
      : 'ccusage command is not installed, so Claude token cost breakdown cannot be read.'
  });
  // ccusage가 있는데 실행이 실패하면 비용이 조용히 사라진다 — audit에 흔적을 남긴다(No Silent Fallback).
  if (cost.failed) {
    audit.push({ source: 'ccusage', status: 'warning', detail: `ccusage 실행 실패 — 비용 미표시. (${cost.failed})` });
  }
  // (제거됨) Phase 1의 JSONL 키패스 탐색 audit — quota 소스가 /api/oauth/usage로 확정되어
  // 어떤 지표에도 안 쓰이는데 'candidate' 표시가 "수집 실패"처럼 오독돼 삭제(2026-07-09 결정).

  const hasQuota = metrics.length > 0;
  const facts = [
    ...(hasQuota ? [] : quotaPending()),
    ...cost.monthly,
    ...cost.weekly,
    ...cost.today
  ];

  return {
    status: hasQuota ? 'ok' : facts.length > 0 ? 'partial' : 'unavailable',
    name: 'Claude Code',
    planType: quota.planType ?? null,
    metrics,
    facts,
    latestUsage,
    audit,
    notes: [
      '사용률(현재세션/주간/Fable)은 /api/oauth/usage 실시간 조회. 읽기 전용이라 로그인에 영향 없음.',
      'Cost facts are estimated token cost, not subscription billing or quota percent.'
    ]
  };
}

// 실시간 조회도, 마지막 성공값(캐시)도 없을 때만 보이는 정직한 미표시 자리(가짜 % 만들지 않음).
function quotaPending() {
  const detail = '실시간 사용률 조회 불가 — Claude Code 사용 시 토큰이 갱신되면 표시됨';
  return [
    { label: '5시간', value: '미표시', detail, source: 'claude.oauth.usage.limits.session', group: '사용률 %' },
    { label: '주간', value: '미표시', detail, source: 'claude.oauth.usage.limits.weekly_all', group: '사용률 %' }
  ];
}

// 오늘·주간(월~일)·월간(1일~)을 일별 데이터 한 번으로 산출한다.
// 각 구간은 총액(타이틀 없이 값만) + 모델별로 구성한다(대시보드 그룹 헤더가 타이틀 역할).
async function collectCost(ccusagePath) {
  const now = new Date();
  const monday = kstWeekStartMonday(now);
  const monthStart = kstMonthCycleStart(now, CONFIG.monthlyCycleStartDay);
  const todayStart = new Date(`${kstDateKey(now)}T00:00:00+09:00`);
  const since = [monday, monthStart, todayStart].reduce((a, b) => (a < b ? a : b));
  let daily = [];
  try {
    const { stdout } = await execFileAsync(
      ccusagePath,
      ['claude', 'daily', '--breakdown', '--json', '--since', kstDateKey(since).replaceAll('-', '')],
      { timeout: 20000, maxBuffer: 10 * 1024 * 1024 }
    );
    daily = JSON.parse(stdout).daily ?? [];
  } catch (error) {
    // 실행 실패(≠사용량 0)는 비용을 못 구한 것 — 빈 값 + 실패 사유(호출부가 audit에 기록).
    return { today: [], weekly: [], monthly: [], failed: error.message };
  }

  return {
    monthly: rangeItems(daily, monthStart, now, 'monthly'),
    weekly: rangeItems(daily, monday, now, 'weekly'),
    today: rangeItems(daily, todayStart, now, 'today')
  };
}

// 특정 날부터 오늘까지 일별을 합산해 [총액(라벨 없음) + 모델별]을 만든다.
// 사용량이 0이어도(월초·새 설치) 총액 $0.0은 표시한다 — "성공했는데 0"과 "못 구함"을 섞지 않기 위함.
function rangeItems(daily, startDate, now, group) {
  const startKey = kstDateKey(startDate);
  const buckets = daily.filter((day) => day.date >= startKey);
  const totalCost = buckets.reduce((sum, day) => sum + numberOrZero(day.totalCost), 0);
  const totalTokens = buckets.reduce((sum, day) => sum + totalTokensFrom(day), 0);

  const items = [{
    label: '', // 그룹 헤더가 타이틀 역할 → 박스 안엔 값만
    value: formatUsd(totalCost),
    rawCost: totalCost,
    detail: `${compactNumber(totalTokens)} tokens`,
    period: formatKstDateRange(startDate, now),
    source: `ccusage.claude.daily.${group}`,
    group
  }];

  const byModel = new Map();
  for (const day of buckets) {
    for (const model of day.modelBreakdowns ?? []) {
      const key = shortModelName(model.modelName);
      const acc = byModel.get(key) ?? { cost: 0, tokens: 0 };
      acc.cost += numberOrZero(model.cost);
      acc.tokens += totalTokensFrom(model);
      byModel.set(key, acc);
    }
  }
  const models = [...byModel.entries()]
    .map(([name, acc]) => ({
      label: name,
      value: formatUsd(acc.cost),
      rawCost: acc.cost,
      rawTokens: acc.tokens,
      detail: `${compactNumber(acc.tokens)} tokens`,
      source: `ccusage.claude.daily.${group}.breakdown`,
      group: `${group} by model`
    }))
    .filter((model) => model.rawCost > 0.005 || model.rawTokens > 0)
    .sort((a, b) => b.rawCost - a.rawCost || b.rawTokens - a.rawTokens)
    .slice(0, 8);

  return [...items, ...models];
}

function kstDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function totalTokensFrom(item) {
  return numberOrZero(item.inputTokens) + numberOrZero(item.outputTokens)
    + numberOrZero(item.cacheCreationTokens) + numberOrZero(item.cacheReadTokens);
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function compactNumber(value) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function shortModelName(name) {
  const map = {
    'claude-fable-5': 'Fable',
    'claude-opus-4-8': 'Opus',
    'claude-opus-4-7': 'Opus',
    'claude-sonnet-5': 'Sonnet',
    'claude-haiku-4-5-20251001': 'Haiku'
  };
  return map[name] ?? String(name ?? 'unknown').replace(/^claude-/, '');
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
