// 모든 시각 표시는 KST(한국시간) 기준. 리셋은 "언제 리셋되는지"가 직관적으로 보이게
// 시계 시각(오후 4:59) + 상대시간(4일 후)을 같이 준다.

const KST = 'Asia/Seoul';

export function toIsoFromEpochSeconds(value) {
  if (!Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

// 통일 시각 표기: "07-12(일) 17:00" (MM-DD(요일) 24시간, 초 없음).
// 올해가 아닐 때만 연도를 앞에 붙인다(예: "2027-01-02(토) 09:00") — 연말·연초 오독 방지.
export function formatStampKst(value, now = new Date()) {
  return stampKst(value, { now });
}

// 항상 연도 포함 표기: "2026-08-01(토) 05:12" — 이용권 만료일처럼 계획(배분)에 쓰는 값 전용.
export function formatStampKstFull(value) {
  return stampKst(value, { alwaysYear: true });
}

function stampKst(value, { now = new Date(), alwaysYear = false } = {}) {
  const date = toDate(value);
  if (!date) return 'unknown';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KST, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = new Intl.DateTimeFormat('ko-KR', { timeZone: KST, weekday: 'short' }).format(date);
  const { hour, minute } = kstHourMinute(date);
  const currentYear = new Intl.DateTimeFormat('en-US', { timeZone: KST, year: 'numeric' }).format(now);
  const yearPrefix = (alwaysYear || get('year') !== currentYear) ? `${get('year')}-` : '';
  return `${yearPrefix}${get('month')}-${get('day')}(${weekday}) ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// 리셋 시각: "07-12(일) 17:00 · 2일 21시간 후".
export function formatResetKst(epochSeconds, now = new Date()) {
  if (!Number.isFinite(epochSeconds)) return '리셋 시각 미확인';
  return `${formatStampKst(new Date(epochSeconds * 1000))} · ${relativeKorean(epochSeconds, now)}`;
}

// ISO 문자열 버전(Claude 등에서 사용).
export function formatResetKstFromIso(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return '리셋 시각 미확인';
  return formatResetKst(date.getTime() / 1000, now);
}

// 리셋 시각이 없을 때의 설명: 창(window)은 첫 사용 순간 열리므로,
// 0% + 시각 없음 = "아직 창이 없다"(정상). 사용량이 있는데 시각만 없으면 진짜 미확인.
export function resetLabelOrIdle(resetValue, usedPercent, now = new Date()) {
  const date = toDate(resetValue);
  if (date) return formatResetKst(date.getTime() / 1000, now);
  if (usedPercent === 0) return '사용 시작 전 — 다음 사용부터 창 시작';
  return '리셋 시각 미확인';
}

// 집계 기간 "시작 ~ 종료": "07-01(수) 00:00 ~ 07-09(목) 19:33".
// 시작·종료가 같은 날이면 종료는 시간만: "07-09(목) 00:00 ~ 19:33".
export function formatKstDateRange(start, end) {
  const s = toDate(start);
  const e = toDate(end);
  if (!s || !e) return null;
  if (kstDateKey(s) === kstDateKey(e)) {
    const { hour, minute } = kstHourMinute(e);
    return `${formatStampKst(s)} ~ ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return `${formatStampKst(s)} ~ ${formatStampKst(e)}`;
}

// 리셋 시각과 창 길이(분)로 집계 시작 시각을 되계산한다.
export function windowStartFromReset(resetEpochSeconds, windowMinutes) {
  if (!Number.isFinite(resetEpochSeconds) || !Number.isFinite(windowMinutes)) return null;
  return new Date((resetEpochSeconds - windowMinutes * 60) * 1000);
}

// 월간 누적 주기의 시작 시각(KST). startDay=1이면 이번 달 1일 00:00(KST).
// 오늘이 startDay보다 이르면 지난달 startDay부터(예: startDay=15인데 오늘이 10일 → 지난달 15일).
export function kstMonthCycleStart(now = new Date(), startDay = 1) {
  const year = Number(new Intl.DateTimeFormat('en-US', { timeZone: KST, year: 'numeric' }).format(now));
  const month = Number(new Intl.DateTimeFormat('en-US', { timeZone: KST, month: 'numeric' }).format(now));
  const day = Number(new Intl.DateTimeFormat('en-US', { timeZone: KST, day: 'numeric' }).format(now));
  let y = year;
  let m = month;
  if (day < startDay) {
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
  }
  const mm = String(m).padStart(2, '0');
  const dd = String(startDay).padStart(2, '0');
  return new Date(`${y}-${mm}-${dd}T00:00:00+09:00`);
}

// 이번 주 시작(월요일 00:00 KST). 비용 "주간" 집계 기준.
export function kstWeekStartMonday(now = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: KST, weekday: 'short' }).format(now);
  const offset = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekday] ?? 0;
  const todayStart = new Date(`${kstDateKey(now)}T00:00:00+09:00`);
  return new Date(todayStart.getTime() - offset * 86400000);
}

export function ageMinutes(isoTimestamp, now = new Date()) {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.round((now.getTime() - date.getTime()) / 60000));
}

export function formatAge(isoTimestamp, now = new Date()) {
  const minutes = ageMinutes(isoTimestamp, now);
  if (minutes === null) return 'unknown age';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return `${hours}h ${rest}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

export function formatKst(isoTimestamp) {
  return formatStampKst(isoTimestamp);
}

export function kstDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: KST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function kstHourMinute(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: KST,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = get('hour') % 24;
  return { hour, minute: get('minute') };
}

function relativeKorean(epochSeconds, now) {
  const diffMin = Math.max(0, Math.round((epochSeconds * 1000 - now.getTime()) / 60000));
  if (diffMin === 0) return '곧 리셋'; // 리셋 시각이 지났거나 임박(스냅샷이 갱신되면 새 창으로 바뀜)
  const days = Math.floor(diffMin / 1440);
  const hours = Math.floor((diffMin % 1440) / 60);
  const minutes = diffMin % 60;
  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간 후` : `${days}일 후`;
  if (hours > 0) return `${hours}시간 ${minutes}분 후`;
  return `${minutes}분 후`;
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
