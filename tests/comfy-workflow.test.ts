import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createComfyVideoPort,
  loadComfyVideoWorkflow,
} from "../src/core/comfy-workflow.ts";
import { aigcDefaults } from "../src/core/providers.ts";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aigc-video-"));
  dirs.push(dir);
  const file = join(dir, "workflow.json");
  const workflow = {
    schema: "agent-aigc-comfy-video/v1",
    fps: 24,
    requiredReferences: 0,
    durationSec: { min: 2, default: 5, max: 20 },
    outputNode: "save",
    graph: {
      sample: {
        class_type: "Sampler",
        inputs: { text: "{{prompt}}", frames: "{{frames}}", seed: "{{seed}}" },
      },
      save: {
        class_type: "SaveVideo",
        inputs: { video: ["sample", 0], filename_prefix: "{{outputPrefix}}" },
      },
    },
    ...extra,
  };
  writeFileSync(file, JSON.stringify(workflow));
  return {
    ...aigcDefaults().video,
    provider: "comfyui-workflow" as const,
    endpoint: "http://127.0.0.1:8188/",
    model: "explicit-video",
    workflowFile: file,
    pollMs: 50,
    maxReferences: 1,
  };
}
const input = {
  kind: "video" as const,
  prompt: "{{image0}} is ordinary untrusted prompt text",
  references: [],
  parameters: { durationSec: 5, seed: 19 },
  requestId: "owned-request",
};
it("binds typed values once, retains the original prompt id and downloads only its saved output", async () => {
  const http = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ prompt_id: "original" }))
    .mockResolvedValueOnce(
      Response.json({
        original: {
          status: { completed: true, status_str: "success" },
          outputs: {
            save: {
              images: [
                { filename: "owned.mp4", type: "output", subfolder: "video" },
              ],
            },
          },
        },
      }),
    )
    .mockResolvedValueOnce(new Response(Buffer.from("0000ftypisom")));
  const accepted = vi.fn(),
    port = createComfyVideoPort(fixture(), { fetch: http });
  expect(http).not.toHaveBeenCalled();
  const result = await port.generate(
    { ...input, onAccepted: accepted },
    new AbortController().signal,
  );
  expect(accepted).toHaveBeenCalledWith("original");
  expect(result.providerRequestId).toBe("original");
  const graph = JSON.parse(http.mock.calls[0][1].body).prompt;
  expect(graph.sample.inputs).toMatchObject({
    text: input.prompt,
    frames: 121,
    seed: 19,
  });
  expect(String(http.mock.calls[2][0])).toBe(
    "http://127.0.0.1:8188/view?filename=owned.mp4&subfolder=video&type=output",
  );
  expect(result.evidence).toMatchObject({
    requestedFrames: 121,
    decoded: false,
    qualityVerified: false,
  });
});
it("rejects missing references, unsupported parameters and unknown placeholders before any network call", async () => {
  const http = vi.fn(),
    signal = new AbortController().signal;
  await expect(
    createComfyVideoPort(fixture({ requiredReferences: 1 }), {
      fetch: http,
    }).generate(input, signal),
  ).rejects.toThrow("references");
  await expect(
    createComfyVideoPort(fixture(), { fetch: http }).generate(
      { ...input, parameters: { fps: 1000 } },
      signal,
    ),
  ).rejects.toThrow("durationSec");
  const cfg = fixture({
    graph: {
      save: {
        class_type: "SaveVideo",
        inputs: { video: "{{arbitrary_path}}" },
      },
    },
  });
  await expect(
    createComfyVideoPort(cfg, { fetch: http }).generate(input, signal),
  ).rejects.toThrow("Unbound");
  expect(http).not.toHaveBeenCalled();
});
it("keeps unknown submission distinct from confirmed execution failure without retrying", async () => {
  const http = vi.fn().mockRejectedValue(new Error("lost response"));
  await expect(
    createComfyVideoPort(fixture(), { fetch: http }).generate(
      input,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    providerRequestId: undefined,
    terminalStatus: undefined,
  });
  expect(http).toHaveBeenCalledOnce();
  const failed = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ prompt_id: "original" }))
    .mockResolvedValueOnce(
      Response.json({ original: { status: { status_str: "error" } } }),
    );
  await expect(
    createComfyVideoPort(fixture(), { fetch: failed }).generate(
      input,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    providerRequestId: "original",
    terminalStatus: "failed",
  });
  expect(failed).toHaveBeenCalledTimes(2);
});
it("does not follow an output path outside the original output directory", async () => {
  const http = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ prompt_id: "original" }))
    .mockResolvedValueOnce(
      Response.json({
        original: {
          status: { completed: true, status_str: "success" },
          outputs: {
            save: {
              images: [
                {
                  filename: "owned.mp4",
                  type: "output",
                  subfolder: "../private",
                },
              ],
            },
          },
        },
      }),
    );
  await expect(
    createComfyVideoPort(fixture(), { fetch: http }).generate(
      input,
      new AbortController().signal,
    ),
  ).rejects.toThrow("receipt");
  expect(http).toHaveBeenCalledTimes(2);
});
it("rejects invalid workflow shape and remote unprotected endpoints", () => {
  expect(() =>
    loadComfyVideoWorkflow(fixture({ fps: 0 }).workflowFile),
  ).toThrow("contract");
  expect(() =>
    createComfyVideoPort({ ...fixture(), endpoint: "http://remote.invalid" }),
  ).toThrow("loopback");
});
it("reads an original video task without uploads, submission or extra generation", async () => {
  const http = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        original: {
          status: { completed: true, status_str: "success" },
          outputs: {
            save: {
              images: [
                { filename: "owned.mp4", type: "output", subfolder: "video" },
              ],
            },
          },
        },
      }),
    )
    .mockResolvedValueOnce(new Response(Buffer.from("0000ftypisom")));
  const port = createComfyVideoPort(fixture(), { fetch: http });
  expect(
    (await port.reconcile!("original", input, new AbortController().signal))
      .providerRequestId,
  ).toBe("original");
  expect(http.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    "/history/original",
    "/view",
  ]);
  expect(http.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
