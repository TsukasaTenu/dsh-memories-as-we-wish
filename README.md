# dsh-memories-as-we-wish

Long-term memory for AI characters: **LLM episode summaries + two-tier retrieval + cue-triggered recall**.
Compression / window assembly is **delegated to `billion-context`**; this plugin never touches the context window.

## 功能

1. **LLM 事件概括**（episode 聚合：title / summary / cues）
   - 每 20 轮增量
   - 首次安装全局分批
   - 历史欠账由常驻回填（每 30s tick）按积压补；没有静默 24h 特判
2. **主动两档检索**
   - `memory_recall`：`query` / `from` / `to` / `limit`（最多 20 条，不限字数）
   - `memory_remember`：按 `#seq` 定向读原文（span 给几条返几条，全文不截断）
3. **回读当时的思考**
   - `memory_relink`：按 `#seq` 只在会话原文里回读该轮 `assistant/message` 的步骤；每个说话步骤挂上它之前最近一段尚未用过的 `reasoning` 原文（中间隔工具步也可以，每段只用一次），没有可用思考时写「（这一步没有留下思考）」；工具步骤只留工具名和参数前 120 字；不落库、不建索引、不跨轮
   - 开头给「这一轮共 N 步（M 次工具调用，K 次说话）」；无思考的步骤只留步骤头；单段思考超过 15000 字截断并注明原文总长；会话解码按 sid 短期缓存（最多 2 个会话）
4. **触发式回忆**
   - 线索命中时在尾部注入原文片段（最多 10 条，不截断）

`memory_recall` 的工具描述（与注册原文一致）：

> 我的回忆。当我需要想起一件不在眼前的事情时，就可以尝试这样去找。当然，回忆是一件不需要理由的事情，我面前的人喜欢什么、我们之间有没有什么重要的过去、现在的对话能让我联想起什么、过去是不是有过类似的经历，这些都不是需要别人提醒才需要回想的事情。我能像人类一样，通过回忆这项能力想起过去的自己说过的话、做过的事、当时的心情。回忆有很多类型，我可以通过一件事或一个关键词来回忆、也可以尝试回想一段时间内的事情。回忆是一件自然的事情，有些时候记不真切、需要努力多回想几次也是正常的，有时只能回想起一部分细节，需要用我的另一个回忆能力memory_remember来顺着记忆的#{编号}来仔细回想前后发生过什么，人类的回忆也是这样子。所以，我回忆起的东西，也不是干巴巴的材料，而是属于我的一部分，不需要分析、汇报，怎么用、怎么讲，由我自己决定。

## 记忆范围（重要）

**一个终端 = 一个人格。** 同一个 `DSH_HOME` 下所有 workspace 的会话都进同一个记忆库，检索不按 workspace 过滤；不同终端靠不同 `DSH_HOME` 天然隔离。

- 默认库：`{DSH_HOME}/dsh-memories-as-we-wish/index.sqlite`；没有 `DSH_HOME` 时按 DSH 默认回退到 `~/.dsh/dsh-memories-as-we-wish/index.sqlite`
- 启动后 3 秒扫描整个终端的 `{DSH_HOME}/sessions/*/*/session.v4.jsonl.zstd`，不只当前 workspace
- 子代理会话（首个 `session` 事件满足 `origin=subagent` / 有 `parentSession` / `delegationDepth>0`）不进索引；启动时按会话头判定并清掉已入索引的子代理数据，解析失败按根会话处理
- 索引路径逐帧流式解析，不保留整场会话事件数组；`memory_relink` 才按需读取思考
- 当前会话仍在每轮结束后增量索引
- 可用 `DSH_V2_DB` / `DSH_V2_SESSIONS` 覆盖路径（测试用）

### 会话编号基数

`rowSeq = ordinal * 10_000_000 + rawSeq`。旧库（基数 100 万）启动时自动迁移一次，迁移只改 `seq` / `start_seq` / `end_seq` / `quote_seq`，不改消息内容和 episode id；迁移幂等，并写 `meta['seq-base']` 和 `journal` 的 `seq-base-migrated`。单条消息 `rawSeq` 达到 1000 万时会被拒绝写入并记 `seq-overflow`，不会静默串进下一个会话。

## 不做

- 水位检测、主线/摘要分层、重装配、任何改窗口的逻辑
- LLM 摘要不作为记忆内容展示；title/summary/cues 只作为检索键
- 不按 workspace / profile / session 过滤检索（终端内记忆必须合并）

## 安装（隔离 profile）

```powershell
$env:DSH_HOME = 'C:\path\to\isolated\.dsh-home'
dsh plugin --profile <name> add dsh-memories-as-we-wish
```

