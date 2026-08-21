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
| `local_model_run`     | 让本地模型读取并处理本地文件，返回简洁结果（数据不出本机）              |
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
    tokenEstimateFactor: 1.25   # estimateTokens × factor ≈ 真实 token（混合 CJK/代码通常 ~1.25）；预算/卡片按真实 token 显示
    distillCacheLimit: 50000    # 蒸馏结果缓存上限（越大越不容易重蒸馏，保缓存命中）

    # --- 结果级蒸馏 ---
    # 工具执行后自动蒸馏（read/pwsh/ssh 等）

    # --- 历史剪枝（冻结摘要链，缓存友好） ---
    pruneEnabled: true
    pruneBudgetTokens: 60000    # 请求超此估算触发剪枝（大上下文模型可调到 60K~85K）
    pruneKeepRecent: 12         # 保留最近 N 条完整消息
    pruneBatchSize: 12          # 每个冻结摘要块覆盖的滚动消息条数
    pruneMaxSourceChars: 12000  # 摘要源文本上限
    pruneMaxSummaryTokens: 2048 # 每块摘要 token 上限
    pruneChainMaxBatches: 20    # 摘要链最多 N 块，超出触发一次深度合并（核心取舍旋钮）
    pruneMaxNewBlocks: 3        # 单次请求最多新增的摘要块数
    pruneRollMargin: 1.2        # 惰性滚动阈值 = 预算 × 余量；请求超过此值才滚动旧消息入链（保尾部缓存命中）
```

---

## 🔧 工作原理

一条消息从「会话存储」到「发给云端」会经过两道本地小模型处理。**全流程的目标是：让发给云端的字节在轮与轮之间保持稳定**——云端大模型的 prompt cache 按请求字节前缀精确命中，字节稳定 → 命中率高 → 成本低。

```
┌─ 会话存储 ───────────────────────────────────────┐
│ ① 结果级蒸馏（写入时）：长工具结果在存入会话前先蒸馏  │
└───────────────────┬──────────────────────────────┘
                    ▼
┌─ 每次 llm/stream 请求 ──────────────────────────┐
│ ② 历史剪枝（惰性）：最旧消息 → 冻结摘要链           │
│ ③ 出站蒸馏（确定性）：长文本 → 本地模型压缩          │
│ ④ 组装请求：[system][工具][摘要链][蒸馏后消息][新]   │
└───────────────────┬──────────────────────────────┘
                    ▼
        云端大模型（前缀缓存命中 [system][链][旧可见消息]）
```

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

**缓存友好（省成本关键）**：云端大模型的 prompt cache 按请求字节前缀精确命中。插件保证「发给云端的字节」在轮与轮之间稳定：
- 每条消息按 `id+内容哈希` 缓存蒸馏结果，命中即原样复用（`distillCacheLimit` 默认 5 万条，长会话不逐出）；
- 蒸馏用 `temperature:0` + 内容派生 seed，偶发重蒸馏字节也一致；
- 预算超时只放行**从未蒸馏过**的冷消息，已缓存的永远走蒸馏分支，raw/distilled 边界不随本地推理快慢抖动。

### 3. 结果级蒸馏

工具执行后，结果在存入会话前自动蒸馏。**同一内容再次出现（模型重读）时复用首次的蒸馏字节**，保证会话与云端缓存看到的内容一致，不再在蒸馏/原文之间交替。

### 4. 历史剪枝（冻结摘要链 + 惰性滚动）

**要解决的问题**：会话无限增长，全量发给云端又贵又可能超上下文。但压缩旧消息会改变字节 → 破坏云端缓存 → 反而更贵。历史剪枝在「压 token」和「保缓存」之间取折中。

**三个核心概念**：

| 概念 | 含义 |
|---|---|
| **冻结链** | 一串 `⟦历史剪枝⟧` 摘要块，每块是「一批旧消息的本地摘要」，**写一次永不重写** |
| **惰性滚动** | 只有请求总 token 超过 `pruneBudgetTokens × pruneRollMargin` 才把最旧的若干条滚成新块；没超就原样放行 |
| **边界（boundary）** | 链覆盖到哪。链尾之后的消息一律原样保留、只追加，字节永不改写 |

请求结构：

```
[块₀][块₁]...[块ₖ][未滚动的消息][新消息...]
 └─ 写一次永不改写 ─┘  └─ 只追加、永不改写 ─┘
