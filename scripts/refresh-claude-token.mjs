import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG } from '../src/config.js';

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
    // stdin을 바로 닫는다 — 안 닫으면 CLI가 파이프 입력을 3초 기다린다(crossval에서 확인된 함정).
    const pending = execFileAsync(cli, ['-p', 'ok', '--model', 'haiku'], { timeout: 180_000, maxBuffer: 1024 * 1024 });
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
