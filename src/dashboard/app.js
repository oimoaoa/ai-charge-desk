const snapshot = await loadSnapshot();
const exchange = snapshot.app.exchange ?? { rate: null, stale: true, status: 'unavailable' };

renderFreshness(snapshot);
renderExchange();
renderServices(snapshot);
renderAudit(snapshot);
// 자립형(file://) 페이지는 연 시점의 스냅샷 고정 — 탭을 열어둔 동안에도
// "업데이트: N분 전" 나이 표기만은 계속 정확하게 자라도록 주기 재계산한다.
setInterval(() => renderFreshness(snapshot), 30000);

// ₩ 환산 기준은 카드마다 반복하지 않고 우상단(업데이트 아래) 한 곳에만.
function renderExchange() {
  document.querySelector('#fx').replaceChildren(exchangeNote());
}

async function loadSnapshot() {
  // 자립형 파일(file://)로 열 때: 빌드가 데이터를 window에 인라인해 둔다(서버·fetch 불필요).
  if (globalThis.__SNAPSHOT__) return globalThis.__SNAPSHOT__;
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store' });
    if (response.ok) return response.json();
  } catch {
    // 정적 파일로 열었을 때는 아래 fallback을 사용한다.
  }
  const response = await fetch('../../data/snapshot.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Snapshot not found. Run npm run snapshot first.');
  return response.json();
}

