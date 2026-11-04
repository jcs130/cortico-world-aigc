# providers/yue：显式歌曲生成与可选音色转换服务

迁自 cortico-world-vtuber 的生成实现与离线测试，保留原协议和任务归档。World 不自动启动这些进程；独立服务地址、模型目录、权重及授权必须显式配置。`client.ts` 是旧网关的可选客户端，主 World 使用统一 GenerationPort 管理任务。TTS、口型、采用和播放继续由演出扩展负责。

离线测试：`python providers/yue/tests/music-generation-gateway-test.py`、`music-yue-test.py`、`music-voice-test.py`；部分测试需要 NumPy，但不下载模型或使用 GPU。

YuE2 将 `durationSec` 传为 `max_duration`：它是生成上限，不保证输出精确等长。自然结束的较短歌曲仍须通过实际音频、识别置信度、完整歌词对齐和内容审核；不补静音凑时长。使用其他精确时长引擎时保留目标时长检查。

校验失败保留原始音频及明确的 `failureCode`。例如 `asr_word_confidence_low` 表示识别不足以确认，不等于歌词内容遭拒或全部唱歌能力不可用。修复校验器后使用原任务的 `/jobs/{id}/revalidate`，无需再次生成。