```

**走一遍数字**（设阈值 12K，每条消息 ≈1K，`pruneKeepRecent=4`，`pruneBatchSize=4`）：

- **第 6 轮**：14 条 = 14K > 12K → 触发。保留最近 4 条 `m11..m14`，只滚最旧 4 条 `m1..m4` 成块 A：
  ```
  [块A(摘要m1..m4)] [m5][m6][m7][m8][m9][m10][m11][m12][m13][m14]
   ≈0.5K              ≈10K            → 合计 ≈10.5K ≤ 12K，停
  ```
  注意**只滚 4 条**——最少的一批，够回到阈值内就停，不把能滚的都滚完。
- **第 7 轮**：16 条 → `[块A] + [m5..m16]` ≈12.5K > 12K → 再滚 `m5..m8` 成块 B → `[块A][块B] + [m9..m16]` ≈9K，停。
- **第 8~9 轮**：18 条 → `[块A][块B] + [m9..m18]` ≈11K ≤ 12K → **不滚**，原样发出。这一整段字节和上一轮一模一样 → 云端缓存全命中，只 miss 新增的 m17、m18。
- **第 10 轮**：20 条 > 12K → 再滚 `m9..m12` 成块 C，依次类推。

**为什么这样保住命中率**：
- 轮与轮之间，`[链 + 未滚动消息]` 的字节**一个都不变**，只往末尾追加新消息 → 缓存命中这一整段，命中率 ~95%+（实测 95%）。
- 滚动那一轮尾部位置位移一次、miss 一次，但频率被「惰性」压得很低（每跨过阈值才一次）。
- 老实现每轮都滚动 → 尾部每轮位移 → 命中率只剩 ~60%。

**深度合并**：链块数超过 `pruneChainMaxBatches`（20）时把整条链合并成一个新块——这是唯一整链重写、全量 miss 的事件，故意压到极低频，以限制链本身占的 token。合并源截断到 `pruneMaxSourceChars`（较新端整块优先），保证几十块的链也能一次合并成功（全量源会超本地模型上下文）。调大 `pruneChainMaxBatches` 更省缓存、代价是摘要链 token 略增；调小则相反。

**链追平（欠账恢复）**：请求**远超阈值**时（如估算口径修复后揭开的欠账、或链重建），单次请求的滚动上限随超支程度放大（最多 48 块 × 48 条 ≈ 2300 条/请求），让链在 1~3 个请求内追平预算——欠账期间请求持续超阈值、字节每轮位移、缓存命中低是**暂时**的，追平后回到惰性模式（每跨阈值才滚一次）、字节恢复稳定、命中恢复。欠账的历史从未被摘要过时，追平那几次请求会多走一些本地摘要调用（持久化缓存命中大部分）。

**`pruneBatchSize` 为什么不是越大越好**：
- 调大的好处：一次滚更多 → 滚动次数变少 → 命中率略升；块更少、本地调用更少。
- 两个硬代价：
  1. **源文本上限 `pruneMaxSourceChars`（12000 字符）**：每个块的摘要源最多 12000 字符，且**从块的较新端截取**——块太大时，较早的消息根本进不了摘要源 → 内容真丢失。安全大小 ≈ `12000 / 单条消息平均字符数`。
  2. **摘要 token 上限 `pruneMaxSummaryTokens`（2048）**：块越大、源越多，这 2048 token 越稀疏，关键事实越容易被挤掉。
- 结论：默认 12（配 12000 字符上限、假设单条 ≈1000 字符）是平衡值；消息偏短可调大到 20–30（同时调大 `pruneMaxSourceChars`），消息很长（工具输出动辄几千字符）应保持 12 或调小，否则省的 token 是靠丢内容换来的。

**`pruneBudgetTokens` 怎么设**：
- 主要受**上下文窗口**约束，不是命中率（惰性滚动已保证命中率）。
- 公式：`(模型上下文窗口 − 系统提示词 − 工具定义 − 预留回复空间) / pruneRollMargin`（再留 10~20% 余量）。卡片正文会显示「系统提示词 / 工具 / 对话消息 / 合计」的 token 拆分，可直接读出固定开销。
- **计费口径（重要）**：估算/预算按 DSH **真实发给 provider 的内容**统计——`text`、**工具回合的 `reasoning_content`（思考链，deepseek 只在带 tool-call 的 assistant 回合回放，其余回合适配器丢弃）**、**`tool_calls.arguments`**、以及 tool-result 内容。口径与 `dsh-llm-deepseek` 的序列化和 DSH 自带的 `dsh-token-meter` 一致。老版本只数 text 块，会把思考链和工具参数完全忽略——实机上估算 43K、真实 60K 就是这么来的（剪枝预算、notice 卡片都按计费内容统计）。
- **再校准 `tokenEstimateFactor`**：上面的口径修正后，剩下的低估来自密度启发式（`estimateTokens` 对混合 CJK/代码约 1.25×）。把卡片「合计」与云端账单里的实际 prompt tokens 对比，比值就是 factor。设置后 `pruneBudgetTokens` 按**真实 token** 计，请求上限 = `预算 × pruneRollMargin`（真实 token）。
- 例：设了 `tokenEstimateFactor: 1.25` 后，DeepSeek 128K 上下文、系统+工具 ≈15K、预留 10K → `(128−15−10)/1.2 ≈ 85K`；想要真实 ~60K 上限则 `60000/1.2 = 50000`。

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
