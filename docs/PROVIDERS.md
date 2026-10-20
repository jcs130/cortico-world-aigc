# 显式模型接入

## 图片

worlds.aigc.image 使用 provider=none / comfyui-flux3 / bailian / volcengine。
endpoint 是完整原生 API 地址；model 必须由操作者确定；apiKeyEnv 保存密钥的名称。Cortico 通过 ctx.secret 读取该名称，SDK/MCP 从显式 env 读取。下载域名 resultHosts 逐项配置。原始参考与角色元数据一起保存，实际发送的 effectivePrompt 在归档中可查。

FLUX 3 需填 flux3.unet / clip / vae、steps=16 及 16 对齐的 width/height，节点与模型须已安装。配置不会下载权重或改动 ComfyUI，也不会扫描其他地址。无图像模型时，游戏仍可普通截图；创作室会明确报告该生成能力不可用。

## 视频

worlds.aigc.video.provider=bailian-wan27，endpoint 填所在地域的完整 video-synthesis 地址，model 填有权限的 wan2.7-t2v 精确模型名；maxReferences=0。parameters 支持 durationSec、resolution、ratio。创建使用 X-DashScope-Async:enable，按原 task_id 查询；prompt_extend=false。超时保存已知编号并报告 unknown，不重建任务。

依据：https://help.aliyun.com/zh/model-studio/text-to-video-api-reference

## 歌曲

worlds.aigc.music.provider=fal-music，endpoint 为明确的 MiniMax Music 队列模型 URL；maxReferences=0。prompt 描述风格，parameters.lyrics 提供歌词，或 instrumental=true。固定 lyrics_optimizer=false。该路径不提供克隆／验证可米音色的承诺。

依据：https://fal.ai/models/fal-ai/minimax-music/v2.6/api

原 YuE 网关使用 provider=yue-gateway，endpoint 为明确网关基址。parameters 提供 title、style、durationSec(30..120)、lyrics 或 instrumental=true。按原网关 jobId 查询。配置 libraryDirectory 时，只允许从该目录的 catalog.json 中按 trackId 取已有成品；不接收任意服务器路径，也不从目录扫描猜模型。

## 通用本地／云端网关

provider=gateway 是本项目的 agent-aigc-gateway/v1 协议，不宣称任意云厂商兼容。

POST <endpoint>/jobs:

~~~json
{ "schema": "agent-aigc-gateway/v1", "kind": "video", "model": "operator-selected", "request_id": "stable-job-id", "prompt": "...", "parameters": {}, "references": [] }
~~~

返回 job_id 与 status=accepted/running/succeeded；GET <endpoint>/jobs/<id> 对账。完成时 artifacts=[{url,mime}]；只下载 resultHosts 明确列出的地址。references 使用 role、mime、sha256 和网络传输层 base64，模型上下文不放 base64。

所有适配器均不自动重投提交。取消关闭本机 HTTP；没有供应商取消回执时远端状态仍未知。
