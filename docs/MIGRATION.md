# 迁移边界

| 原能力 | 新归属 |
|---|---|
| mc_photo capture/read/list/status/scene、原片与体素证据 | agent-mc-world |
| 图像生成适配器、FLUX 3 图、生成任务 | cortico-world-aigc/core |
| 图片／视频／歌曲的生成、查询、取消及原始输入 | aigc_create |
| 人设、认识的人的形象和版本 | Persona Memory；appearance_lookup 是 Persona 工具 |
| 歌曲播放、字幕、口型与直播演出 | 演出 World |

旧 mc_photo create/enhance 返回 capability_moved 和新工具名称，不悄悄调用别的 World，也不把任务当成已完成。旧 read/list 与原文件继续保留。ImageGenerationPort 等旧纯类型用于源码过渡，供应商执行函数从 MC 导出迁出，SDK 需改为从 cortico-world-aigc/core 导入。

planLegacyPhotographyConfig(legacy) 仅生成配置迁移计划，把 provider 字段移到 aigc.image，把 voxel 留在 minecraft.photography，不复制密钥值、不重载服务。

migrateLegacyPhotos(sourceDirectory,destinationDirectory,apply=false) 默认预览。显式 apply 后只复制旧生成任务、成品与原始记录，原目录不变，重复迁移按源 SHA 对账，冲突拒绝覆盖。普通截图仍由 MC 管理。旧运行中、失败或缺失输出的记录导入为 unknown；保留 providerRequestId，禁止自动重投。无法找回的旧人物参考字节明确记为未恢复。

新框架采用 World API 6。现役私有 API 5 包的加载属于另一项部署步骤，不能靠改 manifest 版本冒充兼容。开发测试不会重启可米、客户端或模型服务，不改现役目标、记忆与账本。

测试顺序：独立生成核心 → SDK/MCP → 官方 Cortico 挂载与附件 → MC 截图消费 → 演出读取成品。源码、构建、打包、npm 发布、部署与实际生成分别记录。
