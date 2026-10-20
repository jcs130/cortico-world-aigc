import type { ConfigGroup } from 'cortico/core/types.ts';
/** Configuration is explicit and hot for new submissions; existing jobs retain their provider. */
export function creationConfigGroup(): ConfigGroup {
  const properties: Record<string, any> = {};
  for (const kind of ['image', 'video', 'music']) {
    const prefix = 'worlds.aigc.' + kind + '.';
    properties[prefix + 'provider'] = { type: 'string', title: kind + ' 供应商', 'x-hot': true,
      enum: kind === 'image' ? ['none', 'comfyui-flux3', 'bailian', 'volcengine'] :
        kind === 'video' ? ['none', 'bailian-wan27', 'gateway'] : ['none', 'fal-music', 'yue-gateway', 'gateway'] };
    for (const key of ['endpoint', 'model', 'apiKeyEnv']) properties[prefix + key] = {
      type: 'string', title: kind + ' ' + key, 'x-hot': true,
      ...(key === 'apiKeyEnv' ? { description: 'Only the deployment secret/environment variable name, not the key value' } : {}),
    };
    properties[prefix + 'timeoutMs'] = { type: 'integer', title: kind + ' 等待上限', minimum: 1000, maximum: 1800000, 'x-hot': true };
    properties[prefix + 'maxReferences'] = { type: 'integer', title: kind + ' 参考数上限', minimum: kind === 'image' ? 1 : 0, maximum: 14, 'x-hot': true };
    properties[prefix + 'resultHosts'] = kind === 'image'
      ? { type: 'string', title: '图片结果下载域名（逗号分隔）', 'x-hot': true }
      : { type: 'array', items: { type: 'string' }, title: kind + ' 结果下载域名', 'x-hot': true };
  }
  for (const key of ['unet', 'clip', 'vae']) properties['worlds.aigc.image.flux3.' + key] = { type: 'string', title: 'FLUX 3 ' + key, 'x-hot': true };
  for (const key of ['width', 'height']) properties['worlds.aigc.image.flux3.' + key] = { type: 'integer', minimum: 256, maximum: 2048, title: 'FLUX 3 ' + key, 'x-hot': true };
  return { id: 'world:aigc', owner: 'world:aigc', schema: { type: 'object', title: 'AIGC 创作模型', properties } };
}