function renderFreshness(data) {
  const node = document.querySelector('#freshness');
  const mins = minutesSince(data.app.generatedAt);
  node.textContent = `업데이트: ${agoLabel(data.app.generatedAt)}`;
  node.title = '이 페이지는 연 시점의 스냅샷 기준. 메뉴바 "새로고침"(사용률·비용·환율 재수집) 뒤 브라우저 새로고침(⌘R)하면 최신이 됩니다.';
  node.classList.toggle('is-stale', mins !== null && mins > 30);
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

function renderServices(data) {
  const root = document.querySelector('#services');
  root.replaceChildren(
    serviceCard('claude', data.services.claude, data.app?.data?.claude),
    serviceCard('codex', data.services.codex, data.app?.data?.codex)
  );
}

// 옛 데이터 판정·문구 — 플러그인(printStaleBlock)과 같은 규칙(R29).
function staleNote(dataMeta) {
  if (!dataMeta?.measuredAt) return null;
  const mins = minutesSince(dataMeta.measuredAt);
  if (dataMeta.fresh && mins !== null && mins < 10) return null;
  // 마지막 수집은 성공, 나이만 넘김 — 곧 자동 수집이 따라잡는 무해한 상태(플러그인과 같은 규칙).
  if (dataMeta.fresh) {
    return el('p', 'stale-note', `⚠️ 옛 데이터(${agoLabel(dataMeta.measuredAt)}) — 잠시 후 자동 갱신 · 메뉴바 "새로고침"으로 즉시`);
  }
  const reasonText = {
    'token-expired': 'Claude 토큰 만료 · 메뉴바 "토큰 갱신하기" 또는 터미널에서 claude 실행하면 갱신',
    'login-required': 'Claude 로그인 풀림 · 터미널에서 claude 실행 후 /login 필요',
    'no-token': 'Claude Code CLI 로그인 이력 없음',
    'keychain-denied': '키체인 접근 실패',
    'fetch-failed': '서버 조회 실패 · 자동 재시도 중'
  }[dataMeta.staleReason];
  return el('p', 'stale-note', `⚠️ 옛 데이터(${agoLabel(dataMeta.measuredAt)})${reasonText ? ` — ${reasonText}` : ''}`);
}

function serviceCard(kind, service, dataMeta) {
  const card = el('article', `service-card ${kind}`);
  const header = el('div', 'service-header');
  const titleBox = el('div');
  titleBox.append(el('h3', '', service.name));
  header.append(titleBox);
  header.append(el('div', 'service-meta', metaText(service)));
  card.append(header);

  // 영역 구분: 사용률(서비스 틴트 존) / 비용(월·주·일 기간 패널) — 라벨 없이 형태로 구분.
  if (service.metrics && service.metrics.length > 0) {
    const list = el('div', 'metric-list');
    for (const metric of service.metrics) list.append(metricRow(metric));
    const note = staleNote(dataMeta);
    card.append(note ? zone('zone-usage', list, note) : zone('zone-usage', list));
  }

  if (service.facts && service.facts.length > 0) {
    card.append(zone('zone-cost', costStack(service.facts)));
  }

  // 한쪽 서비스만 쓰는 사용자: 데이터 없는 카드는 숨기지 않고 정직한 안내를 남긴다.
  if ((!service.metrics || service.metrics.length === 0) && (!service.facts || service.facts.length === 0)) {
    card.append(el('p', 'empty-state', `${service.name} 데이터가 아직 없어요 — 로그인 상태를 확인하고 "새로고침"을 눌러 주세요.`));
  }

  if (kind === 'codex') {
    // Codex를 아예 안 쓰는 사용자(카드가 비어 안내문만 있음)에겐 이용권 실패 박스를 겹쳐 보이지 않는다.
    // Codex 데이터가 있는데 이용권 조회만 실패한 경우엔 실패를 그대로 보여준다(은폐 아님).
    const hasContent = (service.metrics?.length ?? 0) > 0 || (service.facts?.length ?? 0) > 0;
    const credits = resetCredits(service.resetCredits);
    if (credits && (hasContent || service.resetCredits?.status === 'ok')) card.append(credits);
  }
  return card;
}

function zone(kind, ...children) {
  const box = el('section', `zone ${kind}`);
  box.append(...children);
  return box;
}

function metricRow(metric) {
  const row = el('div', 'metric-row');

  const label = el('div', 'metric-label');
  label.append(el('span', '', metric.label));
  const usedText = metric.usedPercent === null ? '준비 중' : `${metric.usedPercent}% 사용`;
  label.append(el('span', `metric-used ${metric.tier}`, usedText));

  const track = el('div', 'progress-track');
  const fill = el('div', `progress-fill ${metric.tier}`);
  fill.style.width = `${metric.fillPercent ?? 0}%`;
  track.append(fill);

  row.append(label, track);
  // 집계 창은 리셋 시각으로 유추 가능해 표시 안 함(제품 결정) — 리셋 줄만.
  row.append(el('div', 'metric-sub', metric.resetLabel));
  return row;
}

// 비용을 기간(이번 달/이번 주/오늘) 패널 3개로 묶는다: 총액 크게 + 모델별은 패널 안 행으로.
function costStack(facts) {
  const stack = el('div', 'cost-stack');
  const groups = new Map();
  for (const fact of facts) {
    const group = fact.group ?? 'facts';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(fact);
  }
  const periods = [['monthly', '이번 달'], ['weekly', '이번 주'], ['today', '오늘']];
  for (const [key, title] of periods) {
    const totals = groups.get(key) ?? [];
    const models = groups.get(`${key} by model`) ?? [];
    if (totals.length === 0 && models.length === 0) continue;
    stack.append(periodPanel(title, totals, models));
    groups.delete(key);
    groups.delete(`${key} by model`);
  }
  // 정의 밖 그룹이 생겨도 숨기지 않고 그대로 보여준다.
  for (const [group, groupFacts] of groups) stack.append(periodPanel(group, [], groupFacts));
  return stack;
}

function periodPanel(title, totals, models) {
  const panel = el('section', 'period-panel');
  const head = el('div', 'period-head');
  head.append(el('span', 'period-title', title));
  const period = [...totals, ...models].find((fact) => fact.period)?.period;
  if (period) head.append(el('span', 'period-range', period));
  panel.append(head);

  for (const fact of totals) {
    const total = el('div', 'period-total');
    total.append(el('b', '', factValue(fact)));
    const sub = fact.detail ?? fact.source;
    if (sub) total.append(el('span', '', sub));
    panel.append(total);
  }

  for (const fact of models) {
    const row = el('div', 'model-row');
    const main = el('div');
    if (fact.label) main.append(el('strong', '', fact.label));
    const sub = fact.detail ?? fact.source;
    if (sub) main.append(el('span', '', sub));
    row.append(main);
    row.append(el('b', '', factValue(fact)));
    panel.append(row);
  }
  return panel;
}

function factValue(fact) {
  if (Number.isFinite(fact.rawCost) && Number.isFinite(exchange.rate)) {
    const krw = formatKrw(fact.rawCost * exchange.rate);
    return `${fact.value} (${krw})`;
  }
  return fact.value;
}

function exchangeNote() {
  // 우상단 한 줄 메타에 인라인으로 끼므로 span으로 만든다.
  if (Number.isFinite(exchange.rate)) {
    const stamp = exchange.stale ? ' · 옛 환율' : '';
    return el('span', `fx-note${exchange.stale ? ' is-stale' : ''}`,
      `₩ 환산 기준: $1 ≈ ${formatKrw(exchange.rate)}${stamp}`);
  }
  return el('span', 'fx-note is-stale', '₩ 환산: 환율을 못 받아 표시 못 함 (달러만)');
}

function formatKrw(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '₩--';
  return `₩${Math.round(n).toLocaleString('ko-KR')}`;
}

function resetCredits(data) {
  // 칩 대신 "N개 남음" + 이용권마다 만료일 한 줄(배분 계획용으로 날짜 전부, 임박순).
  // 0개면 박스 자체를 숨긴다(조회 실패는 0개가 아니므로 계속 표시 — 실패 은폐 아님).
  if (data?.status === 'ok' && data.availableCount === 0) return null;
  const box = el('div', 'credits');
  if (!data || data.status !== 'ok') {
    box.append(el('p', 'credit-title', '초기화 이용권'));
    box.append(el('p', 'credit-date', `조회 못 함 — ${statusLabel(data?.status ?? 'unavailable')}`));
    return box;
  }
  box.append(el('p', 'credit-title', `초기화 이용권 ${data.availableCount ?? '--'}개 남음`));
  // 만료일은 available 상태만(사용·만료된 것의 날짜가 남은 것처럼 보이지 않게). 상태값이 낯설면 전부 표시.
  const available = data.credits.filter((credit) => credit.status === 'available');
  for (const credit of (available.length > 0 ? available : data.credits)) {
    if (credit.expiresAtKst) box.append(el('p', 'credit-date', `${credit.expiresAtKst}까지`));
  }
  return box;
}

function renderAudit(data) {
  const root = document.querySelector('#audit');
  const items = [
    ...data.services.claude.audit.map((item) => ({ label: 'Claude', ...item })),
    ...data.services.codex.audit.map((item) => ({ label: 'Codex', ...item })),
    ...data.services.codex.resetCredits.audit.map((item) => ({ label: 'Codex 이용권', ...item })),
    ...(data.audit?.exchange ? [{ label: '환율', ...data.audit.exchange }] : [])
  ];
  root.replaceChildren(...items.map((item) => {
    const node = el('div', 'audit-item');
    node.append(el('span', `audit-status ${item.status}`, `${item.label} · ${statusLabel(item.status)} (${item.status})`));
    node.append(el('p', 'audit-original', item.detail));
    return node;
  }));
}

function metaText(service) {
  // 플랜 등급(max/plus)을 보여준다. 등급 정보가 없으면 영어 상태값을 노출하지 않고 비워둔다.
  const plan = service.planType;
  if (typeof plan === 'string' && plan) return plan.toUpperCase();
  return '';
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function statusLabel(status) {
  const labels = {
    confirmed: '확인됨', ok: '정상', candidate: '후보', missing: '없음',
    unavailable: '사용 불가', disabled: '꺼짐', error: '오류', warning: '주의'
  };
  return labels[status] ?? '상태';
}
