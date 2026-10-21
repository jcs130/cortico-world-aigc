# MiniMax H3 本地视频

公开 SDK `buildMiniMaxH3Workflow(options)` 生成操作者可审阅的 ComfyUI API 工作流。
该函数不下载模型、不启动服务、不探测端口、不调用网络，与游戏和 Cortico 无运行时依赖。
默认供应商仍为 none。角色设定图由宿主通过引用传入，扩展不内置可米资料。

## 安装与生成配置

1. 准备支持原生 H3 节点的 ComfyUI（上游要求至少 0.31，先核对实际 `/object_info`）。
2. 按 `examples/minimax-h3-models.json` 准备模型。量化主模型使用 INT8 ConvRot，文本编码器使用 NVFP4/AWQ。
   必须校验权重大小和上游 SHA256；同名文件不代表完整文件。
3. 准备 **ComfyUI 格式**的 LightX2V FL2VA 8-step v1.0（544p）及 Ref2VA 4-step v0.1（544p）LoRA。
   不使用 Diffusers LoRA 替代；不把 768p 新版 LoRA 与本配方的 12/3 shift 混用。
4. 复制并修改示例中的模型文件名，构建扩展后运行：

```
node scripts/create-h3-workflow.mjs operator-models.json workflow.json
```

5. 明确启动一个只监听本机的 ComfyUI；通过 extra_model_paths 配置模型目录，禁用非必要自定义节点和外部联网。
6. 配置 video 为 `comfyui-workflow`，显式填写 endpoint、workflowFile、model 和 maxReferences。
   示例支持 0–3 张图片，可通过生成配置扩展到 9 张，输入不能超过配置数。

### 已运行宿主的热接入

已有 World 若尚不支持 v2，可用独立 SDK 网关接入，不重载游戏或语音宿主：

```
node providers/comfyui/gateway.mjs operator-gateway.json
```

配置格式为 `{port, directory, aigc}`：port 为操作者明确选择的回环端口，directory 为任务归档目录，
aigc 使用 `aigcDefaults()` 的配置形状，video 指向上面的 ComfyUI v2 工作流。
宿主使用 `provider: gateway`、该网关 endpoint、相同 model、明确的 maxReferences，
并把 `127.0.0.1` 加入 resultHosts。该程序只监听 127.0.0.1，无默认开机触发或自动重启。

`GET /health` 提供 SDK 的完整能力与档位；`POST /jobs` 和 `GET /jobs/:id` 遵循
`agent-aigc-gateway/v1`。`POST /jobs/:id/cancel` 只取消本地等待；
`POST /jobs/:id/reconcile` 是显式的原任务恢复，绝不生成第二次。
受理后任务独立于单次 HTTP 生命周期；原始输入、参考图、供应商任务号与成品持久保存。
相同 request_id 和相同输入返回原任务；进程重启后未核实的任务为 unknown，不自动重投。
HTTP 网关不把参考图 URL 当作可抓取地址，引用只接受带 SHA256 的内联媒体；跨 Origin 访问默认拒绝。

## 工作模式

| 请求 | 执行 |
|---|---|
| 0 张参考 | FL2VA 文生视频 |
| 1–N 张参考 | Ref2VA；图片是人物、场景、风格参考，不强制作为首帧 |
| `profile: turbo`（默认） | FL2VA 8 步、Ref2VA 4 步，对应 LoRA 强度 1，Euler/simple，video/audio shift 12/3 |
| `profile: quality` | 20 步完整模型，不加载加速 LoRA，用于画质对照 |

保留原生 32kHz 音频，经 Audio VAE 解码与视频一起保存。`LTXVSeparateAVLatent` 是 ComfyUI 通用音画嵌套张量拆分节点，
不加载 LTX 模型。分辨率需为 32 的倍数；默认 960×544，24FPS，4–14 秒，帧数向上对齐 17n+5。
画面质量、角色身份、歌声身份与文件格式校验分别验收；H3 原生语音不等于 Drama3 固定音色。

## 提示词与人物参考

在原提示词中使用 `<Picture 1>`、`<Picture 2>` 与引用顺序对应。明确哪张是场景、哪张是人物设定；
设定图的白底和排版不能带入场景。建议写成：

```
integrated_multimodal_description: [Shot 1] A single continuous shot ...
overall_soundscape: Soft wind and natural footsteps. No dialogue.
non_diegetic_music: N/A
```

不自动加入“种田”、固定镜头俯仰、固定角色姿势或额外模型提示词循环。

## 加速选择与限制

- 配方使用原生 Comfy Kitchen INT8 attention，避免额外节点。先执行本机小样验证 CUDA 内核；
  不支持时由操作者显式选择 PyTorch attention，不悄悄换服务或下载内核。
- SageAttention 需要与 GPU 架构匹配的构建，5090 为 SM120；能够 import 不代表内核可运行。
- Windows/WDDM 的动态加载可能发生原生访问冲突，无法用 Python 异常捕获。
  本机 H3 独立服务在 `comfy_aimdo.host_buffer.read_file_to_device` 复现后，显式采用
  `--disable-dynamic-vram --disable-async-offload --disable-pinned-memory`。
  此模式可能增加 CPU 卸载；只对 H3 服务调整，不能全局修改其他推理服务。
  参见 [上游 H3/WDDM 报告](https://github.com/Comfy-Org/ComfyUI/issues/15337)。
- 蒸馏 LoRA 是有画质变化的少步数路径，不能把 20→4 步写成无损提速。
- FirstBlockCache、Spectrum、稀疏 attention、CAB 和 NVFP4 fused MLP 是可选研究项，未加入默认图；
  需逐一同输入同 seed 对照，不能叠加后借用别人报告的倍率。
- 不因生成任务停止语音或游戏。若 GPU 同时常驻大语音模型，需要分时或更多 CPU 卸载；
  记录当时的常驻显存、空闲显存与冷/热加载时间，再报告速度。
- 取消等待不会发送 ComfyUI 全局 interrupt。保留原 prompt_id 对账，不能重投未知任务。

## 来源与许可

- [MiniMax H3 原模型](https://huggingface.co/MiniMaxAI/MiniMax-H3)
- [ComfyUI 原生 H3](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py)
- [LightX2V Turbo 配方](https://github.com/ModelTC/Minimax-H3-Turbo)
- [Turbo 权重](https://huggingface.co/lightx2v/Minimax-h3-Turbo)
- [官方收录的社区集成](https://github.com/MiniMax-AI/awesome-minimax-h3-integration)
- [社区 5090 测试记录](https://github.com/matsuo-koya/minimax-h3-notes)
- [模块化优化套件](https://github.com/ByronLeeeee/ComfyUI-MiniMax-H3-Optimization-Suite)

本包只分发自写配方，不重分发权重或第三方加速代码。模型、LoRA、ComfyUI 和各加速实现遵循各自许可证。
