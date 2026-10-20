#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AigcStudio } from '../core/studio.ts';
import { createCreationPort, aigcDefaults } from '../core/providers.ts';
import { createAigcMcpServer, deliverAigcMcpEvent } from './server.ts';
const file = process.argv[2];
if (!file) throw new Error('Usage: agent-aigc-mcp <explicit-config.json>');
const cfg = JSON.parse(readFileSync(resolve(file), 'utf8'));
const defaults = aigcDefaults();
const config = { ...defaults, ...cfg, image: { ...defaults.image, ...cfg.image },
  video: { ...defaults.video, ...cfg.video }, music: { ...defaults.music, ...cfg.music } };
const studio = new AigcStudio({ directory: resolve(cfg.directory ?? 'aigc-jobs'), provider: kind => createCreationPort(kind, config) });
const guide = readFileSync(new URL('../../skills/imagegen/SKILL.md', import.meta.url), 'utf8');
const server = createAigcMcpServer(studio, guide);
studio.start({
  blob: handle => {
    const selected = (cfg.assets ?? []).find((a: any) => a.handle === handle);
    return selected ? { bytes: readFileSync(resolve(selected.path)), mime: selected.mime } : null;
  },
  pushEvent: event => deliverAigcMcpEvent(server, event),
  log: { warn: message => process.stderr.write(message + '\n') },
});
const stop = async () => { studio.stop(); await server.close(); };
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
await server.connect(new StdioServerTransport());
