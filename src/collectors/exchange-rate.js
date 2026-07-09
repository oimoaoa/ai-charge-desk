import fs from 'node:fs';
import { CONFIG, displayPath } from '../config.js';

// USD→KRW 환율 수집기.
// 원칙(No Silent Fallback): 못 받으면 조용히 가짜값을 만들지 않는다.
// 마지막으로 받아둔 값이 있으면 그 값을 쓰되 "stale(옛 환율)"로 분명히 표시하고,
// 아무 값도 없으면 unavailable로 둔다.
export async function collectExchangeRate(options = {}) {
  const endpoint = options.endpoint ?? CONFIG.exchange.endpoint;
  const cachePath = options.cachePath ?? CONFIG.exchange.cachePath;
  const target = options.target ?? CONFIG.exchange.target;
  const freshForMinutes = options.freshForMinutes ?? CONFIG.exchange.freshForMinutes;
  const disabled = options.disabled ?? process.env.AI_USAGE_DISABLE_FX === '1';

  const cache = readCache(cachePath);
  const cacheAgeMin = cache ? ageMinutes(cache.fetchedAt) : null;

  // 최근에 받은 값이면 네트워크를 다시 두드리지 않는다.
  if (cache && cacheAgeMin !== null && cacheAgeMin < freshForMinutes) {
    return shape(cache.rate, cache.fetchedAt, target, endpoint, false, 'ok',
      `Cached USD→${target} rate (${Math.round(cacheAgeMin)}m old).`);
  }

  if (disabled) {
    return cache
      ? shape(cache.rate, cache.fetchedAt, target, endpoint, true, 'stale',
          `FX fetch disabled; using last USD→${target} rate.`)
      : shape(null, null, target, endpoint, true, 'unavailable',
          'FX fetch disabled and no cached rate.');
  }

  try {
    const rate = await fetchRate(endpoint, target);
    const fetchedAt = new Date().toISOString();
    writeCache(cachePath, { rate, fetchedAt, source: endpoint });
    return shape(rate, fetchedAt, target, endpoint, false, 'ok',
      `Fetched USD→${target} rate.`);
  } catch (error) {
    if (cache) {
      return shape(cache.rate, cache.fetchedAt, target, endpoint, true, 'stale',
        `FX fetch failed (${error.message}); using last rate from ${formatIso(cache.fetchedAt)}.`);
    }
    return shape(null, null, target, endpoint, true, 'unavailable',
      `FX fetch failed and no cached rate: ${error.message}`);
  }
}

async function fetchRate(endpoint, target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const rate = payload?.rates?.[target];
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('Rate field missing.');
    return rate;
  } finally {
    clearTimeout(timer);
  }
}

function shape(rate, fetchedAt, target, endpoint, stale, status, detail) {
  return {
    rate: Number.isFinite(rate) ? rate : null,
    target,
    fetchedAt: fetchedAt ?? null,
    stale,
    status,
    audit: {
      source: endpoint,
      status: status === 'ok' ? 'confirmed' : status === 'stale' ? 'warning' : 'unavailable',
      detail
    }
  };
}

function readCache(cachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Number.isFinite(parsed.rate) && parsed.fetchedAt) return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeCache(cachePath, data) {
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(data, null, 2)}\n`);
  } catch {
    // 캐시 쓰기 실패는 치명적이지 않다: 이번 값은 그대로 쓰고 다음에 다시 시도한다.
  }
}

function ageMinutes(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, (Date.now() - date.getTime()) / 60000);
}

function formatIso(iso) {
  return displayPath(String(iso));
}
