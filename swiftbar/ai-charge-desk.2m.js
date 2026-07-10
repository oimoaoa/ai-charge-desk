#!/bin/sh
":" //# ; for n in "$(command -v node)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do [ -n "$n" ] && [ -x "$n" ] && exec "$n" "$0" "$@"; done; echo "⚠️ node 없음"; echo "---"; echo "Node.js를 찾지 못했어요 — brew install node 후 SwiftBar에서 Refresh"; exit 0
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

// SwiftBar 플러그인: 상태바에 요약을 보여주고, 클릭하면 로컬 대시보드를 연다.
// 파일명 `.2m.`은 2분마다 다시 그림을 뜻한다(데이터 수집이 아니라 snapshot.json 읽어 다시 그리기).
// repo 위치는 이 파일의 실제 경로에서 역산한다(<repo>/swiftbar/이파일 — 심볼릭 링크도 realpath로 추적).
// 어디에 클론해도 동작하고, 특수 배치가 필요하면 AI_CHARGE_DESK_DIR로 덮어쓸 수 있다.
const root = process.env.AI_CHARGE_DESK_DIR
  ?? path.resolve(path.dirname(fs.realpathSync(process.argv[1])), '..');
const snapshotPath = path.join(root, 'data', 'snapshot.json');
const dashboardFile = path.join(root, 'data', 'dashboard.html'); // 서버 없이 열리는 자립형 파일
const buildScript = path.join(root, 'scripts', 'build-snapshot.mjs');

// 자가 점검: 복사 설치(심볼릭 링크 아님) 등으로 repo를 못 찾으면, 조용히 죽는 대신 원인을 보여준다.
if (!fs.existsSync(buildScript)) {
  console.log('🩷 ⚠️');
  console.log('---');
  console.log('설치 경로를 못 찾았어요 — 플러그인 파일은 복사가 아니라 심볼릭 링크(ln -s)로 설치해야 해요');
  console.log(`추정한 위치: ${root}`);
  process.exit(0);
}

// 색 — SwiftBar는 `color=라이트색,다크색`으로 두 모드를 지원한다. 드롭다운이 밝든 어둡든 진하게 보이게.
const WARN = '#f0a12b';           // 70%+ 주의(양쪽에서 잘 보임)
const DANGER = '#ef3127';         // 90%+ 위험
const INK = '#1c2330,#eef1f6';    // 본문(사용률·라벨) — 진하게
const SUBTLE = '#5b6470,#aab4c4'; // 보조(비용·데이터 나이) — 이전보다 진함
const CLAUDE = '#d6407a,#ff5f9c'; // 서비스 헤더색(핑크, 다크서 흐리지 않게 채도 올림)
const CODEX = '#1a7fd4,#3fa9ff';  // 서비스 헤더색(블루, 동일)
const COST_TITLE = { monthly: '이번 달 누적 비용', weekly: '이번 주 누적 비용', today: '오늘 누적 비용' };
// 버튼 공통 아이콘 — "누르는 것"의 표식(전 버튼 동일, 데이터 줄엔 안 붙임).
const BUTTON_ICON = 'chevron.right.circle';
// 막대 글리프 — 같은 Geometric Shapes 블록(U+25A0대)에서 골라야 크기가 균일하다.
// (▓/░는 Block Elements 블록이라 폴백 폰트가 달라 메뉴에서 크기가 어긋남 — 실측 2026-07-10.)
// 확정(제품 결정 2026-07-10): 채움 ■(꽉 참·모서리 라운딩은 수용) / 빈칸 ▤(가로줄) — 밝기 대비 최대와 실루엣 균일의 절충.
const BAR_FILL = '■';
const BAR_EMPTY = '▤';

// stale 사유 코드(R29) → 사람이 읽는 원인. 없는 코드는 일반 문구로.
// (플러그인은 top-level에서 바로 렌더하므로 상수는 여기 상단에 — 아래 함수들보다 먼저 초기화돼야 한다.)
const STALE_REASON_TEXT = {
  'token-expired': 'Claude 토큰 만료',
  'login-required': 'Claude 로그인 풀림 · 터미널에서 claude 실행 후 /login 필요',
  'no-token': 'Claude Code CLI 로그인 이력 없음',
  'keychain-denied': '키체인 접근 실패',
  'fetch-failed': '서버 조회 실패 · 자동 재시도 중'
};
// 미표시(캐시조차 없음) 사유 → 안내.
const UNAVAILABLE_HINT = {
  'no-token': 'Claude Code CLI 로그인 필요 (터미널에서 claude 실행)',
  'login-required': 'Claude 로그인 풀림 — 터미널에서 claude 실행 후 /login',
  'keychain-denied': '키체인 접근 실패',
  'token-expired': 'Claude 토큰 만료'
};

