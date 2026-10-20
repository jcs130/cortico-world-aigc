import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExtensionManifest } from 'cortico/extensions/manifest.ts';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import { checkDescribe } from 'cortico/extensions/describe-export.ts';
import definition from '../src/index.ts';
afterEach(() => vi.restoreAllMocks());
it('passes actual Cortico 0.2.4 manifest, configuration, dry-mount and full self-description checks without network', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aigc-official-')), packageDir = fileURLToPath(new URL('../', import.meta.url));
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network permitted'));
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    expect(parseExtensionManifest(pkg).ok).toBe(true);
    const opts = { scratchDir: directory, packageDir };
    expect((await dryMountWorld(definition, opts)).failures).toEqual([]);
    expect((await checkDescribe('world', definition, 'describe.json', opts)).failures).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
