import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 상태바 표시 정책(v0.1.8, 표시정책.md §2) 전 케이스 매트릭스.
// 재구현 검증이 아니라 "실제 플러그인 파일"을 fixture 스냅샷으로 실행해 첫 줄(상태바)을 통째로 비교한다
// (AI_CHARGE_DESK_DIR 주입 — SwiftBar가 실행하는 것과 같은 경로·같은 코드).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginPath = path.join(repoRoot, 'swiftbar', 'ai-charge-desk.2m.js');

// fixture 루트: 플러그인의 설치 자가점검(buildScript 존재)과 자동수집 게이트를 통과할 최소 골격.
const fixtureRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-charge-statusbar-'));
await fs.promises.mkdir(path.join(fixtureRoot, 'data'), { recursive: true });
await fs.promises.mkdir(path.join(fixtureRoot, 'scripts'), { recursive: true });
// 스텁 buildScript — 존재 확인용일 뿐 실행되면 안 된다(generatedAt을 항상 신선하게 줘서 자동수집 게이트가 막음).
await fs.promises.writeFile(path.join(fixtureRoot, 'scripts', 'build-snapshot.mjs'), 'process.exit(0);\n');
await fs.promises.writeFile(path.join(fixtureRoot, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));

// 수집기와 같은 규칙(70/90)으로 tier를 채운 지표 — 플러그인은 precomputed tier를 신뢰하므로 fixture도 그 계약대로.
function metric(id, label, usedPercent) {
  const tier = usedPercent === null ? 'unavailable'
    : usedPercent >= 90 ? 'danger' : usedPercent >= 70 ? 'warning' : 'normal';
  return { id, label, usedPercent, tier, resetLabel: '07-12(일) 17:00' };
}
const now = () => new Date().toISOString();
const twoHoursAgo = () => new Date(Date.now() - 2 * 3600_000).toISOString();

function snapshotWith({ claude = [], codex = [], claudeMeta, codexMeta } = {}) {
  const freshMeta = { measuredAt: now(), fresh: true, staleReason: null };
  return {
    app: {
      generatedAt: now(), // 신선 — 플러그인의 백그라운드 자동수집(spawn)이 절대 안 돌게
      data: { claude: claudeMeta ?? freshMeta, codex: codexMeta ?? freshMeta },
      exchange: { rate: 1500 }
    },
    services: {
      claude: { metrics: claude, facts: [] },
      codex: { metrics: codex, facts: [] }
    }
  };
}

function renderHead(snapshot) {
  fs.writeFileSync(path.join(fixtureRoot, 'data', 'snapshot.json'), JSON.stringify(snapshot));
  const out = execFileSync(process.execPath, [pluginPath], {
    env: { ...process.env, AI_CHARGE_DESK_DIR: fixtureRoot },
    encoding: 'utf8'
  });
  return { head: out.split('\n')[0], full: out };
}

const staleMeta = { measuredAt: twoHoursAgo(), fresh: false, staleReason: 'token-expired' };
const CODEX_OK = [metric('codex-primary', '5시간', 15), metric('codex-secondary', '주간', 14)];