// 자동 수집: 스냅샷이 10분 넘게 낡았으면 백그라운드로 재생성한다(렌더는 막지 않음).
// SwiftBar가 2분마다 이 스크립트를 재실행하므로, 낡음 게이트(10분)로 호출 빈도를 하루 ~120회로 묶는다.
// 끄려면 SwiftBar에서 이 플러그인을 Disable 하면 된다(시스템 설치 없음).
const AUTO_REFRESH_MIN = 10;
maybeAutoRefresh();

const snapshot = readSnapshot(snapshotPath);
const claude = snapshot?.services?.claude;
const codex = snapshot?.services?.codex;
const claudeMetrics = claude?.metrics ?? [];
const codexMetrics = codex?.metrics ?? [];

// 상태바: 각 서비스의 5시간(현재 창) 사용률. 하트 색이 서비스 구분(핑크=Claude·블루=Codex),
// 구분점 없이 여백만(디자인 결정: 시안 B). 색은 전체에서 가장 위험한 등급(이모지는 원색 유지).
// 옛 데이터면 % 뒤 ⚠️ — 카운트다운이 흘러가 살아 보여도 값 자체가 옛것임을 상태바에서 바로 알 수 있게(R29).
const claudeDataMeta = snapshot?.app?.data?.claude;
const codexDataMeta = snapshot?.app?.data?.codex;
const claudeHead = headPercent(byId(claudeMetrics, 'claude-session')?.usedPercent, '🩷', isStaleMeta(claudeDataMeta));
const codexHead = headPercent(byId(codexMetrics, 'codex-primary')?.usedPercent, '🩵', isStaleMeta(codexDataMeta));
const headColor = tierColor(worstTier([...claudeMetrics, ...codexMetrics]));
console.log(`${claudeHead}  ${codexHead}${headColor ? ` | color=${headColor}` : ''}`);

console.log('---');
// 버튼(누르는 것)은 전부 같은 아이콘(SF Symbol chevron.right.circle)으로 데이터 줄과 구분한다(제품 결정 2026-07-10).
// 새로고침 버튼에 마지막 수집 시각을 병합 표기(별도 "새로고침: N 전" 줄 제거 — 제품 결정 2026-07-10).
// 새로고침은 래퍼 스크립트로: 수집이 "끝난 뒤" swiftbar:// URL로 다시 그리게 순서를 강제한다.
// (refresh=true만 쓰면 SwiftBar가 명령 종료를 안 기다리고 즉시 다시 그려 옛 스냅샷이 보일 수 있음.)
// node 경로는 process.execPath로 전달 — SwiftBar 최소 PATH에서 env node가 안 잡히는 함정 대비.
const refreshedAgo = snapshot?.app?.generatedAt ? agoLabel(snapshot.app.generatedAt) : '기록 없음';
console.log(`데이터 새로고침 (${refreshedAgo}) | bash=${shellArg(path.join(root, 'scripts', 'swiftbar-refresh.sh'))} param1=${shellArg(process.execPath)} terminal=false sfimage=${BUTTON_ICON}`);
// href는 공백·특수문자 경로에서도 열리게 file URL로 인코딩한다.
console.log(`상세 대시보드 열기 | href=${pathToFileURL(dashboardFile).href} sfimage=${BUTTON_ICON}`);
console.log('---');
printService('Claude Code', CLAUDE, claude, claudeDataMeta, { refreshAction: true });
console.log('---');
printService('Codex', CODEX, codex, codexDataMeta, { staleHint: 'Codex 앱·CLI를 한 번 쓰면 갱신될 수 있어요' });
printCredits(codex?.resetCredits);
console.log('---');
console.log(`프로젝트 폴더 | href=${pathToFileURL(root).href} sfimage=${BUTTON_ICON}`);
console.log(`v${appVersion()} · AI Charge Desk | size=11 color=${SUBTLE}`);

// 사용률 미니 막대(10칸) — 쓴 만큼 차오른다. 글리프는 상단 BAR_FILL/BAR_EMPTY 한 곳에서.
function usageBar(percent) {
  if (!Number.isFinite(percent)) return '';
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return BAR_FILL.repeat(filled) + BAR_EMPTY.repeat(10 - filled);
}

// 5시간 창(하루에 여러 번 리셋)은 날짜를 떼고 시간만 — 핵심만 간결하게(제품 결정 2026-07-10).
// 주간 창은 날짜 유지. "곧 리셋"·"사용 시작 전" 같은 비날짜 라벨은 그대로 통과.
function shortResetLabel(metric) {
  const label = metric.resetLabel ?? '';
  if (metric.id === 'claude-session' || metric.id === 'codex-primary') {
    return label.replace(/^(\d{4}-)?\d{2}-\d{2}\([^)]+\)\s*/, '');
  }
  return label;
}

