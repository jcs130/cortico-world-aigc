import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { World, WorldHost, ToolDef } from 'cortico/core/types.ts';
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import type { AigcWorldConfig } from './contracts.ts';
import { AigcStudio } from './core/studio.ts';
import { aigcDefaults, createCreationPort } from './core/providers.ts';
import { AIGC_TOOL_DECLS, AIGC_EVENT_DECLS } from './tools.ts';
import { creationConfigGroup } from './config.ts';

const guidePath = fileURLToPath(new URL('../skills/imagegen/SKILL.md', import.meta.url));
const envPath = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
export class AigcWorld implements World {
  readonly id = 'aigc';
  readonly studio: AigcStudio;
  constructor(private readonly config: () => AigcWorldConfig, directory?: string,
    secret?: (name: string) => string) {
    this.studio = new AigcStudio({ directory, provider: kind => {
      const cfg = this.config();
      const keyName = cfg[kind].apiKeyEnv;
      return createCreationPort(kind, cfg, secret ? { env: keyName ? { [keyName]: secret(keyName) } : {} } : {});
    } });
  }
  tools(): ToolDef[] {
    return AIGC_TOOL_DECLS.map(decl => ({ ...decl,
      handler: async (args, ctx) => decl.name === 'aigc_help'
        ? { text: readFileSync(guidePath, 'utf8') } : this.studio.execute(args, ctx) }));
  }
  async start(host: WorldHost): Promise<void> { this.studio.start(host); }
  async stop(): Promise<void> { this.studio.stop(); }
  envPromptVars(): Record<string, string> { return {}; }
  webUi() {
    return { label: 'AIGC 创作室', config: [creationConfigGroup()], promptDocs: [{
      key: 'worlds.aigc.env', title: 'AIGC 创作能力', description: 'Stable creative workflow and inter-World boundaries', role: 'envPrompt' as const, path: envPath,
    }] };
  }
}
const definition: WorldDefinition<AigcWorldConfig> = {
  id: 'aigc', label: 'AIGC 创作室', defaults: aigcDefaults,
  describe: { tools: describeTools(AIGC_TOOL_DECLS, {
    aigc_create: '制作图片、视频或歌曲，并核对异步任务及原始素材',
    aigc_help: '学习参考图分工、提示词组织和创作验收',
  }), events: AIGC_EVENT_DECLS },
  create: ctx => new AigcWorld(() => ctx.cfg, join(ctx.dataDir, 'aigc-jobs'), name => ctx.secret(name)),
};
export default definition;
