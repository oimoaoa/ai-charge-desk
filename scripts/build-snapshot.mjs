import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../src/config.js';
import { buildSnapshot } from '../src/lib/snapshot.js';

const snapshot = await buildSnapshot();
await fs.promises.mkdir(path.dirname(CONFIG.snapshotPath), { recursive: true });
await fs.promises.writeFile(CONFIG.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

// 서버 없이도 열리는 자립형 대시보드(data/dashboard.html)를 만든다.
// index.html + styles.css + app.js를 인라인하고 데이터를 window에 박는다(file://로 열림).
await writeStandaloneDashboard(snapshot);

// 자동수집 잠금(플러그인이 만든 것)을 정리한다.
await fs.promises.rm(path.join(CONFIG.dataDir, '.refresh.lock'), { force: true });

async function writeStandaloneDashboard(snap) {
  const html = await fs.promises.readFile(path.join(CONFIG.dashboardDir, 'index.html'), 'utf8');
  const css = await fs.promises.readFile(path.join(CONFIG.dashboardDir, 'styles.css'), 'utf8');
  const js = await fs.promises.readFile(path.join(CONFIG.dashboardDir, 'app.js'), 'utf8');
  const dataScript = `<script>globalThis.__SNAPSHOT__=${JSON.stringify(snap)};</script>`;
  const out = html
    .replace('<link rel="stylesheet" href="/styles.css">', `<style>\n${css}\n</style>`)
    .replace('<script src="/app.js" type="module"></script>', `${dataScript}\n<script type="module">\n${js}\n</script>`);
  await fs.promises.writeFile(path.join(CONFIG.dataDir, 'dashboard.html'), out);
}

console.log(`Wrote ${CONFIG.snapshotPath}`);
console.log(`Codex metrics: ${snapshot.services.codex.metrics.length}`);
console.log(`Claude metrics: ${snapshot.services.claude.metrics.length}`);
console.log(`Claude facts: ${snapshot.services.claude.facts.length}`);
console.log(`Reset credits: ${snapshot.services.codex.resetCredits.status}`);
