import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const run = args => {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(['scripts/check-boundaries.mjs']);
run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);
copyFileSync('src/ENV_PROMPT.md', 'dist/ENV_PROMPT.md');
run(['--import', 'tsx', 'scripts/describe.mjs']);
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const record = path => ({ path: path.replaceAll('\\', '/'), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
writeFileSync('dist/build.json', JSON.stringify({ schema: 'agent-aigc-build/v1',
  source: [...walk('src'), ...walk('skills'), 'package.json'].map(record),
  files: walk('dist').filter(p => p.replaceAll('\\', '/') !== 'dist/build.json').map(record),
}, null, 2) + '\n');
