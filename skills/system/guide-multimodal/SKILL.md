---
name: guide-multimodal
description: 多模态服务指南，包括图片生成、视频生成、语音合成、音乐生成的配置与使用
trigger: 用户询问多模态、图片生成、视频生成、语音合成、TTS、文字转语音、音乐生成、generate_image、generate_video、text_to_speech、generate_music、access_file、audio_analyze、怎么让 AI 画画、怎么生成图片、怎么朗读文字、怎么生成语音
---

# 多模态服务指南

多模态服务让智控助手具备文生图、文生视频、语音合成（TTS）、文生音乐等能力，并支持直接读取本地图片/音频/视频让模型"看/听/读"。

## 核心概念：配置即工具

多模态工具是**按已配置的服务动态生成**的——只有先在系统中配置某个类型（image/video/tts/music）的可用服务，对应的工具才会注入到智控助手。未配置任何图片服务时，AI 看不到 `generate_image` 工具。

这是它和普通工具的关键区别：普通工具始终可用，多模态工具随配置涌现/消失。

## 四种服务类型

| 类型 | 动态工具 | 用途 | 必填参数 |
|------|----------|------|----------|
| `image` | `generate_image` | 文生图 | `prompt`（描述）、`size`（可选，如 `1024x1024`、`16:9`） |
| `video` | `generate_video` | 文生视频 | `prompt`（描述）、`duration`（可选，秒，默认 6） |
| `tts` | `text_to_speech` | 文字转语音 | `text`（文字）、`voice`（可选，音色） |
| `music` | `generate_music` | 文生音乐 | `prompt`（风格描述）、`lyrics`（可选，歌词）、`instrumental`（可选，纯音乐） |

### 支持的服务商（brand）

| brand | 说明 |
|-------|------|
| `openai` | OpenAI 及 OpenAI 兼容接口（DALL·E 图片、`/audio/speech` 语音等） |
| `mimo` | 小米 MiMo（语音走 Chat Completions 格式，音色如 `冰糖`、`茉莉`） |
| `minimax` | MiniMax（图片/视频/语音/音乐均有专门接口，部分为异步任务） |
| `custom` | 完全自定义（API Key 可不填，需自行保证接口兼容） |

> 同一类型下可配置多个品牌的服务。此时工具名会自动加品牌后缀避免冲突（如 `generate_image_minimax`）。

## 配置项详解

| 配置项 | 含义 | 说明 |
|--------|------|------|
| **名称** | 服务显示名 | 方便识别，如 `MiniMax 图片` |
| **服务类型** | `image`/`video`/`tts`/`music` | 决定生成哪个工具 |
| **服务商** | `openai`/`mimo`/`minimax`/`custom` | 决定请求格式 |
| **API 地址** | 服务商端点 | 如 `https://api.minimax.chat/v1` |
| **API Key** | 访问密钥 | `custom` 类型可不填 |
| **模型列表** | 该服务支持的模型 | 如 `dall-e-3`、`speech-2.8-hd`、`music-2.5+` |
| **启用** | 是否生效 | 关闭后对应工具不再注入 |

## 管理工具

AI 可通过以下工具管理多模态服务（配置写入权限，需 2 级）：

| 工具 | 功能 |
|------|------|
| `list_multimodal_services` | 列出所有已配置的服务 |
| `create_multimodal_service` | 创建新服务（必填：`name`、`serviceType`、`brand`、`url`） |
| `update_multimodal_service` | 更新服务（必填：`serviceId`） |
| `delete_multimodal_service` | 删除服务（必填：`serviceId`） |

也可通过自然语言操作，如「帮我配置一个 MiniMax 的图片生成服务」「关掉语音合成」。

## 生成的文件去哪了

图片、音频、视频生成后，文件会保存到**当前会话的文件目录**中，并返回文件名：

| 返回字段 | 含义 |
|----------|------|
| `images[].name` / `audio_file` / `video_file` | 会话目录内的文件名 |
| `url` / `video_url` | 部分服务返回的在线链接（如图片直链） |
| `task_id` | 异步任务（如 MiniMax 视频）的查询 ID |

- MiniMax 视频是异步任务，会自动轮询最多 10 分钟，完成后下载到会话目录。
- 生成结果中的图片可直接在对话中展示；音频/视频文件可用下面的 `access_file` 再次加载。

## 多模态内容读取

除生成外，系统还内置读取本地多模态文件的工具：

| 工具 | 功能 | 说明 |
|------|------|------|
| `access_file` | 读取本地文件 | 图片/音频/视频以多模态内容注入对话，模型可直接"看/听/读"。支持绝对路径、相对路径、文件名（会在会话目录查找）。若模型不支持某格式会报错，可用 `execute_code` 替代分析 |
| `audio_analyze` | 音频转写/分析 | 支持 mp3/wav/m4a/ogg/flac。`task` 为 `transcribe`（转写，默认）或 `analyze`（分析）。需让模型直接"听"音频请用 `access_file` |

### 典型用法

- 「帮我看看这张图片 /tmp/logo.png 里是什么」→ `access_file`
- 「把这段录音 /tmp/meeting.mp3 转成文字」→ `audio_analyze`
- 「画一张赛博朋克风格的城市」→ `generate_image`（需先配置 image 服务）
- 「把这段话读出来：你好世界」→ `text_to_speech`（需先配置 tts 服务）

## 常见问题

### Q: 为什么看不到 `generate_image` 等工具？

这些工具按配置涌现。请确认：
1. 已用 `list_multimodal_services` 查看是否有对应类型的服务
2. 该服务 `enabled` 为开启状态
3. 没有配置任何 image 服务时，`generate_image` 工具不会出现

### Q: API 地址怎么填？

参考各服务商文档，填到能拼出对应端点的根地址。系统会自动在地址后拼接路径（如 OpenAI 图片会拼 `/images/generations`，MiniMax 会拼 `/image_generation`）。若地址已含 `/v1` 则直接拼接，否则补 `/v1`。

### Q: 音色（voice）填什么？

| 服务商 | 可选音色 |
|--------|----------|
| OpenAI | `alloy`、`echo`、`nova` 等（默认 `alloy`） |
| MiMo | `冰糖`、`茉莉` 等 |
| MiniMax | `male-qn-qingse`、`female-shaonv` 等（默认 `male-qn-qingse`） |

具体可用音色以服务商文档为准。

### Q: 模型不支持某种格式怎么办？

用 `access_file` 加载多模态文件时，若模型不支持会返回错误。此时可改用 `execute_code` 等工具分析文件内容。

## 相关指南

| 主题 | 技能 | 说明 |
|------|------|------|
| 供应商管理 | `/guide-provider` | 多模态服务需要可用的 API Key 和地址 |
| 智控助手 | `/guide-assistant` | 多模态工具在智控助手中使用 |