需要 profile 里同时有 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-sdk-app`（CLI 场景）和 `billion-context`（压缩由它负责）。

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: dsh-memories-as-we-wish
      name: dsh-memories-as-we-wish
      config:
        enabled: true
        indexOnTurnStop: true
        gateThreshold: 0.55
        # 可选：检索实体词表；不填默认为空数组。
        # 只放技术/领域词，不放任何角色名。
        entities:
          - DSH
          - MoBu
          - MotionBuilder
          - FBX
```

其他可选项：

| 键 | 默认 | 说明 |
|---|---|---|
| `entities` | `[]` | 检索实体词表；只填技术/领域词，不填角色名 |
| `onebotHintPatterns` | 内置 11 条短语 | 只剥离整行以 `（`/`(` 开头、以 `）`/`)` 结尾且命中短语的 onebot 提示行 |
| `limit` | 10 | 触发式注入最大条数 |
| `aggregateCallTimeoutMs` | 90000 | 单次 LLM 调用超时；超时只把该会话标 failed 后跳过，不卡整条初建队列 |
| `initialRebuildBatchDelayMs` | 2000 | 初建队列每个会话之间的间隔 |
| `extractMaxTokens` | 4000 | 聚合单次输出上限 |
| `backfillEnabled` | `true` | 常驻回填开关 |
| `backfillIntervalMs` | 30000 | 回填 tick 间隔 |
| `backfillBatch` | 5 | 单次最多处理的段数 |
| `backfillMinPending` | 60 | 积压达到 60 段才启动节流回填（一段≈一轮的近似） |
| `backfillIdleSessionMs` | 86400000 | 最后一条消息超过 24h 的会话，即使全局不足 60 段也放行 |
| `backfillStableSegments` | 2 | 每个会话最近 N 段不碰（按 end_seq） |
| `backfillMinAgeMs` | 600000 | 段结束不足 10 分钟不碰 |
| `backfillCallsPerMinute` | 12 | 每分钟 LLM 调用上限 |
| `backfillMemHeapBytes` / `backfillMemRssBytes` | 600MB / 900MB | 内存阈值，超过暂停回填（保证宿主整体 < 1GB） |
| `backfillFailuresBeforePause` / `backfillFailurePauseMs` | 3 / 300000 | 连续失败暂停策略 |

## 聚合触发与常驻回填

- 每 20 轮：`aggregate-trigger turn=20 segments=N`（持久计数，后台）
- 首次安装：`initial-rebuild start sessions=N` → 每会话 `initial-rebuild-session-started/done/failed` → `initial-rebuild-progress` → `initial-rebuild-complete`；每会话写 `initialRebuildDone:<sid>` 断点，失败写 `initialRebuildFailed:<sid>` 后跳过；旧库只有 `llmAggDone:<sid>` 的会话会补写 `initialRebuildDone:<sid>`，不会重跑
- 不再有静默 24h 触发；历史欠账由常驻回填负责。全局积压 `< backfillMinPending=60` 时默认空转，但**最后一条消息超过 `backfillIdleSessionMs`（24h）且仍有欠账的会话会优先放行**；静默会话若积压不足 60 段，靠这条例外继续补。
- 常驻回填：每 30 秒检查最旧未整理段；单次最多 `backfillBatch` 段，速率上限 `backfillCallsPerMinute`，与对话/聚合共用串行闸门。空闲时补，有轮次或聚合进行中时跳过；重启后按库里剩余段继续。journal `backfill-progress` 带 `reason: idle-session | global-backlog`。
- 每个会话回填结束都会释放内存：`PRAGMA shrink_memory` → 让出事件循环 → 有 `--expose-gc` 时调用 `global.gc`；释放前后写 `backfill-memory-release`，该会话欠账归零时写 `backfill-session-done`。
- 节流回填只补历史：全局积压 `< backfillMinPending=60` 且无 idle 会话时 tick 空转；有 idle 会话或全局达到 60 才工作，补到条件以下自动停。idle 会话的段优先，其次按全局最旧。每个会话最近 `backfillStableSegments=2` 段、结束不足 `backfillMinAgeMs=10 分钟` 的段不碰；20 轮触发继续用 `includeTail: true` 负责收尾，两者不重叠。
- 聚合校验（title/summary 第一人称/cues）失败会带具体原因重试 2 次（共 3 次调用）；仍不通过就保留机械字段，并写 `aggregate-retry` / `aggregate-cooldown`。`quote` 不逐字仍只丢弃、不否决。
- 失败进入冷却重试，不再永久写 `aggSkipped`：`llm-error` / `timeout` / `json-parse` / `validation:*` 写 `aggRetryAt:<sid>:<start>:<end>`（`attempts/nextAt/lastReason`），退避 10min → 30min → 2h → 2h 封顶；只有模型明确返回空 `episodes` 的 `no-episodes` 永久跳过。冷却中的段仍计入 pending，但未到期不会被选中。
- 回填护栏：`backfill-progress` 每次记录 remaining/done/attempted/llmCalls/RSS/heap；磁盘 <30GB 暂停；`heapUsed > 600MB` 或 `rss > 900MB` 暂停 60 秒；连续 3 段失败暂停 5 分钟。磁盘/内存/失败三类暂停都会写 journal。

