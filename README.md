# AIGC 创作室

独立的 Cortico World，统一制作图片、视频和歌曲。提供共享任务管理、素材引用、取消、原始输入归档与 SDK/MCP。绘画和生成核心无需 Minecraft、Cortico、演出服务或模型权重即可导入、构建和测试。

## 安装与启动

1. 在 **Cortico 0.2.4 → 扩展 → World** 输入 `cortico-world-aigc@next`，按宿主提示加载扩展。
2. 打开 **AIGC 创作室 → 配置**，选择需要的图片、视频或音乐供应商，填写实际服务地址；需要鉴权时填写已保存的凭据环境变量名。
3. 在 World 页面启用创作室，让 Agent 用 `aigc_query` 读取能力，再通过 `aigc_create` 提交任务并按原任务号跟踪结果。

这是 `next` 公测。默认所有供应商为 `none`，安装或挂载不会下载模型、扫描本机服务或启动推理进程。本地服务的工作流与模型由部署者准备，见 [供应商接入](docs/PROVIDERS.md) 与 [ComfyUI 视频](docs/COMFY-VIDEO.md)。音乐播放与人物演出由相应独立 World 接收成品。

生成任务可持续数分钟；受理回执不代表已经完成。`unknown` 先查询或协调原任务；图像构图、视频内容、歌词、歌声音色及 GPU 并发容量需要分别核验，勿把文件生成成功当作内容已获采用。

## 分工

| 组件 | 所有权 |
|---|---|
| Persona／Memory | 人格、自己与认识的人的身份、设定图、参考版本、创意选择及长期采纳 |
| Minecraft World | 普通截图、体素与镜头证据、历史游戏事实 |
| AIGC World | 图片／视频／音乐制作、供应商接入、任务与素材归档 |
| 演出与聊天 World | 成品展示、播放、字幕、口型及发送 |

World 不直接调用其他 World、Persona 工具或读取记忆目录。素材经 Core 的 log:/mem: 句柄进入本 World；输出通过 blobs 交回 Core。不同 Bot 或机器的句柄需要显式受保护的素材桥，不能当作公共 URL。

## 工具

- aigc_help：读取随包的 imagegen 创作指南。
- aigc_query：只读查询能力、任务、原文、参考和作品，不设置执行屏障。
- aigc_create：capabilities / generate / status / read / inputs / list / wait / cancel / reconcile。
- aigc.job：终态事件，默认 flush，不强行打断正在说话或操作的 Agent。

~~~json
{
  "action": "generate",
  "kind": "image",
  "request_id": "capture-42-enhance-v1",
  "prompt": "保留本次截图的村庄地标、平视镜头和人物位置，改善构图与自然材质。",
  "references": [
    { "handle": "log:从截图回执读取的句柄", "role": "scene-layout" },
    { "handle": "mem:由Persona提供的实际句柄", "role": "identity", "entityId": "self", "revision": "2", "view": "back" }
  ]
}
~~~

这些示例句柄是占位说明。generate 返回受理，不代表目标完成、播放或内容已采纳。用 aigc_query 和原 id 查询；inputs 查询原文与输入，read 显式读取成品。终态事件、重复请求和 list 返回元数据。wait 的取消只停止等待；cancel 关闭本机请求，不保证远端停止计算和计费。unknown 不自动重投。支持恢复查询的供应商可用 `{"action":"reconcile","id":"原任务号"}` 取回原任务，保留此前失败记录；它不会再次生成。停用后禁止旧实例写回或投递。

## 供应商

默认全部关闭，不扫描端口、不下载模型、不额外运行提示词模型。

| 类型 | 已实现适配 |
|---|---|
| 图片 | 明确配置的 FLUX 3 ComfyUI、阿里百炼图像接口、火山方舟图像接口 |
| 视频 | 显式配置的本地 ComfyUI 工作流、百炼 Wan2.7 文生视频、agent-aigc-gateway/v1 |
| 音乐 | fal MiniMax Music 队列、原 YuE 歌曲网关、agent-aigc-gateway/v1 |

原生文生视频与音乐端点的参考图／歌手参考上限为 0；不伪装成支持人物一致性或声音克隆。视频与歌曲下载只核对容器签名；内容、时长、歌词、人物一致性和听感仍需实际检查。接口实现通过离线夹具验收不代表这些云端模型已实际付费生成。

配置和接入说明见 docs/PROVIDERS.md；拆分与旧数据迁移见 docs/MIGRATION.md；职责与运行约束见 docs/ARCHITECTURE.md。

本地视频新增 [MiniMax H3 配方](docs/MINIMAX-H3.md)：支持文生视频、多参考图与原生音频，
LightX2V Turbo 加速档和完整步数对照档，使用 H3 自己的帧数对齐。
可通过可选回环网关接入已有宿主；权重和服务需明确准备，不随扩展安装启动。

## 独立使用

~~~ts
import { AigcStudio, createCreationPort, aigcDefaults } from 'cortico-world-aigc/core';
const config = aigcDefaults();
const studio = new AigcStudio({ directory: './aigc-jobs', provider: kind => createCreationPort(kind, config) });
studio.start(host); // host 显式提供 blob / pushEvent / log。
const result = await studio.execute({ action: 'capabilities' });
studio.stop();
~~~

MCP：agent-aigc-mcp explicit-config.json。参考素材只从配置的 assets 映射或宿主 resolver 取得。MCP 暴露异步任务查询和 aigc://artifacts 资源；stdio 将完成事件通过 notifications/message 投递版本化证据与成品资源地址，二进制由 read 或资源查询取得。嵌入式 MCP 宿主将 pushEvent 接到 deliverAigcMcpEvent。单次 RPC 不等于 Cortico 决策回合，Persona 工具由宿主装配。

## Cortico

按官方 0.2.4、World API 6 构建；defaults.enabled=false。WorldDefinition.describe 与工具／事件来自同一声明，随包提供 describe.json。Persona 的 appearance_lookup 辅助工具从 /persona 单独导入并装配进其 session，未作为 World 的记忆入口。

Cortico 仅为可选 peer。/core、/contracts、/persona、/mcp 不依赖 Cortico 运行时。
