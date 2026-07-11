import path from 'node:path';

// ccusage처럼 `#!/usr/bin/env node`로 실행되는 자식 도구를 위해, 지금 도는 node의 폴더를
// PATH 앞에 붙인다. SwiftBar는 플러그인을 최소 PATH로 돌려서 `env node`가 node를 못 찾을 수 있고
// (그러면 ccusage가 죽어 비용 영역이 통째로 사라진다 — 2026-07-11 실측), 이는 플러그인이 자신을
// 실행할 때 process.execPath를 넘기는 것과 같은 원리다. Claude·Codex 수집기 둘 다 ccusage를
// 부르므로 공용으로 둔다. (export는 유닛 테스트용)
export function withNodeDirOnPath(env = process.env, execPath = process.execPath) {
  const nodeDir = path.dirname(execPath);
  const current = env.PATH ?? '';
  return { ...env, PATH: current ? `${nodeDir}${path.delimiter}${current}` : nodeDir };
}