// 버전은 package.json 한 곳에서(하드코딩 금지).
function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '?';
  } catch {
    return '?';
  }
}

function readSnapshot(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// 스냅샷이 오래됐고 지금 재생성 중이 아니면, 백그라운드에서 build-snapshot을 돌린다.
function maybeAutoRefresh() {
  const lockPath = path.join(root, 'data', '.refresh.lock');
  let generatedAt = null;
  try { generatedAt = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))?.app?.generatedAt ?? null; } catch { /* 없으면 재생성 */ }
  const ageMin = generatedAt ? minutesSince(generatedAt) : Infinity;
  if (ageMin !== null && ageMin < AUTO_REFRESH_MIN) return;

  // 겹침 방지: 최근 2분 내 잠금이 있으면(다른 재생성 진행 중) 건너뛴다.
  try {
    const lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (lockAgeMs < 120_000) return;
  } catch { /* 잠금 없음 → 진행 */ }

  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, new Date().toISOString());
    const nodeBin = process.execPath;
    const child = spawn(nodeBin, [buildScript], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* 재생성 실패는 조용히 무시(다음 tick에 재시도), 가짜값은 만들지 않음 */ }
}

function byId(metrics, id) {
  return (metrics ?? []).find((metric) => metric.id === id) ?? null;
}

// 여러 지표 중 가장 위험한 등급(danger > warning > normal). 없으면 null.
function worstTier(metrics) {
  let rank = 0;
  for (const metric of metrics ?? []) {
    const r = metric.tier === 'danger' ? 3 : metric.tier === 'warning' ? 2 : metric.tier === 'normal' ? 1 : 0;
    if (r > rank) rank = r;
  }
  return rank === 3 ? 'danger' : rank === 2 ? 'warning' : rank === 1 ? 'normal' : null;
}

function tierColor(tier) {
  if (tier === 'danger') return DANGER;
  if (tier === 'warning') return WARN;
  return null; // 정상/미상: 색 지정 안 함(메뉴바 자동색)
}

function headPercent(value, prefix, stale = false) {
  return Number.isFinite(value) ? `${prefix} ${Math.round(value)}%${stale ? '⚠️' : ''}` : `${prefix} --`;
}

// "옛 데이터" 판정: 측정 시각이 있고, (실시간 && 10분 미만)이 아니면 stale.
// 측정 시각 자체가 없으면 미표시(unavailable) 경로라 stale로 치지 않는다.
function isStaleMeta(dataMeta) {
  if (!dataMeta?.measuredAt) return false;
  const ageMin = minutesSince(dataMeta.measuredAt);
  return !(dataMeta.fresh && ageMin !== null && ageMin < 10);
}

function printService(name, headerColor, service, dataMeta, opts = {}) {
  // 타이틀은 볼드(md=true 마크다운) + 서비스색.
  console.log(`**${name}** | md=true color=${headerColor}`);
  const staleReason = dataMeta?.staleReason ?? null;
  if (!service || (service.metrics ?? []).length === 0) {
    const hint = UNAVAILABLE_HINT[staleReason];
    console.log(`  사용률 미표시${hint ? ` — ${hint}` : ''} | color=${SUBTLE}`);
  } else {
    for (const metric of service.metrics) {
      // "라벨 막대 N% 사용 · 리셋" — 라벨 먼저(확정 레이아웃 2026-07-10), 막대는 쓴 % 기준(R8).
      const gauge = usageBar(metric.usedPercent);
      console.log(`  ${metric.label} ${gauge ? `${gauge} ` : ''}${metric.usedPercent}% 사용 · ${shortResetLabel(metric)} | color=${metricColor(metric)}`);
    }
  }
  // 옛 데이터 안내: 나이 + 원인 + 해법(갱신 버튼·폴백) — R29·R30.
  if (isStaleMeta(dataMeta)) printStaleBlock(dataMeta, staleReason, opts);
  // 비용: 이번 달/주/오늘 누적(달러 기본 + 원화 괄호). 총액 항목(라벨 없음)만.
  for (const fact of (service?.facts ?? []).filter((f) => COST_TITLE[f.group])) {
    console.log(`  ${COST_TITLE[fact.group]}: ${costWithKrw(fact)} | color=${SUBTLE}`);
  }
}

