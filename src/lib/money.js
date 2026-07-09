// 비용 표기 헬퍼. $ = estimated token cost(토큰 단가 환산 추정치)이고,
// ₩은 그 $ 값을 USD→KRW 환율로 환산한 참고값이다(구독 청구액 아님).

export function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `$${n.toFixed(1)}`;
}

export function krwFromUsd(usd, rate) {
  if (!Number.isFinite(usd) || !Number.isFinite(rate)) return null;
  return usd * rate;
}

export function formatKrw(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `₩${Math.round(n).toLocaleString('ko-KR')}`;
}
