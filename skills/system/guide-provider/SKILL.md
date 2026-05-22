---
name: guide-provider
description: 供应商管理指南，包括创建供应商、配置 API Key、密钥轮换
trigger: 用户询问怎么添加供应商、API Key 配置、密钥轮换、供应商 API 地址、怎么接入 OpenAI、怎么配置模型、如何开始使用、首次使用、快速上手
---

# 供应商管理指南

供应商是 API 密钥的来源，可以包含多个 API Key 进行负载均衡和故障转移。

## 首次使用三步走

1. **添加供应商** → 「供应商管理」→ 新建供应商，填写 API 地址和 Key
2. **创建代理** → 「代理管理」→ 新建代理，选择供应商，分配端口
3. **启动代理** → 点击代理卡片的「启动」按钮，然后用 curl 或客户端测试请求

```bash
# 快速测试
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]}'
```

## 配置项详解

| 配置项 | 含义 | 示例/说明 |
|--------|------|----------|
| **名称** | 供应商的显示名称，方便识别 | `OpenAI 官方`、`硅基流动生产` |
| **协议** | API 协议类型，决定请求格式 | `OpenAI`：兼容 OpenAI 格式的 API<br>`Anthropic`：Claude API<br>`Gemini`：Google Gemini API |
| **API 地址** | 供应商的 API 端点，必须以 `/v1` 或完整路径结尾 | `https://api.openai.com/v1`<br>`https://api.siliconflow.cn/v1`<br>`https://api.anthropic.com` |
| **模型列表** | 该供应商支持的模型名称，支持模型路由 | 输入模型名后按回车添加，如 `gpt-4`、`claude-3-opus` |
| **API Keys** | 访问供应商的密钥，支持多 Key 轮换 | 点击「+ 添加 Key」添加 |
| **适配器** | 国内模型适配器，自动处理协议差异 | `qwen`、`deepseek`、`kimi`、`doubao`、`zhipu`、`minimax` |
| **能力标签** | 该供应商支持的能力列表 | `tools`、`vision`、`json` 等 |
| **Azure 部署** | Azure OpenAI 部署名称 | 仅 Azure OpenAI 需要 |
| **Azure API 版本** | Azure OpenAI API 版本 | 如 `2024-02-01` |

## 常用 API 地址参考

| 供应商 | API 地址 | 建议适配器 |
|--------|----------|-----------|
| OpenAI 官方 | `https://api.openai.com/v1` | — |
| Anthropic 官方 | `https://api.anthropic.com` | — |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | — |
| 硅基流动 | `https://api.siliconflow.cn/v1` | — |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `zhipu` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek` |
| Moonshot (Kimi) | `https://api.moonshot.cn/v1` | `kimi` |
| 字节豆包 | `https://ark.cn-beijing.volces.com/api/v3` | `doubao` |
| MiniMax | `https://api.minimax.chat/v1` | `minimax` |
| 本地模型 (Ollama) | `http://localhost:11434/v1` | — |

## API Keys 配置详解

| 配置项 | 含义 | 说明 |
|--------|------|------|
| **密钥内容** | API Key 的完整值 | 粘贴即可，系统不会明文显示 |
| **权重** | 使用频率权重，数字越大使用越多 | 默认 1，设为 2 则该 Key 使用概率翻倍 |
| **状态** | 密钥启用/禁用控制 | 禁用的 Key 不会被使用 |

## API Key 轮换机制

当某个 Key 触发限流（429）时，系统会自动：
1. 标记当前 Key 为「限流中」
2. 切换到下一个可用的 Key
3. 3分钟后自动恢复尝试该 Key

## 创建供应商

1. 点击左侧菜单「**供应商管理**」
2. 点击「**新建供应商**」按钮
3. 填写配置（见上方配置项详解）
4. 点击「**保存**」

## 自动获取模型列表

填写供应商信息（至少一个有效 Key）后，点击「**自动获取模型列表**」按钮，系统会：
1. 调用供应商 API 的 models 端点
2. 自动填充支持的模型列表
3. 如果失败可手动输入模型名

## 测试供应商连接

填写完供应商信息后，点击「**测试连接**」按钮可以：
- 验证 API 地址是否可访问
- 验证 API Key 是否有效
- 返回可用模型列表

## 密钥健康状态

| 状态 | 含义 | 处理建议 |
|------|------|----------|
| **正常** | 密钥可用，请求正常 | 无需操作 |
| **限流中** | 触发速率限制，正在等待恢复 | 可添加更多 Key 分散压力 |
| **失效** | 密钥无效或额度用尽 | 更换或充值密钥 |

在「**总览**」页面可查看所有密钥健康状态。

## 批量添加 Key

在添加 Key 界面，可以一次粘贴多个 Key（每行一个），系统会自动识别并逐个添加。

## 常见问题

### Q: 请求返回 429 限流怎么办？
- 检查密钥是否额度用尽
- 添加更多 API Key 到供应商池
- 降低请求频率

### Q: 如何实现密钥轮换？
在供应商中添加多个 API Key，系统会自动轮换：
- 当前 Key 触发限流时自动切换
- 可设置不同 Key 的权重
