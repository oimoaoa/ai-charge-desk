import assert from 'node:assert/strict';
import { pollUntil } from '../src/lib/retry.js';

const noSleep = async () => {};

// stale 두 번 후 fresh → 3번째 시도에서 멈춘다.
{
  const seq = [{ fresh: false }, { fresh: false }, { fresh: true }];
  let i = 0;
  const r = await pollUntil(() => seq[i++], (q) => q.fresh === true, { maxTries: 6, gapMs: 1, sleep: noSleep });
  assert.equal(r.ready, true);
  assert.equal(r.tries, 3);
  assert.equal(r.last.fresh, true);
}

// 계속 stale → maxTries에서 종료, ready=false(가짜 성공 없음), 시도 사이에만 쉰다.
{
  let calls = 0;
  let sleeps = 0;
  const r = await pollUntil(
    () => { calls += 1; return { fresh: false }; },
    (q) => q.fresh === true,
    { maxTries: 4, gapMs: 1, sleep: async () => { sleeps += 1; } }
  );
  assert.equal(r.ready, false);
  assert.equal(r.tries, 4);
  assert.equal(calls, 4);
  assert.equal(sleeps, 3);
}

// 첫 시도에 바로 fresh → 시도 1회, 대기 0회.
{
  let sleeps = 0;
  const r = await pollUntil(() => ({ fresh: true }), (q) => q.fresh, { maxTries: 6, sleep: async () => { sleeps += 1; } });
  assert.equal(r.ready, true);
  assert.equal(r.tries, 1);
  assert.equal(sleeps, 0);
}

// collect가 throw하면 pollUntil은 삼키지 않고 그대로 전파한다(가드는 호출부 책임 — 교차검증 지적).
{
  await assert.rejects(
    () => pollUntil(async () => { throw new Error('boom'); }, (q) => q.fresh, { maxTries: 3, sleep: noSleep }),
    /boom/
  );
}

console.log('retry.test: ok');
