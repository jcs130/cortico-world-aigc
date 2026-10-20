# First-person camera pairing

## Reference admission

A live first-frame reference must describe the same view consumed by the video
model. A pretty reference from an earlier action is insufficient. In particular,
an earlier downward garden photo must not initialize a later level workshop view.

Live relay configurations explicitly provide `anchorFile`, `referenceReadyFile`
and `referencePolicy`. The private receipt uses `agent-mc-render-reference/v1` and
binds the original core scene, observed camera, proxy image and enhanced anchor
with SHA-256. The relay verifies all files and checks the actual viewer camera
before admitting the first model chunk.

`referencePolicy` specifies maximum age (milliseconds), eye/feet displacement
(blocks), yaw/pitch differences (degrees) and FOV difference (degrees). Yaw uses
the shortest wrapped angle. A roll change is rejected. Bad or missing camera
data, changed source identity, altered files and mismatched views fail admission;
they are not relabeled as live gameplay.

For first person, set `render.showSelf: false` and omit `cameraOffset`. Preserve
the core camera's `mineflayer-radians` convention, eye position, yaw, pitch, roll
and FOV. Source frames, health and worker chunk receipts retain actual cameras.
These numbers support evidence and admission checks. EdenLive still consumes
rendered RGB through Proxy-DINO; this adapter does not claim a newly trained raw
camera-vector control channel.

## Preparation order and prompts

The worker may explicitly wait at a finite post-warmup reference barrier:
`referenceReadyFile` and `referenceWaitSeconds` (1–900). It releases unused CUDA
allocator cache, reports `awaiting-reference`, and waits for a receipt whose
anchor hash matches. SIGINT/SIGTERM cancel the wait. There is no automatic image
request, game command, restart or additional language-model loop.

The host prepares a new reference after warmup, checks its visible framing and
publishes the receipt atomically. Image preparation can still take long enough
for the player to move. The host and relay therefore recheck the camera at
admission; preparing the image after warmup alone is not proof of alignment.

The image caption describes only the selected frame. The continuous-video prompt
contains stable style, material and spatial-preservation requirements. It must
not prescribe a fixed activity, permanent downward view or previous location.
Scene changes come from actual input, rather than an old farming narrative.

## Local trial, 2026-10-20

- The rejected first run paired an earlier downward garden reference with a
  later level scene. Its persistent prompt also mentioned downward garden views.
  It is retained as a failed trial, not evidence of correct first-person framing.
- A new CPU-text-encoder reference produced a proper level outdoor photo, but
  required 232.26 seconds. The player moved during preparation; age, position and
  yaw checks rejected it before the video request. The image remains valid only
  for its original recorded view.
- A GPU-text-encoder workshop reference took 92.39 seconds. At actual model
  admission, displacement was 0, pitch/roll/FOV differences were 0 and yaw
  difference was about 0.000006 degrees. Reference age was 153.67 seconds under
  the explicitly configured 180-second bound. Manual inspection confirmed a level
  workshop view with horizontal windows, upright walls, benches and an anvil.
- The finite 832×480 run delivered 1,441 model frames in 82.439 seconds: 17.47
  actual presentations per second. Proxy-to-relay latency median was 1.275 seconds,
  p90 2.637 seconds. These exclude first-reference warm start and preparation time;
  they are not independently measured Minecraft-action-to-screen latency.
- Both preview and OBS browser pages displayed all 1,441 frames with no JavaScript
  or decode errors. There were no dropped queued frames or black decoded images.
- Whole-card active memory averaged 21,629 MiB; average GPU utilization was 54.0%.
  Warmup peaked at 28,939 MiB; simultaneous image preparation and the idle warmed
  video model peaked at 31,685 MiB. These phases must not be conflated.
- All 360 observed input camera samples had the same pose, and 8 saved proxy
  samples had one JPEG hash. This run validates level-camera admission and actual
  presentation, **not fast turns or walking**. Generated materials, lighting and
  later bright particles drifted despite the unchanged input. Long-running visual
  stability failed acceptance; transport success does not resolve that failure.

Four camera/reference tests and three existing recording tests passed, including
downward-versus-level rejection, wrapped yaw, stale/moved views and file tampering.
Original game host, account, goals, memories, ledger and TTS were not reloaded.
No platform broadcast or npm publication was performed. These scripts remain a
repository-only experiment; image/model weights and private captures are external.
