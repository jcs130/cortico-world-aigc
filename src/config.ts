import type { ConfigGroup } from 'cortico/core/types.ts';
/** Configuration is explicit and hot for new submissions; existing jobs retain their provider. */
export function creationConfigGroup(): ConfigGroup {
  const properties: Record<string, any> = {};
  for (const kind of ['image', 'video', 'music']) {
    const prefix = 'worlds.aigc.' + kind + '.';
    properties[prefix + 'provider'] = { type: 'string', title: kind + ' 供应商', 'x-hot': true,
      enum: kind === 'image' ? ['none', 'comfyui-flux3', 'bailian', 'volcengine'] :
        kind === 'video' ? ['none', 'comfyui-workflow', 'bailian-wan27', 'gateway'] : ['none', 'fal-music', 'yue-gateway', 'gateway'] };
    for (const key of ['endpoint', 'model', 'apiKeyEnv']) properties[prefix + key] = {
      type: 'string', title: kind + ' ' + key, 'x-hot': true,
      ...(key === 'apiKeyEnv' ? { description: 'Only the deployment secret/environment variable name, not the key value' } : {}),
    };
    properties[prefix + 'timeoutMs'] = { type: 'integer', title: kind + ' 等待上限', minimum: 1000, maximum: kind === 'video' ? 3600000 : 1800000, 'x-hot': true };
    properties[prefix + 'maxReferences'] = { type: 'integer', title: kind + ' 参考数上限', minimum: kind === 'image' ? 1 : 0, maximum: 14, 'x-hot': true };
    // Cortico's editable arrays are numeric pairs, not string lists.
    properties[prefix + 'resultHosts'] = { type: 'string', title: kind + ' 结果下载域名（逗号分隔）', 'x-hot': true };
    if (kind !== 'image') properties[prefix + 'pollMs'] = { type: 'integer', title: kind + ' 状态查询间隔', minimum: 50, maximum: 60000, 'x-hot': true };
  }
  for (const key of ['generate', 'edit']) properties['worlds.aigc.image.' + key] = { type: 'boolean', title: '图片 ' + key, 'x-hot': true };
  for (const key of ['unet', 'clip', 'vae']) properties['worlds.aigc.image.flux3.' + key] = { type: 'string', title: 'FLUX 3 ' + key, 'x-hot': true };
  for (const key of ['width', 'height']) properties['worlds.aigc.image.flux3.' + key] = { type: 'integer', minimum: 256, maximum: 2048, title: 'FLUX 3 ' + key, 'x-hot': true };
  properties['worlds.aigc.image.flux3.steps'] = { type: 'integer', minimum: 16, maximum: 16, title: 'FLUX 3 steps（模型契约）', 'x-hot': true };
  properties['worlds.aigc.image.flux3.seed'] = { type: 'integer', minimum: 0, maximum: 2147483647, title: 'FLUX 3 seed', 'x-hot': true };
  properties['worlds.aigc.music.libraryDirectory'] = { type: 'string', title: '本地 YuE 成品曲库目录', 'x-path': { kind: 'directory' }, 'x-hot': true };
  properties['worlds.aigc.music.artifactDirectory'] = { type: 'string', title: '本地 YuE 待审产物目录（可选）', description: '显式保留生成 WAV 供预览；上游审核未通过不等于成品已采用。', 'x-path': { kind: 'directory' }, 'x-hot': true };
  properties['worlds.aigc.video.workflowFile'] = { type: 'string', title: '本地视频工作流配置', 'x-path': { kind: 'file', extensions: ['json'] }, 'x-hot': true };
  return { id: 'world:aigc', owner: 'world:aigc', schema: { type: 'object', title: 'AIGC 创作模型', properties } };
}
