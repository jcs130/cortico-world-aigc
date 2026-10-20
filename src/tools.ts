const reference = { type: 'object', additionalProperties: false, required: ['handle', 'role'], properties: {
  handle: { type: 'string', maxLength: 512 }, role: { type: 'string', enum: ['edit-target', 'scene-layout', 'identity', 'style', 'motion', 'audio'] },
  entityId: { type: 'string' }, revision: { type: 'string' }, view: { type: 'string' },
  source: { type: 'object', properties: { world: { type: 'string' }, captureId: { type: 'string' }, observedAt: { type: 'string' }, realm: { type: 'string' } }, additionalProperties: false },
} };
export const AIGC_TOOL_DECLS = [
  {
    name: 'aigc_create', tags: ['act'] as Array<'act'>, barrierAfter: true, interruptible: true,
    description: 'Image, video and music creation through explicitly configured providers. Read capabilities first. generate needs kind, a final host-written prompt and stable request_id. References use Core/Persona handles with explicit roles; put one edit-target/scene-layout first, identity sheets after it. parameters are provider-specific. Returns accepted job id, not goal completion or playback. status/read/inputs/list query original evidence, wait is cancellable without cancelling the job, cancel closes local work but remote computation may continue. Unknown submissions are never retried automatically. No hidden planner, game connection, voice identity guarantee or automatic publishing.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['capabilities', 'generate', 'status', 'read', 'inputs', 'list', 'wait', 'cancel'] },
      kind: { type: 'string', enum: ['image', 'video', 'music'] }, prompt: { type: 'string', minLength: 1, maxLength: 16000 },
      request_id: { type: 'string', minLength: 1, maxLength: 256 }, task_id: { type: 'string', maxLength: 256 },
      references: { type: 'array', maxItems: 14, items: reference },
      parameters: { type: 'object', additionalProperties: true }, id: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 1, maximum: 60000 },
    }, required: ['action'] },
  },
  {
    name: 'aigc_help', tags: ['read'] as Array<'read'>,
    description: 'Read the bundled imagegen-derived creative guide: reference roles, prompt structure, preserving scene/camera/identity, output inspection, and image/video/music workflow. Does not call a model or read Persona memory.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];
export const AIGC_EVENT_DECLS = [
  { type: 'aigc.job', description: 'Archived creation job terminal outcome and generated media; no playback, adoption or goal completion is implied.', trigger: 'flush' as const },
];
