import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
for (const path of ['dist/index.js', 'dist/core/index.js', 'dist/contracts.d.ts', 'dist/persona/index.js',
  'dist/mcp/server.js', 'dist/mcp/stdio.js', 'dist/ENV_PROMPT.md', 'skills/imagegen/SKILL.md', 'describe.json', 'LICENSE', 'NOTICE'])
  assert.ok(existsSync(path), 'Missing package artifact ' + path);
const describe = JSON.parse(readFileSync('describe.json', 'utf8'));
assert.deepEqual(describe.tools.map(t => t.name).sort(), ['aigc_create', 'aigc_help', 'aigc_query']);
assert.deepEqual(describe.events.map(t => t.type), ['aigc.job']);
const manifest = JSON.parse(readFileSync('dist/build.json', 'utf8'));
for (const row of [...manifest.source, ...manifest.files])
  assert.equal(createHash('sha256').update(readFileSync(row.path)).digest('hex'), row.sha256, 'Stale build: ' + row.path);
