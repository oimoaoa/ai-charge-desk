// 막대 규칙(방식 B — 신호등 whole-bar):
// - 막대는 언제나 "쓴 비율(usedPercent)"만큼 채워진다.
// - 채워진 막대 "전체"가 구간에 따라 색이 바뀐다:
//     used < warningThreshold        → 정상(서비스색)
//     warningThreshold ≤ used < danger → 주의(주황)
//     used ≥ dangerThreshold          → 위험(빨강)
// - 색값 자체는 styles.css의 CSS 변수 한 곳에서 관리한다. 여기선 tier(등급)만 정한다.

export function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

export function usageTier(usedPercent, warningThreshold = 70, dangerThreshold = 90) {
  const used = clampPercent(usedPercent);
  if (used === null) return 'unavailable';
  if (used >= dangerThreshold) return 'danger';
  if (used >= warningThreshold) return 'warning';
  return 'normal';
}

export function makeUsageMetric({
  id,
  label,
  usedPercent,
  resetAt,
  resetLabel,
  windowMinutes,
  windowStart,
  windowEnd,
  windowLabel,
  source,
  status = 'ok',
  warningThreshold = 70,
  dangerThreshold = 90,
  note
}) {
  const used = clampPercent(usedPercent);
  const remainingPercent = used === null ? null : roundPercent(100 - used);
  const tier = usageTier(used, warningThreshold, dangerThreshold);

  return {
    id,
    label,
    usedPercent: used === null ? null : roundPercent(used),
    remainingPercent,
    fillPercent: used === null ? 0 : roundPercent(used),
    tier,
    warningThreshold,
    dangerThreshold,
    isWarning: used !== null && used >= warningThreshold,
    resetAt: resetAt ?? null,
    resetLabel: resetLabel ?? '리셋 시각 미확인',
    windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
    windowStart: windowStart ?? null,
    windowEnd: windowEnd ?? null,
    windowLabel: windowLabel ?? null,
    source,
    status,
    note: note ?? null
  };
}

function roundPercent(value) {
  return Math.round(value * 10) / 10;
}
