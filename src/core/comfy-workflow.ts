import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  GenerationInput,
  GenerationPort,
  GenerationResult,
  MediaProviderConfig,
} from "../contracts.ts";
import { boundedBody } from "./http.ts";
import { validateArtImage } from "./media.ts";
import { CreationProviderError } from "./errors.ts";

/** Trusted operator-authored graph, never a graph or file path supplied by a model. */
export type ComfyVideoGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export interface ComfyVideoWorkflowV1 {
  schema: "agent-aigc-comfy-video/v1";
  graph: ComfyVideoGraph;
  outputNode: string;
  fps: number;
  requiredReferences: number;
  durationSec: { default: number; min: number; max: number };
}
/** Operator-owned variants. A request selects only a declared profile and reference count. */
export interface ComfyVideoWorkflowV2 {
  schema: "agent-aigc-comfy-video/v2";
  fps: number;
  frameAlignment: { multiple: number; offset: number };
  durationSec: { default: number; min: number; max: number };
  defaultProfile: string;
  variants: Array<{ profile: string; requiredReferences: number; graph: ComfyVideoGraph; outputNode: string }>;
}
export type ComfyVideoWorkflow = ComfyVideoWorkflowV1 | ComfyVideoWorkflowV2;
export function alignComfyVideoFrames(duration: number, fps: number, grid = { multiple: 8, offset: 1 }): number {
  return Math.max(0, Math.ceil((duration * fps - grid.offset) / grid.multiple)) * grid.multiple + grid.offset;
}
export function loadComfyVideoWorkflow(
  file: string | undefined,
): ComfyVideoWorkflow {
  if (!file) throw Error("An explicit local video workflow file is required");
  const bytes = readFileSync(file);
  if (bytes.length > 2 * 1024 * 1024)
    throw Error("Video workflow is too large");
  const cfg = JSON.parse(bytes.toString("utf8")) as ComfyVideoWorkflow;
  if (
    !["agent-aigc-comfy-video/v1", "agent-aigc-comfy-video/v2"].includes(cfg.schema) ||
    !Number.isInteger(cfg.fps) ||
    cfg.fps < 1 ||
    cfg.fps > 60 ||
    !cfg.durationSec ||
    ![cfg.durationSec.min, cfg.durationSec.default, cfg.durationSec.max].every(
      Number.isFinite,
    ) ||
    cfg.durationSec.min <= 0 ||
    cfg.durationSec.min > cfg.durationSec.default ||
    cfg.durationSec.default > cfg.durationSec.max
  )
    throw Error("Invalid explicit video workflow contract");
  if (cfg.schema === "agent-aigc-comfy-video/v2" && (
    !cfg.frameAlignment || !Number.isInteger(cfg.frameAlignment.multiple) ||
    cfg.frameAlignment.multiple < 1 || cfg.frameAlignment.multiple > 1024 ||
    !Number.isInteger(cfg.frameAlignment.offset) || cfg.frameAlignment.offset < 0 ||
    cfg.frameAlignment.offset >= cfg.frameAlignment.multiple ||
    typeof cfg.defaultProfile !== 'string' || !/^[\w-]{1,64}$/.test(cfg.defaultProfile) || !Array.isArray(cfg.variants) ||
    cfg.variants.length < 1 || cfg.variants.length > 128 ||
    !cfg.variants.some(v => v?.profile === cfg.defaultProfile)
  )) throw Error("Invalid explicit video workflow variants or frame alignment");
  const variants = cfg.schema === "agent-aigc-comfy-video/v1" ? [cfg] : cfg.variants;
  const seen = new Set<string>();
  for (const variant of variants) {
    if (!variant || !variant.graph || typeof variant.graph !== "object" || Array.isArray(variant.graph) ||
      !Object.hasOwn(variant.graph, variant.outputNode) || !Number.isInteger(variant.requiredReferences) ||
      variant.requiredReferences < 0 || variant.requiredReferences > 14)
      throw Error("Invalid explicit video workflow contract");
    if (cfg.schema === "agent-aigc-comfy-video/v2") {
      const profile = (variant as ComfyVideoWorkflowV2['variants'][number]).profile;
      const key = profile + ":" + variant.requiredReferences;
      if (typeof profile !== 'string' || !/^[\w-]{1,64}$/.test(profile) || seen.has(key)) throw Error("Invalid or duplicate video workflow variant");
      seen.add(key);
    }
    for (const [key, node] of Object.entries(variant.graph))
    if (
      !/^[\w-]{1,160}$/.test(key) ||
      !node ||
      typeof node.class_type !== "string" ||
      !node.class_type ||
      !node.inputs ||
      typeof node.inputs !== "object" ||
      Array.isArray(node.inputs)
    )
      throw Error("Invalid video workflow node");
  }
  return cfg;
}
export function bindComfyVideoGraph(
  workflow: { graph: ComfyVideoGraph },
  values: Record<string, unknown>,
) {
  const bind = (value: unknown): unknown => {
    if (typeof value === "string" && /^\{\{[^{}]+\}\}$/.test(value)) {
      const key = value.slice(2, -2);
      if (!Object.hasOwn(values, key))
        throw Error("Unbound video workflow input: " + key);
      return structuredClone(values[key]);
    }
    if (Array.isArray(value)) return value.map(bind);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, bind(v)]),
      );
    return value;
  };
  return bind(workflow.graph);
}
export function createComfyVideoPort(
  config: MediaProviderConfig,
  options: {
    fetch?: typeof fetch;
    env?: Record<string, string | undefined>;
  } = {},
): GenerationPort {
  config = structuredClone(config);
  const workflow = loadComfyVideoWorkflow(config.workflowFile),
    endpoint = new URL(config.endpoint);
  const effectiveWorkflowSha256 = createHash("sha256")
    .update(JSON.stringify(workflow))
    .digest("hex");
  const variants = workflow.schema === "agent-aigc-comfy-video/v1" ? [workflow] : workflow.variants;
  const referenceCounts = [...new Set(variants.map(v => v.requiredReferences))].sort((a, b) => a - b);
  const maxReferences = Math.max(...referenceCounts);
  const parameterKeys = ["durationSec", "seed", ...(workflow.schema === "agent-aigc-comfy-video/v2" ? ["profile"] : [])];
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
      ))
  )
    throw Error(
      "Video ComfyUI requires an explicit HTTPS or loopback HTTP endpoint",
    );
  if (
    !config.model ||
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 1000 ||
    config.timeoutMs > 3600000 ||
    !Number.isInteger(config.pollMs) ||
    config.pollMs < 50 ||
    config.pollMs > 60000 ||
    !Number.isInteger(config.maxReferences) || config.maxReferences < maxReferences || config.maxReferences > 14
  )
    throw Error("Invalid video provider configuration");
  const base = endpoint.href.replace(/\/$/, "") + "/",
    http = options.fetch ?? fetch;
  const run = async (
    input: GenerationInput,
    parent: AbortSignal,
    originalId?: string,
  ): Promise<GenerationResult> => {
    const duration = Number(
        input.parameters.durationSec ?? workflow.durationSec.default,
      ),
      seed = input.parameters.seed ?? 7;
    const profile = workflow.schema === "agent-aigc-comfy-video/v2"
      ? input.parameters.profile ?? workflow.defaultProfile : undefined;
    const variant = variants.find(v => v.requiredReferences === input.references.length &&
      (workflow.schema === "agent-aigc-comfy-video/v1" || (v as ComfyVideoWorkflowV2['variants'][number]).profile === profile));
    if (
      input.kind !== "video" ||
      !input.prompt.trim() ||
      input.prompt.length > 16000 ||
      !variant ||
      Object.keys(input.parameters).some(
        (k) => !parameterKeys.includes(k),
      ) ||
      !Number.isFinite(duration) ||
      duration < workflow.durationSec.min ||
      duration > workflow.durationSec.max ||
      !Number.isSafeInteger(seed) ||
      Number(seed) < 0 ||
      Number(seed) > 2147483647
    )
      throw Error(
        "Video workflow requires its declared image references, durationSec range and integer seed",
      );
    input.references.forEach((image) => validateArtImage(image));
    const frameAlignment = workflow.schema === "agent-aigc-comfy-video/v1"
      ? { multiple: 8, offset: 1 } : workflow.frameAlignment;
    const values: Record<string, unknown> = {
      prompt: input.prompt,
      seed,
      durationSec: duration,
      fps: workflow.fps,
      frames: alignComfyVideoFrames(duration, workflow.fps, frameAlignment),
      outputPrefix: "agent_aigc_video/" + randomUUID(),
    };
    input.references.forEach(
      (_, i) => (values["image" + i] = "preflight-placeholder.png"),
    );
    bindComfyVideoGraph(variant!, values); // Unknown placeholders fail before uploads/submission.
    const key = config.apiKeyEnv
      ? (options.env ?? process.env)[config.apiKeyEnv]
      : undefined;
    if (
      config.apiKeyEnv &&
      (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv) ||
        !key ||
        /[\r\n]/.test(key))
    )
      throw Error("Video key environment variable is absent or invalid");
    const auth: Record<string, string> = key
      ? { Authorization: "Bearer " + key }
      : {};
    const signal = AbortSignal.any([
      parent,
      AbortSignal.timeout(config.timeoutMs),
    ]);
    let promptId: string | undefined = originalId;
    if (originalId && !/^[\w-]{1,160}$/.test(originalId))
      throw Error("Invalid original video task id");
    const request = async (route: string, init: RequestInit = {}) => {
      let response: Response;
      try {
        response = await http(new URL(route, base), {
          ...init,
          headers: { ...auth, ...init.headers },
          signal,
          redirect: "error",
        });
      } catch {
        throw new CreationProviderError(
          "Video transport outcome unknown; reconcile the original request before resubmitting",
          promptId,
        );
      }
      if (!response.ok) {
        const evidence: Record<string, unknown> = {
          phase: init.method === "POST" ? "submission" : "query",
          httpStatus: response.status,
        };
        if (init.method === "POST" && [400, 422].includes(response.status)) {
          try {
            const error = JSON.parse(
              Buffer.from(
                await boundedBody(response, 64 * 1024, signal),
              ).toString("utf8"),
            );
            evidence.nodeErrors = Object.entries(error.node_errors ?? {})
              .slice(0, 8)
              .map(([node, value]) => ({
                node,
                messages: ((value as any)?.errors ?? [])
                  .slice(0, 4)
                  .map((row: any) =>
                    String(
                      row.message ?? row.type ?? "Invalid node input",
                    ).slice(0, 240),
                  ),
              }));
            if (typeof error.error?.type === "string")
              evidence.providerError = error.error.type.slice(0, 160);
          } catch {
            evidence.responseDetailsUnavailable = true;
          }
        } else await response.body?.cancel();
        throw new CreationProviderError(
          "Video ComfyUI HTTP " +
            response.status +
            "; inspect nodeErrors before a corrected submission",
          promptId,
          init.method === "POST" &&
            [400, 401, 403, 404, 413, 422, 429].includes(response.status)
            ? "failed"
            : undefined,
          evidence,
        );
      }
      return response;
    };
    const json = async (route: string, init: RequestInit = {}) =>
      JSON.parse(
        Buffer.from(
          await boundedBody(
            await request(route, init),
            2 * 1024 * 1024,
            signal,
          ),
        ).toString("utf8"),
      );
    signal.throwIfAborted();
    for (let i = 0; !originalId && i < input.references.length; i++) {
      const image = input.references[i],
        form = new FormData();
      form.set(
        "image",
        new Blob([Uint8Array.from(image.bytes)], { type: image.mime }),
        "aigc-" +
          randomUUID() +
          (image.mime === "image/png"
            ? ".png"
            : image.mime === "image/jpeg"
              ? ".jpg"
              : ".webp"),
      );
      form.set("type", "input");
      form.set("overwrite", "false");
      const uploaded = await json("upload/image", {
        method: "POST",
        body: form,
      });
      if (
        typeof uploaded.name !== "string" ||
        /[\\/]|\.\./.test(uploaded.name) ||
        (uploaded.subfolder &&
          (!/^[\w/-]+$/.test(uploaded.subfolder) ||
            uploaded.subfolder.includes("..")))
      )
        throw Error("Invalid video reference upload receipt");
      values["image" + i] =
        (uploaded.subfolder ? uploaded.subfolder + "/" : "") + uploaded.name;
    }
    if (!originalId) {
      const accepted = await json("prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: bindComfyVideoGraph(variant!, values),
          client_id: input.requestId,
        }),
      });
      if (
        typeof accepted.prompt_id !== "string" ||
        !/^[\w-]{1,160}$/.test(accepted.prompt_id)
      )
        throw new CreationProviderError(
          "Video acceptance id unknown; do not resubmit",
        );
      promptId = accepted.prompt_id;
      input.onAccepted?.(promptId!);
    }
    try {
      for (;;) {
        const history = (await json("history/" + promptId))[promptId!];
        if (history?.status?.status_str === "error")
          throw new CreationProviderError(
            "Original video workflow failed",
            promptId,
            "failed",
            { providerState: "error" },
          );
        if (
          history?.status?.completed === true &&
          history.status.status_str === "success"
        ) {
          const output = history.outputs?.[variant!.outputNode];
          const files = output?.images ?? output?.videos;
          if (!Array.isArray(files) || files.length !== 1)
            throw new CreationProviderError(
              "Video did not finish with exactly one saved output",
              promptId,
            );
          const file = files[0];
          if (
            typeof file.filename !== "string" ||
            !file.filename.endsWith(".mp4") ||
            /[\\/]|\.\./.test(file.filename) ||
            file.type !== "output" ||
            typeof file.subfolder !== "string" ||
            !/^[\w/-]*$/.test(file.subfolder) ||
            file.subfolder.includes("..")
          )
            throw new CreationProviderError(
              "Invalid saved video receipt",
              promptId,
            );
          const bytes = await boundedBody(
            await request(
              "view?" +
                new URLSearchParams({
                  filename: file.filename,
                  subfolder: file.subfolder,
                  type: "output",
                }),
            ),
            256 * 1024 * 1024,
            signal,
          );
          return {
            artifacts: [{ bytes, mime: "video/mp4" }],
            model: config.model,
            providerRequestId: promptId,
            evidence: {
              workflowSchema: workflow.schema,
              effectiveWorkflowSha256,
              fps: workflow.fps,
              requestedDurationSec: duration,
              requestedFrames: values.frames,
              frameAlignment,
              effectiveDurationSec: Number(values.frames) / workflow.fps,
              ...(profile ? { profile } : {}),
              referenceCount: input.references.length,
              seed,
              decoded: false,
              qualityVerified: false,
            },
          };
        }
        await delay(config.pollMs, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted)
        throw new CreationProviderError(
          "Local video wait stopped; original GPU task may continue",
          promptId,
        );
      throw error;
    }
  };
  return {
    capabilities: {
      kind: "video",
      generate: true,
      edit: maxReferences > 0,
      maxReferences,
      instanceId: createHash("sha256")
        .update(
          JSON.stringify([
            endpoint.href,
            config.model,
            effectiveWorkflowSha256,
          ]),
        )
        .digest("hex"),
      reconcile: true,
      ...(referenceCounts.length === 1 ? { requiredReferences: referenceCounts[0] } : {}),
      referenceCounts,
      ...(workflow.schema === "agent-aigc-comfy-video/v2" ? {
        profiles: [...new Set(workflow.variants.map(v => v.profile))], defaultProfile: workflow.defaultProfile,
      } : {}),
      provider: config.provider,
      model: config.model,
      parameterKeys,
    },
    generate: run,
    reconcile: (id, input, signal) => run(input, signal, id),
  };
}
