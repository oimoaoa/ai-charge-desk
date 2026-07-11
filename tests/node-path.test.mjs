import assert from 'node:assert/strict';
import path from 'node:path';
import { withNodeDirOnPath } from '../src/lib/node-path.js';

const nodeDir = path.dirname('/opt/tools/bin/node');

// 기존 PATH 앞에 node 폴더가 붙고, 나머지 env는 보존된다.
{
  const out = withNodeDirOnPath({ PATH: '/usr/bin:/bin', FOO: 'bar' }, '/opt/tools/bin/node');
  assert.equal(out.PATH, `${nodeDir}${path.delimiter}/usr/bin:/bin`);
  assert.equal(out.FOO, 'bar');
}

// PATH가 비어 있어도 최소한 node 폴더는 넣는다(구분자로 시작하지 않게).
{
  const out = withNodeDirOnPath({}, '/opt/tools/bin/node');
  assert.equal(out.PATH, nodeDir);
}

// 인자 없이 호출하면 지금 도는 node의 폴더가 PATH에 포함된다.
{
  const out = withNodeDirOnPath();
  assert.ok(out.PATH.includes(path.dirname(process.execPath)));
}

console.log('node-path.test: ok');