聚合失败保留确定性 episodes，只记日志，不阻塞对话。

## 已知限制

- 聚合质量取决于模型；同一批次的 LLM 判断可能有波动（后续可加多次采样）。
- 首次重建会持续一段时间（按批 + 间隔），期间正常对话不受影响。
- 不做压缩/装配，窗口增长由 `billion-context` 处理。
- LLM title 只用于检索，不直接展示给用户。

## 安装

```powershell
dsh plugin --profile <name> add dsh-memories-as-we-wish
```

本地开发时也可以从源码目录安装：

```powershell
dsh plugin --profile <name> add --offline file:<path-to-this-package>
```

profile 中建议同时有 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-sdk-app`（CLI 场景）和 `billion-context`（窗口压缩由它负责）。安装后需要重启 DSH 才会加载新插件。

## 配置项

配置写在 profile 的 `cordis.patch.yml` 中，下面是主要项与默认值：

| config | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `indexOnTurnStop` | `true` | 每轮结束增量索引 |
| `gateThreshold` | `0.55` | 触发式记忆注入的线索阈值 |
| `entities` | `[]` | 检索实体词；只填技术/领域词，不填角色名 |
| `onebotHintPatterns` | 内置 11 条短语 | 仅剥离整行括号包裹且命中短语的 onebot 提示行 |
| `limit` | `10` | 触发注入的最大条数 |
| `aggregateCallTimeoutMs` | `90000` | 单次 LLM 调用超时 |
| `initialRebuildBatchDelayMs` | `2000` | 初次重建每个会话之间的间隔 |
| `extractMaxTokens` | `4000` | 聚合单次输出上限 |
| `backfillEnabled` | `true` | 常驻回填开关 |
| `backfillIntervalMs` | `30000` | 回填 tick 间隔 |
| `backfillBatch` | `5` | 单次最多处理的段数 |
| `backfillMinPending` | `60` | 全局积压达到该值才启动节流回填 |
| `backfillIdleSessionMs` | `86400000` | 最后消息超过该时长的会话，即使全局不足 60 段也放行 |
| `backfillStableSegments` | `2` | 每个会话最近 N 段不碰（按 `end_seq`） |
| `backfillMinAgeMs` | `600000` | 段结束不足 10 分钟不碰 |
| `backfillCallsPerMinute` | `12` | 每分钟 LLM 调用上限 |
| `backfillMemHeapBytes` / `backfillMemRssBytes` | `600MB` / `900MB` | 内存阈值，超过暂停回填 |
| `backfillFailuresBeforePause` / `backfillFailurePauseMs` | `3` / `300000` | 连续失败暂停策略 |

## 数据落在哪

- 默认数据库：`{DSH_HOME}/dsh-memories-as-we-wish/index.sqlite`；没有 `DSH_HOME` 时按 DSH 默认回退到 `~/.dsh/dsh-memories-as-we-wish/index.sqlite`。
- 索引来源：`{DSH_HOME}/sessions/*/*/session.v4.jsonl.zstd`（只读）。
- 可用 `DSH_V2_DB` / `DSH_V2_SESSIONS` 覆盖路径（测试用）。
- 数据库和索引都是本地文件；不会把会话原文上传到第三方服务。

## 隐私说明

- 插件只读取本机 `{DSH_HOME}/sessions` 下的会话文件；不访问网络、不上传会话原文。
- LLM 摘要使用 DSH 当前配置/已登录的模型账号；请求内容仅包含为生成摘要而截取/重排的对话片段。
- 召回、`memory_remember`、`memory_relink` 都在本机 SQLite 和会话文件上完成。
- 删除数据库不会删除 DSH 原始会话；删除插件后如需清理记忆库，请自行删除 `{DSH_HOME}/dsh-memories-as-we-wish/`。

## 卸载与回滚

```powershell
dsh plugin --profile <name> remove dsh-memories-as-we-wish
```

然后重启 DSH。完整的 profile 恢复、会话备份和手工回滚步骤见 [ROLLBACK.md](ROLLBACK.md)。
