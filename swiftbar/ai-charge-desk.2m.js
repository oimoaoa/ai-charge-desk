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
const claudeHead = headPercent(byId(claudeMetrics, 'claude-session')?.usedPercent, '🩷');
const codexHead = headPercent(byId(codexMetrics, 'codex-primary')?.usedPercent, '🩵');
const headColor = tierColor(worstTier([...claudeMetrics, ...codexMetrics]));
console.log(`${claudeHead}  ${codexHead}${headColor ? ` | color=${headColor}` : ''}`);

console.log('---');
// href는 공백·특수문자 경로에서도 열리게 file URL로 인코딩한다.
console.log(`대시보드 열기 | href=${pathToFileURL(dashboardFile).href}`);
// 주의: `env node`는 SwiftBar의 최소 PATH에서 node를 못 찾는다(비표준 설치 위치 함정).
// 지금 플러그인을 실행 중인 node의 절대 경로(process.execPath)로 실행해야 1클릭에 재수집된다.
console.log(`새로고침 | bash=${shellArg(process.execPath)} param1=${shellArg(buildScript)} terminal=false refresh=true`);
console.log('---');
printService('Claude Code', CLAUDE, claude, snapshot?.app?.data?.claude);
console.log('---');
printService('Codex', CODEX, codex, snapshot?.app?.data?.codex);
printCredits(codex?.resetCredits);
console.log('---');
// "새로고침 시각"(스냅샷 생성 = generatedAt) — 데이터 나이가 아니라 언제 다시 계산했는지.
const refreshedAgo = snapshot?.app?.generatedAt ? agoLabel(snapshot.app.generatedAt) : '기록 없음';
console.log(`새로고침: ${refreshedAgo} | color=${SUBTLE}`);
console.log(`프로젝트 폴더 | href=${pathToFileURL(root).href}`);

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

function headPercent(value, prefix) {
  return Number.isFinite(value) ? `${prefix} ${Math.round(value)}%` : `${prefix} --`;
}

function printService(name, headerColor, service, dataMeta) {
  // 타이틀은 볼드(md=true 마크다운) + 서비스색.
  console.log(`**${name}** | md=true color=${headerColor}`);
  if (!service || (service.metrics ?? []).length === 0) {
    console.log(`  사용률 미표시 | color=${SUBTLE}`);
  } else {
    for (const metric of service.metrics) {
      console.log(`  ${metric.label}: ${metric.usedPercent}% 사용 · ${metric.resetLabel} | color=${metricColor(metric)}`);
    }
  }
  // 데이터가 오래된 경우에만 나이 표시('실시간' 텍스트는 뺌).
  if (dataMeta?.measuredAt) {
    const ageMin = minutesSince(dataMeta.measuredAt);
    const isLive = dataMeta.fresh && ageMin !== null && ageMin < 10;
    if (!isLive) console.log(`  데이터 ${agoLabel(dataMeta.measuredAt)} | color=${SUBTLE}`);
  }
  // 비용: 이번 달/주/오늘 누적(달러 기본 + 원화 괄호). 총액 항목(라벨 없음)만.
  for (const fact of (service?.facts ?? []).filter((f) => COST_TITLE[f.group])) {
    console.log(`  ${COST_TITLE[fact.group]}: ${costWithKrw(fact)} | color=${SUBTLE}`);
  }
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
