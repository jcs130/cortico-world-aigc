# providers/edenlive、examples/minecraft-edenlive：可选视频服务与显式游戏组合

# EdenLive realtime experiment

[First-person camera admission and the latest trial](live-camera-pair.md) describes
the receipt-bound post-warmup reference, mandatory live camera limits and remaining
long-run visual drift. Legacy live JSON profiles need the new reference fields.

This repository-only adapter tests an explicitly deployed LightX2V EdenLive AR
worker against a read-only voxel renderer. It is not installed by default and is
not included in the current npm package. It does not modify the old VTuber World,
the game controller, the Agent's memories or the Minecraft server.

## Boundaries

- Input: a pinned public `agent-mc-world/learning` `ViewerGameplayObserver`, a
  versioned scene and the original 1.21.1 block-model/atlas assets from an explicit
  `mc-visual-console` renderer checkout. No second Minecraft login or keyboard input.
- The image editor prepares a matching first-frame anchor separately. This adapter
  does not silently run an image editor or invent a matching anchor.
- Inference: external LightX2V, converted EdenLive weights, INT8 ConvRot DiT and
  proxy encoder, FP8 T5, LightTAE decoder. The optional T5 CPU offload reduces
  resident memory. Upstream source, environments and weights remain outside the
  plugin. Native FlashDreams BF16 measurements are a separate backend.
- Output: decoded chunks are transferred incrementally, with no full-session GPU
  video accumulation. One bounded presentation queue serves preview and OBS
  viewers; more viewers do not start additional model sessions. The adapter is
  silent and leaves the existing TTS/music output alone.
- A finite session must be explicitly launched. Input loss fails the run; neither
  the relay nor worker restarts a generation session automatically. Terminal
  sessions reject late frames.

`sourceMode: "voxel-scene-demo"` is an explicit alternative when testing without a
live game connection. It animates only a virtual camera over the supplied frozen
scene. The web UI labels that mode, and its measurements do not establish live
gameplay following, actual player actions or current server facts.

## Run

Prepare a private relay JSON with paths to `dependenciesPackage` (Puppeteer, ws and
Three.js), `corePackage`, `rendererSource`, `assetPack`, `threeModule`, the pinned
`viewer`, `region`, `firstSceneFile`, `firstProxyFile`, render options, `recordDir`,
`port`, explicit bind `host` and a fresh private `publishKey`.

```sh
node examples/minecraft-edenlive/live-voxel-relay.mjs /private/relay.local.json
```

Inside the existing Linux CUDA environment, with `PYTHONPATH` pointing to the
external LightX2V source, launch `realtime_worker.py /private/worker.local.json`.
That file explicitly configures `relayUrl`, the same private publisher key,
`modelRoot`, official `profile`, temporary `runtimeProfile`, matched `anchor`,
`size`, bounded `numFrames`, `prompt` and `chunkLog`. Optional `experiments` runs
several bounded resolutions against the same loaded model for comparison.

The relay offers `/` for side-by-side comparison, `/obs` for the output canvas and
`/health` for source freshness, actual delivered frame count, queue and worker
state. Frames and timestamps may be retained locally when recording is enabled.
No streaming-platform broadcast is started.

## Interpreting results

Model chunk FPS, worker wall time, relay delivery FPS and actual browser canvas
presentations are separate measurements. An encoded 24 FPS file does not establish
24 unique generated frames per wall-clock second. The source-to-browser timestamp
starts at the proxy frame, not at an independently measured Minecraft action.

The current latest-input policy can skip old inputs and bound/drop queued output
under overload. Report drop counts and geometry/identity drift together with FPS.
Scene geometry, character scale, orientation, limbs and clothing are not guaranteed
by valid transport. A neutral self marker has no observed skeletal animation;
generated movement is not evidence of the player's actual limb pose.

## Sources

- [EdenLive](https://github.com/VAST-AI-Research/EdenLive), upstream Apache-2.0 code
  and separately licensed model assets.
- [LightX2V EdenLive guide](https://github.com/ModelTC/LightX2V/blob/main/scripts/edenlive/README.md).
- `realtime_worker.py` follows the cache/denoising order in ModelTC/LightX2V's
  Apache-2.0 `edenlive_runner.py`; this adapter does not copy model weights or alter
  that installed checkout.

No throughput or visual acceptance is implied by merely installing these scripts.

## First-frame provenance

The first proxy chunk is a prepared reference matching the anchor, not a new live
camera capture. It retains the original scene `sampledAt`, reports
`sourceMode: "anchor-reference"` and `sourceFresh: false`, and is labeled separately
in the preview. Exclude it from live latency measurements. Later chunks carry
their actual proxy capture timestamps and input mode. Preparing an anchor before
a long model warmup does not establish that it still matches the current player
position. Production use needs a synchronized anchor refresh/scene transition
policy and an unobstructed camera; this prototype does not implement those yet.

## Local test, 2026-10-20

See [validation-20261020.md](validation-20261020.md). A bounded 832×480 live-input
test completed with 957 presented frames and no black frames, but failed visual
acceptance due to camera occlusion, stale anchor alignment and generated drift.
Preview and OBS browser pages shared the same inference session. The platform
broadcast and existing Cormy World were not changed. The reference-provenance
patch above passed offline relay tests after the GPU trial; it has not been
measured in another GPU run.

## Saved voxel recordings

[offline-recording.md](offline-recording.md) documents the actual RGB/DINO model
interface, the new finite `record-voxel.mjs` and disk-only `replay-voxel.mjs`
commands, file integrity and pose provenance. A follow-up official offline CLI
run produced 145 valid frames from a saved courtyard and its matched FLUX 3
anchor. That example is explicitly a frozen-scene virtual camera, not live
action synchronization. The original live trial's failed visual acceptance is
retained as separate evidence.

The live relay now uses the shared renderer's public pose/frame APIs and checks
its Three.js revision/capabilities. It serves the original renderer source
unchanged. These scripts remain excluded from the current npm package.

## Source ownership

The neutral recording, camera admission and checksum helpers are now maintained by `agent-mc-world/capture`. This directory owns inference only; `examples/minecraft-edenlive` explicitly composes the public capture SDK, renderer and this provider. Importing or mounting the AIGC World does not launch these scripts, install weights or open game connections. Three.js, renderer source, viewer address and worker endpoints are explicit.
