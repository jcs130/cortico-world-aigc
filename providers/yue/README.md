# providers/yue：显式歌曲生成与可选音色转换服务

迁自 cortico-world-vtuber 的生成实现与离线测试，保留原协议和任务归档。World 不自动启动这些进程；独立服务地址、模型目录、权重及授权必须显式配置。`client.ts` 是旧网关的可选客户端，主 World 使用统一 GenerationPort 管理任务。TTS、口型、采用和播放继续由演出扩展负责。

离线测试：`python providers/yue/tests/music-generation-gateway-test.py`、`music-yue-test.py`、`music-voice-test.py`；部分测试需要 NumPy，但不下载模型或使用 GPU。
