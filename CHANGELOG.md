# Changelog

## 0.1.0-dev.20261020.2

- Add read-only aigc_query; retain existing query actions for source compatibility.
- Send metadata in terminal events, duplicate acknowledgements and job indexes; load media only on explicit reads.
- Preserve confirmed provider failure/cancellation, capture provider model/configuration and reject unsupported parameters.
- Remove provider import cycles through shared media/transport helpers and require explicit context budgets.

## 0.1.0-dev.20261020.1

- Extract image generation from the Minecraft capture core into an independent creation World.
- Share explicit reference roles, archives, deduplication and cancellable jobs across image/video/music.
- Add native Wan2.7/FAL music and documented generic/local YuE gateway adapters.
- Provide Persona-owned appearance references and an adapted imagegen workflow guide.
- Preserve original capture archives and explicit legacy migration.