const cases = [
  ['평상 — 모두 정상', {
    claude: [metric('claude-session', '5시간', 54), metric('claude-weekly', '주간', 56), metric('claude-weekly-fable', 'Fable', 40)],
    codex: CODEX_OK
  }, '🩷54%  🩵15%'],

  ['5시간 자체가 70~89% — 하트만 주황, 원인이 보이는 숫자라 괄호 없음', {
    claude: [metric('claude-session', '5시간', 78), metric('claude-weekly', '주간', 30)],
    codex: CODEX_OK
  }, '🧡78%  🩵15%'],

  ['5시간 자체가 90%+ — 빨강 하트, 괄호 없음', {
    claude: [metric('claude-session', '5시간', 93), metric('claude-weekly', '주간', 30)],
    codex: CODEX_OK
  }, '❤️93%  🩵15%'],

  ['숨은 지표 70~89% — 하트만 주황(괄호는 드롭다운 몫)', {
    claude: [metric('claude-session', '5시간', 54), metric('claude-weekly-fable', 'Fable', 75)],
    codex: CODEX_OK
  }, '🧡54%  🩵15%'],

  ['숨은 지표 90%+ — 빨강 하트 + 원인 괄호', {
    claude: [metric('claude-session', '5시간', 54), metric('claude-weekly', '주간', 56), metric('claude-weekly-fable', 'Fable', 93)],
    codex: CODEX_OK
  }, '❤️54%(Fable 93%)  🩵15%'],

  ['숨은 지표 2개 90%+ — 최고 % 하나만', {
    claude: [metric('claude-session', '5시간', 54), metric('claude-weekly', '주간', 91), metric('claude-weekly-fable', 'Fable', 95)],
    codex: CODEX_OK
  }, '❤️54%(Fable 95%)  🩵15%'],

  ['5시간과 숨은 지표 둘 다 90%+ — 괄호는 숨은 쪽', {
    claude: [metric('claude-session', '5시간', 93), metric('claude-weekly-fable', 'Fable', 95)],
    codex: CODEX_OK
  }, '❤️93%(Fable 95%)  🩵15%'],

  ['옛 데이터 — ⚠️는 하트 바로 뒤', {
    claude: [metric('claude-session', '5시간', 54), metric('claude-weekly', '주간', 56)],
    codex: CODEX_OK,
    claudeMeta: staleMeta
  }, '🩷⚠️54%  🩵15%'],

  ['옛 데이터 + 숨은 위험 — ⚠️와 괄호 공존(옛 값 기준 경고임을 ⚠️가 알려줌)', {
    claude: [metric('claude-session', '5시간', 54), metric('claude-weekly', '주간', 93)],
    codex: CODEX_OK,
    claudeMeta: staleMeta
  }, '❤️⚠️54%(주간 93%)  🩵15%'],

  ['서비스 데이터 없음 — 기본 하트 + --, 괄호·⚠️ 없음', {
    claude: [],
    codex: CODEX_OK,
    claudeMeta: { measuredAt: null, fresh: false, staleReason: 'no-token' }
  }, '🩷--  🩵15%'],

  ['Codex 쪽 숨은 위험 — 위치가 소속을 말해줌', {
    claude: [metric('claude-session', '5시간', 54), metric('claude-weekly', '주간', 30)],
    codex: [metric('codex-primary', '5시간', 15), metric('codex-secondary', '주간', 93)]
  }, '🩷54%  ❤️15%(주간 93%)'],

  ['양쪽 다 위험 — 고정 순서(왼쪽 Claude)로 구분', {
    claude: [metric('claude-session', '5시간', 54), metric('claude-weekly', '주간', 95)],
    codex: [metric('codex-primary', '5시간', 15), metric('codex-secondary', '주간', 93)]
  }, '❤️54%(주간 95%)  ❤️15%(주간 93%)'],

  ['소수점 % — 표시는 내림(92.6→92%, 색 임계와 정합)', {
    claude: [metric('claude-session', '5시간', 92.6), metric('claude-weekly', '주간', 12.4)],
    codex: [metric('codex-primary', '5시간', 15.4), metric('codex-secondary', '주간', 14)]
  }, '❤️92%  🩵15%'],

  ['경계 89.6% — 반올림이면 "🧡90%" 모순, 내림이라 🧡89%(tier=warning 원값 기준)', {
    claude: [metric('claude-session', '5시간', 89.6), metric('claude-weekly', '주간', 10)],
    codex: CODEX_OK
  }, '🧡89%  🩵15%'],

  ['경계 69.5% — 하트 정상 유지 + 표시 69%(70 표시·원색 하트 모순 방지)', {
    claude: [metric('claude-session', '5시간', 69.5), metric('claude-weekly', '주간', 10)],
    codex: CODEX_OK
  }, '🩷69%  🩵15%'],

  ['경계 90.0% — 정확히 임계면 ❤️90%', {
    claude: [metric('claude-session', '5시간', 90), metric('claude-weekly', '주간', 10)],
    codex: CODEX_OK
  }, '❤️90%  🩵15%'],

  ['Codex 옛 데이터 — ⚠️ 대칭 동작', {
    claude: [metric('claude-session', '5시간', 54), metric('claude-weekly', '주간', 30)],
    codex: CODEX_OK,
    codexMeta: staleMeta
  }, '🩷54%  🩵⚠️15%'],

  ['라벨에 SwiftBar 파이프 문자 — 첫 줄 문법 보호(| 제거)', {
    claude: [metric('claude-session', '5시간', 54), metric('claude-weekly', '주간|size=20', 93)],
    codex: CODEX_OK
  }, '❤️54%(주간 size=20 93%)  🩵15%'],

  ['부분 결손 — 5시간 없음 + 주간 위험이면 정직하게 --(주간 %) (가짜값 금지)', {
    claude: [metric('claude-weekly', '주간', 93)],
    codex: CODEX_OK
  }, '❤️--(주간 93%)  🩵15%'],

  // --- Codex 창 소멸: 5시간이 정책적으로 사라지면 주간이 대표로 폴백(제품 결정 2026-07-13) ---
  ['Codex 5시간 소멸 — 주간이 대표로 폴백(정상)', {
    claude: [metric('claude-session', '5시간', 54)],
    codex: [metric('codex-secondary', '주간', 2)]
  }, '🩷54%  🩵2%'],

  ['Codex 5시간 소멸 — 주간이 대표인데 90%+면 그 자리에서 ❤️(괄호 없음, 대표 자신)', {
    claude: [metric('claude-session', '5시간', 54)],
    codex: [metric('codex-secondary', '주간', 93)]
  }, '🩷54%  ❤️93%'],

  ['Codex 5시간 소멸 — 주간 대표 70~89%면 🧡', {
    claude: [metric('claude-session', '5시간', 54)],
    codex: [metric('codex-secondary', '주간', 78)]
  }, '🩷54%  🧡78%'],

  ['Codex 주간 소멸 — 5시간만 남으면 5시간이 대표(대칭 동작)', {
    claude: [metric('claude-session', '5시간', 54)],
    codex: [metric('codex-primary', '5시간', 15)]
  }, '🩷54%  🩵15%'],

  // 같은 id가 중복돼도 대표 아닌 둘째 창의 위험이 괄호로 노출된다(객체 참조 비교 — phantom success 방지)
  ['id 중복 방어 — 대표 아닌 둘째 danger가 괄호로 노출', {
    claude: [metric('claude-session', '5시간', 54)],
    codex: [metric('codex-secondary', '주간', 15), metric('codex-secondary', '주간', 93)]
  }, '🩷54%  ❤️15%(주간 93%)']
];

