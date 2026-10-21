# 显式模型接入

## 图片

worlds.aigc.image 使用 provider=none / comfyui-flux3 / bailian / volcengine。
endpoint 是完整原生 API 地址；model 必须由操作者确定；apiKeyEnv 保存密钥的名称。Cortico 通过 ctx.secret 读取该名称，SDK/MCP 从显式 env 读取。下载域名 resultHosts 填逗号分隔的主机名，例如 `media.example.com,cdn.example.com`（SDK 也兼容旧数组）。原始参考与角色元数据一起保存，实际发送的 effectivePrompt 在归档中可查。

FLUX 3 需填 flux3.unet / clip / vae、steps=16 及 16 对齐的 width/height，节点与模型须已安装。配置不会下载权重或改动 ComfyUI，也不会扫描其他地址。无图像模型时，游戏仍可普通截图；创作室会明确报告该生成能力不可用。

## 视频

本地 ComfyUI 使用 `provider=comfyui-workflow`，显式填写 endpoint、model、workflowFile、maxReferences、timeoutMs 和 pollMs。扩展不附带或下载模型，不启动 ComfyUI。工作流格式及接入步骤见 [COMFY-VIDEO.md](COMFY-VIDEO.md)。先核对节点、精确模型名及空闲队列，再做一次生成与成片解码检查。HTTP 400/422 的有界 nodeErrors 回执可用于订正工作流。

worlds.aigc.video.provider=bailian-wan27，endpoint 填所在地域的完整 video-synthesis 地址，model 填有权限的 wan2.7-t2v 精确模型名；maxReferences=0。parameters 支持 durationSec、resolution、ratio。创建使用 X-DashScope-Async:enable，按原 task_id 查询；prompt_extend=false。超时保存已知编号并报告 unknown，不重建任务。

依据：https://help.aliyun.com/zh/model-studio/text-to-video-api-reference

## 歌曲

worlds.aigc.music.provider=fal-music，endpoint 为明确的 MiniMax Music 队列模型 URL；maxReferences=0。prompt 描述风格，parameters.lyrics 提供歌词，或 instrumental=true。固定 lyrics_optimizer=false。该路径不提供克隆／验证可米音色的承诺。

依据：https://fal.ai/models/fal-ai/minimax-music/v2.6/api

原 YuE 网关使用 provider=yue-gateway，endpoint 为明确网关基址。parameters 提供 title、style、durationSec(30..120)、lyrics 或 instrumental=true。按原网关 jobId 查询。配置 libraryDirectory 时，只允许从该目录的 catalog.json 中按 trackId 取已有成品；不接收任意服务器路径，也不从目录扫描猜模型。

若网关已生成音频但歌词检查未通过，可由操作者显式配置 `artifactDirectory`（网关自己的 artifacts 目录）。按原编号恢复查询时可取回原 `song.wav` 供试听，仍带 `upstreamState=failed`、`retainedCandidate=true`、`lyricsVerified=false`、`contentApproved=false`，不得当作已批准歌曲或已验证歌手音色。必须由演出端显式导入、试听及采纳。原失败记录保留。

可选 YuE 服务的 review 支持 `apiKeyEnv`；与内联 apiKey 二选一，缺少环境变量时明确失败。模型、端点、凭据均由本地部署提供，不在公开包中指定。

## 通用本地／云端网关

provider=gateway 是本项目的 agent-aigc-gateway/v1 协议，不宣称任意云厂商兼容。

POST <endpoint>/jobs:

~~~json
{ "schema": "agent-aigc-gateway/v1", "kind": "video", "model": "operator-selected", "request_id": "stable-job-id", "prompt": "...", "parameters": {}, "references": [] }
~~~

返回 job_id 与 status=accepted/running/succeeded；GET <endpoint>/jobs/<id> 对账。完成时 artifacts=[{url,mime}]；只下载 resultHosts 明确列出的地址。references 使用 role、mime、sha256 和网络传输层 base64，模型上下文不放 base64。

所有适配器均不自动重投提交。取消关闭本机 HTTP；没有供应商取消回执时远端状态仍未知。

## 原任务恢复

`aigc_create({action:'reconcile',id:'原 Studio 任务号'})` 仅在供应商支持、已记录供应商任务号与实例身份时可用。恢复使用归档原文、参数和参考，校验相同供应商端点／模型／工作流身份，保留原终态、原因与证据，再查询原任务；不发新的生成 POST 或重新上传参考。旧版本没有记录实例身份的任务不自动补签，需操作者用 SDK 对原供应商编号核验。云适配器未声明 reconcile 时，返回不可用，不猜测替代接口。
