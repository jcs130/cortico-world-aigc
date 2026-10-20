import { writeFileSync, readFileSync } from 'node:fs';
import definition from '../dist/index.js';
writeFileSync('describe.json', JSON.stringify({ ...definition.describe, prompts: [{
  key: 'worlds.aigc.env', title: 'AIGC 创作能力', role: 'envPrompt', content: readFileSync('src/ENV_PROMPT.md', 'utf8'),
}] }, null, 2) + '\n');
