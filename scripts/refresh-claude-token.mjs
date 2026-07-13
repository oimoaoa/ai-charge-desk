import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG } from '../src/config.js';
import { collectClaudeQuota } from '../src/collectors/claude-quota.js';
import { pollUntil } from '../src/lib/retry.js';

const execFileAsync = promisify(execFile);
const resultPath = path.join(CONFIG.dataDir, 'token-refresh-result.json');

// "갱신하기"(R30): claude CLI를 가장 싼 모델로 한 번 호출한다.
// CLI는 만료된 access token을 만나면 스스로 정규 절차로 갱신해 키체인에 저장한다 —
// 우리는 그 절차를 깨울 뿐, 토큰을 읽거나 쓰지 않는다(Phase 2 read-only 결정 유지).
// 결과는 상태 코드만 기록한다(호출 출력·토큰·개인정보 저장 금지).
const startedAt = new Date().toISOString();
const cli = await findClaude();
let result;
if (!cli) {
  result = { at: startedAt, status: 'cli-missing', detail: null };
} else {
  try {
    // env 인증(setup-token·API 키·게이트웨이 토큰)을 벗기고 호출한다 — 이 버튼의 목적은
    // "키체인의 구독 OAuth"를 갱신시키는 것인데, env 인증이 있으면 우선순위상 키체인을 아예
    // 안 거쳐 갱신이 되지 않는다(공식 인증 우선순위: env 5위 > 키체인 6위 — 2026-07-10 확인).
    const env = { ...process.env };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // stdin을 바로 닫는다 — 안 닫으면 CLI가 파이프 입력을 3초 기다린다(crossval에서 확인된 함정).
    // cwd를 repo로 고정한다 — SwiftBar는 버튼 스크립트를 cwd=/(루트)로 실행해, claude의 작업 폴더
    // 훑기가 ~/Downloads 등 보호 폴더에 닿아 "SwiftBar가 폴더 접근" TCC 팝업을 띄운다(R30 검증에서 실측).
    const pending = execFileAsync(cli, ['-p', 'ok', '--model', 'haiku'], { timeout: 180_000, maxBuffer: 1024 * 1024, env, cwd: CONFIG.projectRoot });
    pending.child.stdin?.end();
    await pending;
    result = { at: new Date().toISOString(), status: 'ok', detail: null };
  } catch (error) {
    // 실패 사유는 의미 있는 첫 줄만 짧게 — 원문 통째 저장 금지(민감정보 유입 차단).
    // CLI는 "Warning: …" 안내를 stderr에 먼저 찍을 수 있어, 경고가 아닌 줄을 우선 고른다.
    const lines = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
    const meaningful = lines.find((l) => !l.startsWith('Warning:')) ?? lines[0] ?? error?.message ?? '알 수 없는 오류';
    result = { at: new Date().toISOString(), status: 'call-failed', detail: String(meaningful).slice(0, 160) };
  }
}
await fs.promises.mkdir(CONFIG.dataDir, { recursive: true });
await fs.promises.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`token refresh: ${result.status}`);

// 갱신 트리거가 성공했으면, 실시간 사용률이 실제로 살아날 때까지 짧게 재확인한다
// (대기 최대 ~4초 = 최대 5회 × 0.8초 + 매 시도의 실시간 조회 지연). 이 스크립트 뒤에
// (swiftbar-refresh 래퍼가) build-snapshot을 돌리므로, 여기서 fresh를 확인해 두면 재수집이
// 한 번에 성공해 드롭다운에 바로 반영된다 — 예전엔 한 박자 늦어 수동 새로고침이 또 필요했다.
// 끝까지 안 살아나면(로그인 풀림 등) 가짜 성공을 만들지 않고 그대로 둔다(정직한 stale — No Silent Fallback).
// poll은 "빌드 전에 데워두기"용 보조 단계다 — 예상 못한 조회 오류가 나도 이미 성공한 토큰 갱신과
// 뒤따르는 build-snapshot을 막지 않게 best-effort(try-catch)로 감싼다.
if (result.status === 'ok') {
  try {
    const poll = await pollUntil(() => collectClaudeQuota(), (q) => q?.fresh === true);
    console.log(`quota poll: ${poll.ready ? 'fresh' : 'still-stale'} after ${poll.tries} tries`);
  } catch (error) {
    console.log(`quota poll: error (${String(error?.message ?? error).slice(0, 80)})`);
  }
}

// claude CLI 탐색 — collectors/claude.js findExecutable과 같은 원리(SwiftBar 최소 PATH 대비).
async function findClaude() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.claude', 'local', 'claude')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const { stdout } = await execFileAsync('/bin/zsh', ['-lc', 'command -v claude'], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
