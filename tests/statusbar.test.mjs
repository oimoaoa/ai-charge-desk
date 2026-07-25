import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeUsageMetric } from '../src/lib/progress.js';

// 상태바 표시 정책(v0.1.8, 표시정책.md §2) 전 케이스 매트릭스.
// 재구현 검증이 아니라 "실제 플러그인 파일"을 fixture 스냅샷으로 실행해 첫 줄(상태바)을 통째로 비교한다
// (AI_CHARGE_DESK_DIR 주입 — SwiftBar가 실행하는 것과 같은 경로·같은 코드).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginPath = path.join(repoRoot, 'swiftbar', 'ai-charge-desk.2m.js');

// fixture 루트: 플러그인의 설치 자가점검(buildScript 존재)과 자동수집 게이트를 통과할 최소 골격.
const fixtureRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-charge-statusbar-'));
await fs.promises.mkdir(path.join(fixtureRoot, 'data'), { recursive: true });
await fs.promises.mkdir(path.join(fixtureRoot, 'scripts'), { recursive: true });
// 스텁 collector가 실제로 실행됐는지 marker로 센다. 신선한 기본 fixture에서는 0회여야 한다.
const collectorMarkerPath = path.join(fixtureRoot, 'data', 'collector-runs.log');
await fs.promises.writeFile(
  path.join(fixtureRoot, 'scripts', 'build-snapshot.mjs'),
  `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(collectorMarkerPath)}, 'run\\n');\n`
);
await fs.promises.writeFile(path.join(fixtureRoot, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));

// production과 같은 makeUsageMetric 경로로 tier를 만든다.
function metric(id, label, usedPercent) {
  return makeUsageMetric({
    id, label, usedPercent,
    resetLabel: '07-12(일) 17:00',
    source: 'test'
  });
}
const now = () => new Date().toISOString();
const twoHoursAgo = () => new Date(Date.now() - 2 * 3600_000).toISOString();

function snapshotWith({
  claude = [], codex = [],
  claudeFacts = [], codexFacts = [], resetCredits,
  claudeMeta, codexMeta, generatedAt
} = {}) {
  const freshMeta = { measuredAt: now(), fresh: true, staleReason: null };
  return {
    app: {
      generatedAt: generatedAt ?? now(), // 기본은 신선 — 자동수집이 돌지 않게
      data: { claude: claudeMeta ?? freshMeta, codex: codexMeta ?? freshMeta },
      exchange: { rate: 1500 }
    },
    services: {
      claude: { metrics: claude, facts: claudeFacts },
      codex: { metrics: codex, facts: codexFacts, resetCredits }
    }
  };
}

function renderHead(snapshot, extraEnv = {}) {
  fs.writeFileSync(path.join(fixtureRoot, 'data', 'snapshot.json'), JSON.stringify(snapshot));
  const out = execFileSync(process.execPath, [pluginPath], {
    env: { ...process.env, AI_CHARGE_DESK_DIR: fixtureRoot, ...extraEnv },
    encoding: 'utf8'
  });
  return { head: out.split('\n')[0], full: out };
}

async function waitForFile(filePath, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`collector marker가 ${timeoutMs}ms 안에 생성되지 않음`);
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

