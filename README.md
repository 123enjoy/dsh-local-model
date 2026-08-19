# dsh-local-model

> **[DeepSeek Harness](https://github.com/anthropics/anthropic-cookbook) 插件** — 将本机 [Ollama](https://ollama.com) 模型包装为 agent 工具，让云端 LLM 通过工具调用本地模型，实现 **Token 蒸馏** 与 **智能路由**。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-local--model-purple.svg)](https://github.com/deepseek-ai/dsh)

---

## ✨ 功能特性

| 特性                  | 说明                                             |
| ------------------- | ---------------------------------------------- |
| 🤖 **本地模型工具**       | 暴露 Ollama 运行时，云端模型可通过 `local_model_*` 工具调用本地模型 |
| 🗜️ **出站 Token 蒸馏** | 长文本请求自动压缩，本地小模型处理后发送给云端，大幅降低 Token 消耗          |
| 🎯 **结果级蒸馏**        | 工具执行结果（read/pwsh/ssh 等）在存入会话前自动蒸馏，GUI 可见       |
| 📊 **历史剪枝**         | 请求超预算时自动压缩旧消息，保留最近完整消息                         |
| 🧠 **智能路由**         | 简单任务（翻译/摘要/分类等）自动委托给本地模型                       |
| 🔒 **隐私优先**         | 敏感数据优先本地处理，减少外传                                |

---

## 🏗️ 架构

```
┌─────────────────────────────────────────────────┐
│                   云端 LLM                       │
│         (DeepSeek / GPT-4 / Claude 等)           │
└────────────────────┬────────────────────────────┘
                     │ 工具调用
                     ▼
┌─────────────────────────────────────────────────┐
│              DSH Host Process                    │
│  ┌───────────────────────────────────────────┐  │
│  │           dsh-local-model 插件            │  │
│  │  ┌─────────────┐  ┌───────────────────┐  │  │
│  │  │ 工具注册     │  │   出站蒸馏器       │  │  │
│  │  │ local_model  │  │  (stream 钩子)    │  │  │
│  │  └──────┬──────┘  └─────────┬─────────┘  │  │
│  │         │                   │             │  │
│  │         ▼                   ▼             │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │        Ollama API (127.0.0.1)       │  │  │
│  │  │   local_model_chat / distill 等      │  │  │
│  │  └─────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                     │
                     ▼
          ┌──────────────────┐
          │   本机 Ollama     │
          │  (localhost:11434)│
          └──────────────────┘
```

---

## 🚀 快速开始

### 前提条件

1. **Node.js** ≥ 22.19.0 或 ≥ 24.0.0
2. **[Ollama](https://ollama.com/download)** 已安装并运行
3. **DeepSeek Harness (dsh)** 已安装

### 安装

```bash
# 1. 确保 Ollama 正在运行
ollama serve

# 2. 拉取一个蒸馏推荐模型（可选，用作蒸馏器）
ollama pull qwen3:4b

# 3. 安装插件（链接本地开发目录）
dsh plugin --profile web add link:D:/dsh/mcp/dsh-local-model
```

### 验证

```bash
# 重启 DSH
dsh web

# 在对话中测试
> 你本地有哪些模型？
# → 模型会调用 local_model_list 展示已安装模型

> 帮我把这段话翻译成英文：...
# → 简单任务自动路由到本地模型
```

---

## 📦 工具列表

| 工具                    | 说明                                          |
| --------------------- | ------------------------------------------- |
| `local_model_list`    | 列出本地已安装模型（名称/参数量/量化/体积）                     |
| `local_model_chat`    | 向本地模型发起对话（支持 temperature/num_predict/think） |
| `local_model_running` | 查看当前加载进显存的模型                                |
| `local_model_distill` | 用本地模型蒸馏长文本/文件，返回压缩摘要及 token 统计              |

---

## ⚙️ 配置

在 DSH 配置文件中添加：

```yaml
plugins:
  local-model:
    enabled: true
    announceToAgent: true      # 注入系统提示引导模型使用本地工具

    # --- Ollama 连接 ---
    baseUrl: 'http://127.0.0.1:11434'
    defaultModel: 'qwen3:4b'   # 本地默认模型
    timeoutMs: 120000           # 本地推理超时（毫秒）

    # --- 路由 ---
    routingGuidance: true       # 引导云端模型将简单任务路由到本地

    # --- 出站蒸馏 ---
    distillEnabled: true
    distillModel: 'qwen3:4b'   # 蒸馏用模型（默认回退 defaultModel）
    distillMinChars: 2000       # 低于此长度不蒸馏
    targetRatio: 0.4            # 目标压缩比
    distillOnError: 'pass'      # 失败策略：pass=按原文发送
    distillBudgetMs: 60000      # 蒸馏预算超时

    # --- 结果级蒸馏 ---
    # 工具执行后自动蒸馏（read/pwsh/ssh 等）

    # --- 历史剪枝 ---
    pruneEnabled: true
    pruneBudgetTokens: 40000    # token 预算上限
    pruneKeepRecent: 12         # 保留最近 N 条完整消息
    pruneMaxSourceChars: 12000  # 摘要源文本上限
    pruneMaxSummaryTokens: 2048 # 摘要 token 上限
```

---

## 🔧 工作原理

### 1. 本地模型工具

云端 LLM 在对话中可调用 `local_model_chat` 等工具，由 DSH 宿主进程在本地执行 Ollama API 调用。**云端模型不直接访问 localhost**，所有通信通过工具协议中转。

### 2. 出站 Token 蒸馏

当发送给云端的请求包含长文本（工具结果、历史消息）时：

```
原始文本 → 长度检查 → 本地模型蒸馏 → 缓存 → 发送给云端
              ↓ (>2000字符)
         直接发送
```

蒸馏后的文本带有标记：

```
⟦本地蒸馏·原文 6146 字符·≈1721→503 tokens（-71%）⟧
```

### 3. 结果级蒸馏

工具执行后，结果在存入会话前自动蒸馏。**防重复蒸馏**机制：同一内容哈希第二次出现时跳过蒸馏，直接返回完整原文。

### 4. 历史剪枝

当请求 messages 总 token 超过预算时，自动将最旧消息替换为本地生成的历史摘要，仅保留最近 N 条完整消息。

---

## 📁 项目结构

```
dsh-local-model/
├── lib/
│   ├── index.js              # 插件入口 & 配置
│   ├── tools.js              # local_model_* 工具定义
│   ├── ollama.js             # Ollama API 客户端
│   ├── compress.js           # 文本蒸馏核心
│   ├── outbound-distill.js   # 出站蒸馏器
│   └── result-distill.js     # 结果级蒸馏器
├── test/
│   ├── simulate.js           # 模拟测试
│   ├── distill-*.txt         # 测试数据
│   └── repro-*.js            # 复现脚本
├── cordis.patch.yml          # DSH 插件注册
├── package.json
└── README.md
```

---

## 🧪 测试

```bash
# 运行模拟测试
node test/simulate.js

# 复现特定场景
node test/repro-distill-hang.js
node test/repro-prune.mjs
node test/repro-notice.mjs
```

---

## 🐛 调试

```bash
# 启动时带 DEBUG 环境变量查看蒸馏日志
set DEBUG=local-model:*
dsh web
```

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

---

## 📄 License

[MIT](LICENSE) 

---

## 🔗 相关链接

- [DeepSeek Harness](https://github.com/deepseek-ai/dsh) - DSH 主仓库
- [Ollama](https://ollama.com) - 本地大模型运行时
- [Cordis](https://github.com/cordiverse/cordis) - DSH 插件框架
