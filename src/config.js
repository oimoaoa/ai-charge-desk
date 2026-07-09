import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = os.homedir();
// import.meta.dirname은 Node 20.11+ 전용이라 쓰지 않는다(README의 Node 18+ 약속 유지 — 교차검증 지적).
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(projectRoot, 'data');

export const CONFIG = {
  projectRoot,
  dataDir,
  dashboardDir: path.join(projectRoot, 'src', 'dashboard'),
  snapshotPath: path.join(dataDir, 'snapshot.json'),
  // 막대 색 전환 임계값(막대 B: 정상 → 주황 → 빨강). 70%부터 경고, 90%부터 위험.
  // 이 값 한 곳이 막대·상태바·대시보드 색을 모두 결정한다(통일).
  warningThreshold: 70,
  dangerThreshold: 90,
  staleAfterMinutes: 30,
  // 월간 누적 비용의 주기 시작일(KST). 기본 = 매월 1일. Claude·Codex 공통.
  // 나중에 특정 구독일로 바꾸려면 이 값만 교체(예: 15 → 매월 15일 시작).
  monthlyCycleStartDay: 1,
  codex: {
    sessionsDir: path.join(home, '.codex', 'sessions'),
    authPath: path.join(home, '.codex', 'auth.json'),
    // 실시간 사용량(5시간/주간) + 초기화권을 한 번에 주는 read-only 조회 endpoint.
    usageEndpoint: 'https://chatgpt.com/backend-api/wham/usage',
    resetCreditsEndpoint: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
  },
  claude: {
    // 비용/토큰은 ccusage로, quota(%)는 아래 oauth usage 엔드포인트(read-only)로 확보한다.
    // 미사용 필드(token refresh endpoint·디스크 credentials 경로 등)는 두지 않는다 —
    // "refresh 안 함" 설계를 코드만 봐도 믿을 수 있게(교차검증 지적).
    // 사용률(%) 마지막 성공값 캐시(토큰·PII 없이 %·리셋시각만). 실시간 조회 실패 시 stale로 표시.
    quotaCachePath: path.join(dataDir, 'claude-quota-cache.json'),
    usageEndpoint: 'https://api.anthropic.com/api/oauth/usage',
    betaHeader: 'oauth-2025-04-20'
  },
  exchange: {
    // USD→KRW 환율. 실패 시 마지막 캐시값을 stale로 표시한다(가짜값 만들지 않음).
    endpoint: 'https://api.frankfurter.app/latest?from=USD&to=KRW',
    cachePath: path.join(dataDir, 'exchange-rate.json'),
    target: 'KRW',
    // 하루 안에 받은 환율은 재사용, 그보다 오래되면 새로 시도한다.
    freshForMinutes: 720
  }
};

export function displayPath(filePath) {
  if (!filePath) return filePath;
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}
