# 本地视频工作流

本适配器运行操作者选定的 ComfyUI API 图。它不为模型选择节点、权重或 LoRA，也不让对话模型传入任意图和文件路径。

1. 在自己的 ComfyUI 导出能正常执行的 API 工作流。确认全部模型及节点已经安装。
2. 包装为下面的协议文件；将实际提示词、种子和输入图替换成精确的占位值。占位符必须独占整个值，不做文本插值。
3. 在扩展设置选择 `comfyui-workflow`，填写已启动服务的 endpoint、工作流绝对路径、精确模型名与参考数量。默认不开启。
4. 先检查 `/object_info` 和队列，再运行短样本。任务成功后还需实际解码、检查帧数、声音和画面，不用受理或文件存在代替成片验收。

协议外壳（graph 需换成自己的完整 API 图）：

```json
{
  "schema": "agent-aigc-comfy-video/v1",
  "graph": {},
  "outputNode": "实际保存MP4节点的编号",
  "fps": 24,
  "requiredReferences": 1,
  "durationSec": {"min": 5, "default": 5, "max": 10}
}
```

| 占位值 | 类型及含义 |
|---|---|
| `{{prompt}}` | 原提示词字符串 |
| `{{seed}}` | 非负整数 |
| `{{fps}}` | 协议声明的帧率 |
| `{{frames}}` | v1 向上对齐到 8n+1；v2 使用显式 `frameAlignment`，H3 为 17n+5 |
| `{{durationSec}}` | 请求时长 |
| `{{outputPrefix}}` | 本次任务独立的输出前缀 |
| `{{image0}}`、`{{image1}}`… | 对应已上传参考图的文件名 |

outputNode 必须实际存在，成功输出须为单个 MP4。只读取这个节点的文件，保持原 prompt_id。工作流和模型权重不随通用扩展分发，其许可证和硬件要求由操作者选定的模型决定。

视频与常驻语音、动作模型可能争用同一块 GPU。短样本完成不证明直播时能实时生成；应分别记录等待、推理、解码和播放耗时。建议先离线预生成，按原任务号查询，不为等待超时重复提交。

## v2：模型帧数与多个可信工作流

`agent-aigc-comfy-video/v2` 使用 `frameAlignment: {multiple, offset}`、`defaultProfile` 和
`variants: [{profile, requiredReferences, graph, outputNode}]` 代替 v1 的单一图。
`fps` 与 `durationSec` 保留。`parameters.profile` 只能选择操作者事先写入的档位；
图按档位与参考数唯一匹配，不让对话模型传入节点、路径、模型或加速补丁。
能力查询返回 `profiles`、`defaultProfile`、`referenceCounts`，SDK、MCP 和 World 使用相同数据。
旧 v1 文件和固定参考数契约保持兼容。

H3 的 5 秒请求实际对齐为 124 帧、约 5.167 秒，回执同时保留请求时长、对齐帧数和有效时长。
不得把帧数写成 LTX 的 121 帧；实际文件仍需解码验收。

详见 [MiniMax H3 接入与加速](MINIMAX-H3.md)。
