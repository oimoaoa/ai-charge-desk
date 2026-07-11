// 조건이 만족될 때까지 짧게 재시도한다(제자리 폴링). "토큰 갱신하기" 직후 실시간 사용률이
// 실제로 살아나기까지의 지연(키체인 쓰기·서버측 토큰 전파)을 흡수하는 용도.
// 부작용·타이머를 주입받아(테스트에서 즉시 통과) 순수하게 유지한다.

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// collect(): 결과 객체를 반환하는 비동기 함수. isReady(result)가 true면 즉시 멈춘다.
// 최대 maxTries회 시도하며, 시도 사이에만 gapMs 만큼 쉰다(마지막 시도 뒤엔 안 쉼).
// 끝까지 안 되면 가짜 성공을 만들지 않고 { ready:false }로 정직하게 반환한다.
export async function pollUntil(collect, isReady, { maxTries = 6, gapMs = 800, sleep = defaultSleep } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    last = await collect();
    if (isReady(last)) return { ready: true, tries: attempt, last };
    if (attempt < maxTries) await sleep(gapMs);
  }
  return { ready: false, tries: maxTries, last };
}
