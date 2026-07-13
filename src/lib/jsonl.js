import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export async function listFilesRecursive(rootDir, predicate = () => true) {
  const files = [];
  if (!fs.existsSync(rootDir)) return files;

  const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath, predicate));
    } else if (entry.isFile() && predicate(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

export async function readJsonlObjects(filePath, onObject) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  let malformed = 0;
  for await (const line of reader) {
    if (!line.trim()) continue;
    try {
      await onObject(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }

  return { malformed };
}

// (제거됨) Phase 1의 키패스 탐색 유틸(collectKeyPaths 등) — 호출부가 사라진 죽은 코드라 삭제.