// 공통 정보 행 enabled rendering + DETAIL 위계 + production tier 경계.
{
  const costFacts = [
    { group: 'monthly', value: '$10.0', rawCost: 10 },
    { group: 'weekly', value: '$3.0', rawCost: 3 },
    { group: 'today', value: '$1.0', rawCost: 1 }
  ];
  const { full } = renderHead(snapshotWith({
    claude: [
      metric('claude-session', '69 경계', 69),
      metric('claude-weekly', '70 경계', 70),
      metric('claude-weekly-fable-normal', 'Fable 정상 핑크', 40),
      metric('claude-weekly-fable', '89.9 경계', 89.9),
      metric('claude-danger', '90 경계', 90)
    ],
    codex: [metric('codex-primary', '5시간', 15)],
    claudeFacts: costFacts,
    codexFacts: costFacts,
    resetCredits: {
      status: 'ok',
      availableCount: 2,
      credits: [
        { status: 'available', expiresAtKst: '2026-08-01(토) 05:12' },
        { status: 'available', expiresAtKst: '2026-08-13(목) 02:40' }
      ]
    }
  }));

  assert.match(full, /\*\*Claude Code\*\* \| md=true color=#b42363,#ff5f9c refresh=true/, 'Claude 헤더 enabled light/dark');
  assert.match(full, /\*\*Codex\*\* \| md=true color=#0067b1,#3fa9ff refresh=true/, 'Codex 헤더 enabled light/dark');
  assert.match(full, /69 경계 .*69% 사용.*color=#1c2330,#eef1f6 refresh=true/, '69 normal production tier');
  assert.match(full, /70 경계 .*70% 사용.*color=#9c5a00,#f0a12b refresh=true/, '70 warning production tier');
  assert.match(full, /Fable 정상 핑크 .*40% 사용.*color=#b42363,#ff5f9c refresh=true/, 'Fable normal CLAUDE pink enabled');
  assert.match(full, /89\.9 경계 .*89\.9% 사용.*color=#9c5a00,#f0a12b refresh=true/, '89.9 warning production tier');
  assert.match(full, /90 경계 .*90% 사용.*color=#c5221f,#ff665e refresh=true/, '90 danger production tier');
  assert.equal((full.match(/┗ 이번 (?:달|주)|┗ 오늘/g) ?? []).length, 6, '양 서비스 비용 3종 전부');
  assert.equal((full.match(/┗ .*color=#1c2330,#eef1f6 refresh=true/g) ?? []).length, 8, '비용 6+이용권 날짜 2 고대비 DETAIL enabled');
  assert.match(full, /초기화 이용권: 2개 남음 \| color=#0067b1,#3fa9ff refresh=true/, '이용권 개수 CODEX enabled');
  assert.match(full, /┗ 2026-08-01\(토\) 05:12까지 \| color=#1c2330,#eef1f6 refresh=true/, '첫 만료일 고대비 DETAIL enabled');
  assert.match(full, /┗ 2026-08-13\(목\) 02:40까지 \| color=#1c2330,#eef1f6 refresh=true/, '둘째 만료일 고대비 DETAIL enabled');
  assert.match(full, /v0\.0\.0-test · AI Charge Desk \| size=11 color=#5b6470,#aab4c4\n/, 'SUBTLE 버전 actionless 유지');
  console.log('✅ 드롭다운 색·위계·enabled 범위');
}

// MenuAction은 collector 0회, Schedule은 collector 1회여야 한다.
{
  const lockPath = path.join(fixtureRoot, 'data', '.refresh.lock');
  fs.rmSync(lockPath, { force: true });
  fs.rmSync(collectorMarkerPath, { force: true });
  const staleSnapshot = snapshotWith({
    claude: [metric('claude-session', '5시간', 70)],
    codex: CODEX_OK,
    generatedAt: twoHoursAgo()
  });
  renderHead(staleSnapshot, { SWIFTBAR_PLUGIN_REFRESH_REASON: 'MenuAction' });
  assert.equal(fs.existsSync(lockPath), false, 'MenuAction은 자동수집 lock을 만들지 않음');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fs.existsSync(collectorMarkerPath), false, 'MenuAction collector 실행 0회');

  renderHead(staleSnapshot, { SWIFTBAR_PLUGIN_REFRESH_REASON: 'Schedule' });
  assert.equal(fs.existsSync(lockPath), true, 'Schedule은 기존 자동수집 freshness gate 유지');
  await waitForFile(collectorMarkerPath);
  assert.equal(fs.readFileSync(collectorMarkerPath, 'utf8').trim().split('\n').length, 1, 'Schedule collector 실행 1회');
  fs.rmSync(lockPath, { force: true });
  fs.rmSync(collectorMarkerPath, { force: true });
  console.log('✅ MenuAction collector 0회 / Schedule collector 1회');
}

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
