import fs from 'node:fs';
import https from 'node:https';
import { CONFIG, displayPath } from '../config.js';
import { formatStampKstFull } from '../lib/time.js';

export async function collectCodexResetCredits(options = {}) {
  // 만료일 상세(title·expires_at)를 위해 기본 활성화. auth.json 토큰 read-only라 usage 조회와 동급 안전.
  // 끄려면 AI_USAGE_DISABLE_CODEX_CREDITS=1.
  const enabled = options.enabled ?? process.env.AI_USAGE_DISABLE_CODEX_CREDITS !== '1';
  const authPath = options.authPath ?? CONFIG.codex.authPath;
  const endpoint = options.endpoint ?? CONFIG.codex.resetCreditsEndpoint;

  if (!enabled) {
    return {
      status: 'disabled',
      availableCount: null,
      credits: [],
      audit: [{
        source: endpoint,
        status: 'disabled',
        detail: 'Disabled by AI_USAGE_DISABLE_CODEX_CREDITS=1. Unset it to query reset credits.'
      }]
    };
  }

  if (!fs.existsSync(authPath)) {
    return {
      status: 'unavailable',
      availableCount: null,
      credits: [],
      audit: [{
        source: displayPath(authPath),
        status: 'missing',
        detail: 'Codex auth file not found.'
      }]
    };
  }

  const accessToken = await readAccessToken(authPath);
  if (!accessToken) {
    return {
      status: 'unavailable',
      availableCount: null,
      credits: [],
      audit: [{
        source: displayPath(authPath),
        status: 'missing',
        detail: 'Access token field not found. Token value was not printed.'
      }]
    };
  }

  try {
    const payload = await getJson(endpoint, accessToken);
    const credits = Array.isArray(payload.credits)
      ? payload.credits.map((credit) => ({
        status: credit.status ?? 'unknown',
        title: credit.title ?? 'Untitled credit',
        expiresAt: normalizeDate(credit.expires_at),
        // 만료일은 배분 계획에 쓰이므로 항상 연도 포함(다른 시각 표기와 달리 연도 생략 안 함).
        expiresAtKst: formatStampKstFull(normalizeDate(credit.expires_at))
      }))
        // 임박한 만료가 위로 오게 정렬(만료일 없는 건 뒤로).
        .sort((a, b) => {
          if (!a.expiresAt) return 1;
          if (!b.expiresAt) return -1;
          return new Date(a.expiresAt) - new Date(b.expiresAt);
        })
      : [];

    return {
      status: 'ok',
      availableCount: Number.isFinite(payload.available_count) ? payload.available_count : null,
      totalEarnedCount: Number.isFinite(payload.total_earned_count) ? payload.total_earned_count : null,
      credits,
      audit: [{
        source: endpoint,
        status: 'confirmed',
        detail: 'Reset-credit endpoint returned JSON. Token value was not printed.'
      }]
    };
  } catch (error) {
    return {
      status: 'error',
      availableCount: null,
      credits: [],
      audit: [{
        source: endpoint,
        status: 'error',
        detail: `Reset-credit query failed: ${error.message}`
      }]
    };
  }
}

async function readAccessToken(authPath) {
  const raw = await fs.promises.readFile(authPath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed?.tokens?.access_token ?? parsed?.access_token ?? null;
}

function getJson(url, accessToken) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Response was not valid JSON.'));
        }
      });
    });

    request.on('error', reject);
    request.setTimeout(15000, () => {
      request.destroy(new Error('Network timeout.'));
    });
  });
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