function printStaleBlock(dataMeta, staleReason, opts) {
  // 마지막 수집은 성공했고 나이만 10분을 넘긴 경우(수집 지연·잠자기 복귀 직후) —
  // 곧 자동 수집이 따라잡는 무해한 상태라 원인 대신 "기다리거나 새로고침" 안내만(제품 결정 2026-07-10).
  // 색은 코랄레드(DANGER, 막대 위험색과 동일) — 주황(WARN)은 라이트 메뉴에서 흐려서 안 보임(제품 결정 2026-07-10).
  if (dataMeta.fresh) {
    console.log(`  ⚠️ 옛 데이터(${agoLabel(dataMeta.measuredAt)}) — 곧 자동 갱신돼요 · 급하면 위 "새로고침" | color=${DANGER}`);
    return;
  }
  const reasonText = STALE_REASON_TEXT[staleReason];
  console.log(`  ⚠️ 옛 데이터(${agoLabel(dataMeta.measuredAt)})${reasonText ? ` — ${reasonText}` : ''} | color=${DANGER}`);
  if (staleReason === 'token-expired' && opts.refreshAction) {
    // 원클릭 갱신: claude CLI 최소 호출 1회로 CLI 자신의 정규 토큰 갱신을 트리거(R30).
    // 우리는 토큰을 직접 다루지 않는다 — Phase 2 read-only 결정 유지.
    // login-required(refresh token까지 죽음)면 버튼을 보여주지 않는다 — 재로그인만 해결(가짜 희망 금지, 실측 2026-07-10).
    console.log(`  토큰 갱신하기 (Claude 1회 호출) | bash=${shellArg(path.join(root, 'scripts', 'refresh-claude-token.sh'))} param1=${shellArg(process.execPath)} terminal=false sfimage=${BUTTON_ICON}`);
    console.log(`  터미널에서 claude를 한 번 실행해도 갱신돼요 | color=${SUBTLE}`);
    printRefreshFailure(dataMeta);
  }
  if (opts.staleHint) console.log(`  ${opts.staleHint} | color=${SUBTLE}`);
}

// "갱신하기" 결과 파일(data/token-refresh-result.json)에 실패가 기록돼 있으면 폴백 안내를 보여준다.
// 마지막 성공 수집 이후의 실패만 표시(성공하면 데이터가 fresh로 바뀌어 이 블록 자체가 사라짐).
function printRefreshFailure(dataMeta) {
  let result = null;
  try {
    result = JSON.parse(fs.readFileSync(path.join(root, 'data', 'token-refresh-result.json'), 'utf8'));
  } catch {
    return; // 시도 기록 없음
  }
  if (!result || result.status === 'ok') return;
  const failedAt = Date.parse(result.at);
  const measured = Date.parse(dataMeta.measuredAt);
  if (!Number.isFinite(failedAt) || (Number.isFinite(measured) && failedAt <= measured)) return;
  const label = result.status === 'cli-missing'
    ? 'claude 명령을 못 찾았어요'
    : `호출 실패${result.detail ? ` (${String(result.detail).slice(0, 60)})` : ''}`;
  console.log(`  갱신 실패 — ${label} | color=${DANGER}`);
  console.log(`  Claude Code 대화방에 "AI Charge Desk 토큰 갱신해줘"라고 부탁하면 돼요 | color=${SUBTLE}`);
}

// 드롭다운 지표 색: 90%+ 빨강, 70%+ 주황, Fable은 강조(핑크), 그 외 진한 본문색.
function metricColor(metric) {
  if (metric.tier === 'danger') return DANGER;
  if (metric.tier === 'warning') return WARN;
  if (metric.id && metric.id.includes('fable')) return CLAUDE;
  return INK;
}

// "$X (₩Y)" — 환율이 있으면 원화를 괄호로 덧붙인다.
function costWithKrw(fact) {
  const rate = snapshot?.app?.exchange?.rate;
  if (Number.isFinite(fact.rawCost) && Number.isFinite(rate)) {
    return `${fact.value} (₩${Math.round(fact.rawCost * rate).toLocaleString('ko-KR')})`;
  }
  return fact.value;
}

function printCredits(resetCredits) {
  if (!resetCredits || resetCredits.status !== 'ok') return;
  if (resetCredits.availableCount === 0) return; // 0개면 표시 안 함(제품 결정)
  const count = resetCredits.availableCount ?? '--';
  // 개수 + 이용권마다 만료일 한 줄씩(배분 계획용으로 날짜 전부 보이게, 임박순 정렬됨).
  // 만료일은 available 상태만(사용됨·만료된 이용권 날짜가 남은 것처럼 보이지 않게). 상태값이 낯설면 전부 표시(정보 누락 방지).
  console.log(`  초기화 이용권: ${count}개 남음 | color=${CODEX}`);
  const all = resetCredits.credits ?? [];
  const available = all.filter((credit) => credit.status === 'available');
  for (const credit of (available.length > 0 ? available : all)) {
    if (credit.expiresAtKst) console.log(`  ${credit.expiresAtKst}까지 | color=${SUBTLE}`);
  }
}

function minutesSince(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

function agoLabel(iso) {
  const m = minutesSince(iso);
  if (m === null) return '미확인';
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분 전`;
  return `${Math.floor(h / 24)}일 전`;
}

function shellArg(value) {
  return value.replaceAll(' ', '\\ ');
}
