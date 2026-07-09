import { CONFIG } from '../config.js';
import { collectClaudeUsage } from '../collectors/claude.js';
import { collectCodexUsage } from '../collectors/codex.js';
import { collectCodexResetCredits } from '../collectors/reset-credits.js';
import { collectExchangeRate } from '../collectors/exchange-rate.js';
import { formatAge } from './time.js';

export async function buildSnapshot(options = {}) {
  const now = new Date();
  const warningThreshold = options.warningThreshold ?? CONFIG.warningThreshold;
  const dangerThreshold = options.dangerThreshold ?? CONFIG.dangerThreshold;

  const [claude, codex, resetCredits, exchange] = await Promise.all([
    collectClaudeUsage({ ...(options.claude ?? {}), warningThreshold, dangerThreshold }),
    collectCodexUsage({ ...(options.codex ?? {}), warningThreshold, dangerThreshold }),
    collectCodexResetCredits(options.resetCredits ?? {}),
    collectExchangeRate(options.exchange ?? {})
  ]);

  // 각 서비스 데이터의 "측정 시각"(실시간이면 방금). 스냅샷 생성시각(generatedAt)과 구분한다.
  //  - generatedAt: 이 숫자를 마지막으로 계산한 시각 = "새로고침" 시각.
  //  - data.<svc>.measuredAt/fresh: 각 서비스 값이 실시간(fresh)인지, 캐시·세션(오래됨)인지.
  const claudeMeasuredAt = claude.latestUsage?.measuredAt ?? null;
  const codexMeasuredAt = codex.measuredAt ?? null;
  const claudeFresh = claude.latestUsage?.fresh ?? false;
  const codexFresh = codex.fresh ?? false;

  // 활성 서비스 중 하나라도 실시간이 아니면(캐시·세션 폴백) stale 신호.
  const claudeActive = (claude.metrics?.length ?? 0) > 0;
  const codexActive = (codex.metrics?.length ?? 0) > 0;
  const isStale = (claudeActive && !claudeFresh) || (codexActive && !codexFresh);

  // 초기화권: 전용 endpoint(만료일 상세)가 켜져 있으면 그걸, 아니면 usage 응답의 개수라도 정직히 채운다.
  const mergedResetCredits = resetCredits.status === 'ok'
    ? resetCredits
    : (Number.isFinite(codex.usageCredits)
      ? { status: 'ok', availableCount: codex.usageCredits, credits: [], audit: resetCredits.audit }
      : resetCredits);

  return {
    app: {
      name: 'AI Charge Desk',
      generatedAt: now.toISOString(),
      warningThreshold,
      dangerThreshold,
      staleAfterMinutes: CONFIG.staleAfterMinutes,
      isStale,
      data: {
        claude: { measuredAt: claudeMeasuredAt, fresh: claudeFresh, ageLabel: claudeMeasuredAt ? formatAge(claudeMeasuredAt, now) : null },
        codex: { measuredAt: codexMeasuredAt, fresh: codexFresh, ageLabel: codexMeasuredAt ? formatAge(codexMeasuredAt, now) : null }
      },
      exchange: {
        rate: exchange.rate,
        target: exchange.target,
        fetchedAt: exchange.fetchedAt,
        stale: exchange.stale,
        status: exchange.status
      }
    },
    services: {
      claude,
      codex: {
        ...codex,
        resetCredits: mergedResetCredits
      }
    },
    audit: {
      exchange: exchange.audit
    }
  };
}
