import type { ComfyVideoGraph, ComfyVideoWorkflowV2 } from './comfy-workflow.ts';

/** Public recipe only: no service discovery, downloads, process spawning or model calls. */
export interface MiniMaxH3WorkflowOptions {
  fl2va: string;
  ref2va: string;
  textEncoder: string;
  videoVae: string;
  audioVae: string;
  fl2vaTurboLora: string;
  ref2vaTurboLora: string;
  width?: number;
  height?: number;
  maxReferences?: number;
  attention?: 'pytorch attention' | 'comfy kitchen attention';
}

/** LightX2V FL2VA 8-step v1.0 (544p) and Ref2VA 4-step v0.1 (544p).
 * Other LoRAs may require different shifts/schedules; they are not interchangeable.
 * Reference images are identity/style/layout guides, never silently treated as a first frame.
 */
export function buildMiniMaxH3Workflow(options: MiniMaxH3WorkflowOptions): ComfyVideoWorkflowV2 {
  const width = options.width ?? 960, height = options.height ?? 544;
  const maxReferences = options.maxReferences ?? 3;
  if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 32 === 0) ||
    width * height > 768 * 1344 ||
    !Number.isInteger(maxReferences) || maxReferences < 0 || maxReferences > 9 ||
    (options.attention && !['pytorch attention', 'comfy kitchen attention'].includes(options.attention)))
    throw Error('Invalid MiniMax H3 canvas, reference limit or attention backend');
  for (const key of ['fl2va', 'ref2va', 'textEncoder', 'videoVae', 'audioVae', 'fl2vaTurboLora', 'ref2vaTurboLora'] as const) {
    const value = options[key];
    if (typeof value !== 'string' || !value || value.length > 512 || /[\r\n]|\.\.|^[\\/]|^[A-Za-z]:/.test(value))
      throw Error('MiniMax H3 requires explicit relative model filenames: ' + key);
  }
  const variants: ComfyVideoWorkflowV2['variants'] = [];
  for (const profile of ['turbo', 'quality'] as const) for (let count = 0; count <= maxReferences; count++) {
    const graph: ComfyVideoGraph = {
      model: { class_type: 'UNETLoader', inputs: { unet_name: count ? options.ref2va : options.fl2va, weight_dtype: 'default' } },
      clip: { class_type: 'CLIPLoader', inputs: { clip_name: options.textEncoder, type: 'minimax', device: 'default' } },
      vae: { class_type: 'VAELoader', inputs: { vae_name: options.videoVae } },
      audio_vae: { class_type: 'VAELoader', inputs: { vae_name: options.audioVae } },
      attention: { class_type: 'ModelAttentionBackend', inputs: { model: ['model', 0], attention: options.attention ?? 'comfy kitchen attention' } },
      shift: { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['attention', 0], shift_video: 12, shift_audio: 3 } },
      condition: { class_type: count ? 'MiniMaxH3ReferenceToVideo' : 'MiniMaxH3ImageToVideo', inputs: {
        clip: ['clip', 0], vae: ['vae', 0], prompt: '{{prompt}}', width, height, length: '{{frames}}',
        ...(count ? { audio_vae: ['audio_vae', 0], ref_image_size: 'match' } : {}),
      } },
      noise: { class_type: 'RandomNoise', inputs: { noise_seed: '{{seed}}' } },
      guider: { class_type: 'BasicGuider', inputs: { model: ['shift', 0], conditioning: ['condition', 0] } },
      sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
      schedule: { class_type: 'BasicScheduler', inputs: { model: ['shift', 0], scheduler: 'simple', steps: profile === 'quality' ? 20 : count ? 4 : 8, denoise: 1 } },
      sample: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['schedule', 0], latent_image: ['condition', 1] } },
      split: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['sample', 0] } },
      decode: { class_type: 'VAEDecodeTiled', inputs: { samples: ['split', 0], vae: ['vae', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
      decode_audio: { class_type: 'VAEDecodeAudio', inputs: { samples: ['split', 1], vae: ['audio_vae', 0] } },
      video: { class_type: 'CreateVideo', inputs: { images: ['decode', 0], audio: ['decode_audio', 0], fps: '{{fps}}' } },
      save: { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: '{{outputPrefix}}', format: 'mp4', 'format.codec': 'h264' } },
    };
    if (profile === 'turbo') {
      graph.lora = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['model', 0], lora_name: count ? options.ref2vaTurboLora : options.fl2vaTurboLora, strength_model: 1 } };
      graph.attention.inputs.model = ['lora', 0];
    }
    for (let i = 0; i < count; i++) {
      graph['image' + i] = { class_type: 'LoadImage', inputs: { image: '{{image' + i + '}}' } };
      graph.condition.inputs['ref_images.ref_image_' + i] = ['image' + i, 0];
    }
    variants.push({ profile, requiredReferences: count, graph, outputNode: 'save' });
  }
  return {
    schema: 'agent-aigc-comfy-video/v2', fps: 24, frameAlignment: { multiple: 17, offset: 5 },
    durationSec: { min: 4, default: 5, max: 14 }, defaultProfile: 'turbo', variants,
  };
}