let failed = 0;
for (const [name, spec, expected] of cases) {
  const { head } = renderHead(snapshotWith(spec));
  try {
    assert.equal(head, expected, name);
    // 정책 1: 상태바 줄에 색 지정 금지(시스템 자동색) — 어떤 케이스에서도.
    assert.ok(!head.includes('color='), `${name} — 상태바에 color= 금지`);
    // SwiftBar 첫 줄 문법 보호: |가 있으면 뒤가 파라미터로 오파싱된다 — 어떤 케이스에서도 금지.
    assert.ok(!head.includes('|'), `${name} — 상태바에 | 금지`);
    console.log(`✅ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`❌ ${name}\n   기대: ${expected}\n   실제: ${head}`);
  }
}

// 상태바 이후(드롭다운)는 이번 개편의 비변경 표면 — 헤더·버튼 뼈대가 살아 있는지만 회귀 확인.
const { full } = renderHead(snapshotWith({
  claude: [metric('claude-session', '5시간', 54)],
  codex: CODEX_OK
}));
assert.ok(full.includes('**Claude Code**'), '드롭다운 Claude 헤더 유지');
assert.ok(full.includes('**Codex**'), '드롭다운 Codex 헤더 유지');
assert.ok(full.includes('데이터 새로고침'), '새로고침 버튼 유지');
assert.ok(full.includes('상세 대시보드 열기'), '대시보드 버튼 유지');
console.log('✅ 드롭다운 뼈대 회귀(헤더·버튼) 유지');

// 스냅샷 파손(JSON 깨짐) — 크래시 없이 양쪽 `--`로 정직 표시(가짜값 금지).
{
  fs.writeFileSync(path.join(fixtureRoot, 'data', 'snapshot.json'), '{깨진 json');
  const out = execFileSync(process.execPath, [pluginPath], {
    env: { ...process.env, AI_CHARGE_DESK_DIR: fixtureRoot },
    encoding: 'utf8'
  });
  assert.equal(out.split('\n')[0], '🩷--  🩵--', '스냅샷 파손 → 양쪽 미표시');
  console.log('✅ 스냅샷 파손 — 크래시 없이 🩷--  🩵--');
}

await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n${failed}개 케이스 실패`);
  process.exit(1);
}
console.log(`\n상태바 정책 매트릭스 ${cases.length}케이스 + 드롭다운 회귀 전부 통과`);
