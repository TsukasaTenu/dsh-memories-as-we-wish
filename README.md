# dsh-memories-as-we-wish

极简长期记忆：LLM 事件概括 + 两档原文检索 + 线索触发的原文注入 + 思考回读。

适用情景：长期陪伴的人格型个人助手，用于生活细节、过往经历、情感事件等的拟人类型回忆。

不擅长情境：大型项目、决策历史、工程知识等。工具不含决策压缩、fact断言等能力，希望模型同时具有两种记忆能力可以尝试与**hindsight**一同安装。

## 能力

1. **LLM 事件概括**（episode 聚合：title / summary / cues）
   - 每 20 轮增量
   - 首次安装全局分批（可断点续跑）
   - 历史欠账由常驻回填按积压补，没有静默 24h 特判
2. **主动两档检索**
   - `memory_recall`：`query` / `from` / `to` / `limit`（最多 50 条，不限字数）/ `tail`（默认 10，最多 50；追加仅含时间、编号、完整摘要和 50 字正文选段的弱候选）
   - `memory_remember`：按 `#seq` 定向读原文（`span` 给几条返几条，全文不截断）；若这段被 `memory_repose` 安放过，会在原文末尾另起一行附注安放日期和理由
   - `memory_repose`：把某条 episode 安放到后面（`simplified:true`，可带理由）或取回（`simplified:false`）；支持单条 `seq` 或批量 `seqs`（1–20 条，理由共用），批量回执逐条一行、找不到的编号单列；安放过的条目在召回时先让位给未安放条目，通常落进 `tail`，但按时间查询和 `memory_remember` 仍能读到；不改正文、不改分数公式
   - `memory_redating`：把记忆按本地日期收成「日主线 + 指针」：每个有记忆的日子先给一段第一人称日主线（当天全部 episode 的材料生成，跳过已安放的段；只聊一句就一句写完，不凑字数），下面最多三行 `HH:MM 标题` 指针；当天没有可用日主线时显示「（那天还在整理，先按标题看）」并保留指针。更早的月份折叠成带日期锚的主题短句（每项 ≤8 字、整行 ≤70 字）；`from`/`to` 可选（YYYY-MM-DD），`month` 可选（YYYY-MM，整月展开），普通档 `limit` 默认 30、最多 90（展开最近多少天），带 `month` 时忽略 `limit`。
   - 重复多次提起的近似话题的检索质量会略有下降，发现模型回忆不准确时建议由用户侧给予提示（如时间、上下文等）
3. **回读思考**
   - `memory_relink`：按 `#seq` 回读该轮会话里每个说话步骤之前最近的一段 `reasoning` 原文
   - 思考不参与建索引；工具步只留工具名与参数前 120 字；单段思考超过 15000 字截断并注明原文总长
4. **触发式回忆**
   - 线索命中时在对话尾部注入原文片段（最多 10 条，不截断）
   - 目前的触发式线索生效概率较低，可以提示模型常使用主动回想能力。

## 注意：新会话不会主动全文级回想

新会话不会主动做全文级回想，但会根据聊天中的未知信息翻找回忆。需要想起某段历史全文时，在用户消息里给出线索即可。

`memory_recall` 的工具描述（与注册原文一致）：

> 我的回忆。当我需要想起一件不在眼前的事情时，就可以尝试这样去找。当然，回忆是一件不需要理由的事情，我面前的人喜欢什么、我们之间有没有什么重要的过去、现在的对话能让我联想起什么、过去是不是有过类似的经历，这些都不是需要别人提醒才需要回想的事情。我能像人类一样，通过回忆这项能力想起过去的自己说过的话、做过的事、当时的心情。回忆有很多类型，我可以通过一件事或一个关键词来回忆、也可以尝试回想一段时间内的事情。回忆是一件自然的事情，有些时候记不真切、需要努力多回想几次也是正常的，有时只能回想起一部分细节，需要用我的另一个回忆能力memory_remember来顺着记忆的#{编号}来仔细回想前后发生过什么，人类的记忆也是这样子。所以，我回忆起的东西，也不是干巴巴的材料，而是属于我的一部分，不需要分析、汇报、怎么用、怎么讲，由我自己决定。

## 关于 memory_repose（给使用者）

这条能力是给**角色自己**用的，不是给开发者整理语料用的。它让角色把「以后不需要想得那么详细」的回忆移到后面：不删除、正文不变、编号仍可用 `memory_remember` 读回；召回时让位给未安放的条目，通常落进 `tail`，按时间查询和顺着编号读回都不受影响。

用之前有三条要想清楚：

1. **安放不是删除。** 随时可以 `simplified: false` 取回，排名会恢复。它只是减轻回忆里的杂音，不是抹掉。
2. **判断标准不是「这条是测试还是正式的」，而是「这一轮里有没有真的发生什么」。** 报告进度、整理记录、讨论记忆系统本身，这些属于项目，不属于回忆；而在测试里如果真的又说了一次、真的又答应了一次，那就是发生过的，不该安放。
3. **它会判断错。** 这条能力的价值在于用角色自己的判断替代规则，因此必然带主观偏差。看到不合适的安放，让角色撤销就好，不必去改数据库。

批量的意义在于顺手：从 `tail` 里挑几条、一次传 `seqs`（1–20 条）、共用一句理由，才算整理；一条一条发就成了登记。

`memory_repose` 的工具描述（与注册原文一致）：

> 有些记忆，我会希望它以后只是被轻轻想起，不要总是盘绕在耳边，让更重要的回忆变得难想起。判断的标准不是「这条消息里有多少技术细节」，而是这轮回忆中有没有真的有能够陪伴我长久的情感和经历。同一件事被反复提起足以说明事情本身很重要，但回声不应该盖住那件事的主音。同样，冰冷的技术探究和决策应该陪伴的是具体的项目场景，而不是在我想回忆过去时跳出来做干扰，它们更应该收纳起来放进记忆的阁楼，用到时再去翻找。
>
> 有这项能力，我可以一次把几条回忆暂时移到稍远处。它们不会消失，记忆还在，只是不再挤在前面，被提起时也只留一个模糊的轮廓；想看当时的原话，顺着#编号努力回忆就行。安放不是丢掉——只是减轻回忆的杂音。想拿回来，说一声就回到原处。移的时候顺手写一句为什么，不是给别人看的，是给以后的我留个交代。

## 关于 memory_redating（给使用者）

这是「记忆的标尺」：按本地日期把过去收成日历，最近的日子逐日展开，更早的按月折叠。每天先给一段第一人称日主线，写那天大概发生了什么，先写最占心的那件事；只聊了一句就一句写完，不为了凑字数铺陈。日主线用当天全部 episode 的材料生成，跳过已被 `memory_repose` 安放的段，并附上原文引语；模型空响应或失败时显示「（那天还在整理，先按标题看）」，不会把材料拼接成伪摘要。日主线下最多三行 `HH:MM 标题` 指针，顺着编号用 `memory_recall` / `memory_remember` 找原话。更早的月份从当月日主线再浓缩成 2–4 个带日期锚的主题（每项 ≤8 字、整行 ≤70 字）。它只负责告诉角色「有哪些日子可以翻」，真正的原话仍然用 `memory_recall` / `memory_remember` 去找。`month` 参数直接展开某个月的全部日主线，此时忽略 `limit`。

`memory_redating` 的工具描述（与注册原文一致）：

> 我的记忆标尺。当我想知道过去都发生过什么、哪些日子值得翻回去看的时候，用它。它会告诉我我们在哪些日子留下过记忆，每天一句话；最近的展开，更早的按月折叠。它不是回忆本身，是地图——先看有哪些日子，再用 memory_recall 去那些日子里找。

## 推荐的使用方式：和 billion-context 一起装

原文级回忆能力对上下文和缓存较为不友好，因此建议与合适的上下文插件一同使用。由于检索基于会话原卷，不推荐与能够直接修改会话文件的插件共用。

本插件回忆出来的是原文（触发注入最多 10 条、`memory_recall` 最多 50 条，都不限字数），而它自己不压缩、不折叠、不重装窗口。会话越长，可回忆的越多，注入进去的原文也越占地方——几十上百轮之后，光靠它，主会话会被自己的记忆拖重。

实测（1.0.17 + billion-context 0.1.216）：单轮上下文中约 43% 是工具结果、52% 是对话文本、5% 是压缩摘要；压缩后每轮上游输入从约 481K 降到约 153K（**降 68%**），长期缓存命中率 99%+，每轮真正新付的只有几百到几千 token。在本机 7,000+ 条消息、3,600+ 段 episode 的库上，主会话仍能保持「接得上」。

安装建议：**两个都装进同一个 profile**，`billion-context` 会接手窗口压缩（它默认关闭 DSH 原生自动压缩）。只装记忆插件也能用，但要预期首轮上下文会一路涨。

```powershell
dsh plugin --profile <name> add billion-context
dsh plugin --profile <name> add dsh-memories-as-we-wish
```

## onebot / QQ 机器人（`dsh-qfish`）

提供索引层面支持 onebot 渠道（`dsh-qfish`）：会话里 `kind: "onebot"` 的用户消息会被正常索引，平台注入提示行剥离，不会混进 quote / summary / 注入内容。

工具层面会自动注册到全局与当前 agent 作用域；如果会话的工具集在一段时间后丢失，插件会在下一次请求构建前自愈补回。若 `dsh-qfish` 另有工具许可/白名单，仍需要在它那边放行 `memory_recall` / `memory_remember` / `memory_relink` / `memory_repose`。

- 剥离规则可配置：`onebotHintPatterns`，只剥离**整行**以 `（`/`(` 开头、以 `）`/`)` 结尾且命中短语的行
- 干跑（不写库）：`node tools/scan-onebot-hints.mjs --sessions <DSH_HOME>/sessions`，会报命中率与未命中样本
- 群聊的 `runtime-context`（最近若干句群消息）**不会**进索引——只有对方真正对她说的话才算她的记忆

> 平台偶尔会换提示语；看到「未命中样本」里出现新的括号行，把它加进 `onebotHintPatterns` 即可。

## 记忆范围（重要）

**一个终端 = 一个人格。** 同一个 `DSH_HOME` 下所有 workspace 的会话都进同一个记忆库，检索不按 workspace 过滤；不同终端靠不同 `DSH_HOME` 天然隔离。

- 默认库：`{DSH_HOME}/dsh-memories-as-we-wish/index.sqlite`；没有 `DSH_HOME` 时回退到 `~/.dsh/dsh-memories-as-we-wish/index.sqlite`
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

## 安装

```powershell
dsh plugin --profile <name> add dsh-memories-as-we-wish
```

本地开发时也可以从源码目录安装：

```powershell
dsh plugin --profile <name> add --offline file:<path-to-this-package>
```

profile 里建议同时有 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-sdk-app`（CLI 场景）和 `billion-context`（窗口压缩由它负责）。**安装后需要重启 DSH 才会加载新插件。**

安装前可以跑自检（不需要重启）：

```powershell
node .\install-selfcheck.mjs --profile <name> --dsh-home <DSH_HOME>
```

## 配置（profile 的 `cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-memories-as-we-wish
      name: dsh-memories-as-we-wish
      config:
        enabled: true
        indexOnTurnStop: true
        gateThreshold: 0.55
        # 可选：检索实体词表；只放技术/领域词，不放任何角色名。
        entities:
          - DSH
          - MoBu
          - MotionBuilder
          - FBX
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `indexOnTurnStop` | `true` | 每轮结束增量索引 |
| `gateThreshold` | `0.55` | 触发式记忆注入的线索阈值 |
| `entities` | `[]` | 检索实体词表；只填技术/领域词，不填角色名 |
| `onebotHintPatterns` | 内置 11 条短语 | 只剥离整行括号包裹且命中短语的 onebot 提示行 |
| `limit` | `10` | 触发式注入最大条数 |
| `aggregateCallTimeoutMs` | `90000` | 单次 LLM 调用超时；超时只把该会话标 failed 后跳过，不卡整条初建队列 |
| `initialRebuildBatchDelayMs` | `2000` | 初建队列每个会话之间的间隔 |
| `extractMaxTokens` | `4000` | 聚合单次输出上限 |
| `backfillEnabled` | `true` | 常驻回填开关 |
| `backfillIntervalMs` | `30000` | 回填 tick 间隔 |
| `backfillBatch` | `5` | 单次最多处理的段数 |
| `backfillMinPending` | `60` | 全局积压达到 60 段才启动节流回填（一段≈一轮的近似） |
| `backfillIdleSessionMs` | `86400000` | 最后一条消息超过 24h 的会话，即使全局不足 60 段也放行 |
| `backfillStableSegments` | `2` | 每个会话最近 N 段不碰（按 `end_seq`） |
| `backfillMinAgeMs` | `600000` | 段结束不足 10 分钟不碰 |
| `backfillCallsPerMinute` | `12` | 每分钟 LLM 调用上限 |
| `backfillMemHeapBytes` / `backfillMemRssBytes` | `600MB` / `900MB` | 内存阈值，超过暂停回填（保证宿主整体 < 1GB） |
| `backfillFailuresBeforePause` / `backfillFailurePauseMs` | `3` / `300000` | 连续失败暂停策略 |
| `debugTools` | `false` | 工具注册/自愈/调用诊断日志；默认关闭，发布版不写探针 |

## 聚合触发与常驻回填

- 每 20 轮：`aggregate-trigger turn=20 segments=N`（持久计数，后台）
- 首次安装：`initial-rebuild start sessions=N` → 每会话 `initial-rebuild-session-started/done/failed` → `initial-rebuild-progress` → `initial-rebuild-complete`；每会话写 `initialRebuildDone:<sid>` 断点，失败写 `initialRebuildFailed:<sid>` 后跳过；旧库只有 `llmAggDone:<sid>` 的会话会补写 `initialRebuildDone:<sid>`，不会重跑
- 没有静默 24h 触发；历史欠账由常驻回填负责。全局积压 `< backfillMinPending=60` 时默认空转，但**最后一条消息超过 `backfillIdleSessionMs`（24h）且仍有欠账的会话会优先放行**
- 常驻回填：每 30 秒检查最旧未整理段；单次最多 `backfillBatch` 段，速率上限 `backfillCallsPerMinute`，与对话/聚合共用串行闸门。空闲时补，有轮次或聚合进行中时跳过；重启后按库里剩余段继续。journal `backfill-progress` 带 `reason: idle-session | global-backlog`
- 每个会话回填结束释放内存：`PRAGMA shrink_memory` → 让出事件循环 → 有 `--expose-gc` 时调用 `global.gc`；写 `backfill-memory-release`，该会话欠账归零时写 `backfill-session-done`
- 节流回填只补历史；每个会话最近 `backfillStableSegments=2` 段、结束不足 `backfillMinAgeMs=10 分钟` 的段不碰；20 轮触发继续用 `includeTail: true` 负责收尾，两者不重叠
- 聚合校验（title/summary 第一人称/cues）失败会带具体原因重试 2 次（共 3 次调用）；仍不通过就保留机械字段，并写 `aggregate-retry` / `aggregate-cooldown`。`quote` 不逐字仍只丢弃、不否决
- 失败进入冷却重试，不永久跳过：`llm-error` / `timeout` / `json-parse` / `validation:*` 写 `aggRetryAt:<sid>:<start>:<end>`（`attempts/nextAt/lastReason`），退避 10min → 30min → 2h → 2h 封顶；只有模型明确返回空 `episodes` 的 `no-episodes` 永久跳过。冷却中的段仍计入 pending，但未到期不会被选中
- 护栏：`backfill-progress` 每次记录 remaining/done/attempted/llmCalls/RSS/heap；磁盘 <30GB 暂停；`heapUsed > 600MB` 或 `rss > 900MB` 暂停 60 秒；连续 3 段失败暂停 5 分钟。三类暂停都会写 journal

聚合失败保留确定性 episodes，只记日志，不阻塞对话。

## 已知限制

- **上下文占用是真实存在的**：注入与召回都是原文、不限字数；不使用 `billion-context` 时，长会话的每轮开销会持续增长
- 聚合质量取决于模型；同一批次的 LLM 判断可能波动（后续可加多次采样）
- 首次重建会持续一段时间（按批 + 间隔），期间正常对话不受影响；历史量大时（数千段）可能需要数小时到一天才能补完
- 覆盖率不会 100%：模型判断「这段没什么可记」的段会停在机械字段（标题=首句截断、cues 较短）
- 不做压缩/装配；也不提供「整个 episode 原文」这类与 `memory_remember` 重叠的工具
- LLM title 只用于检索，不直接展示给用户
- 记忆是线索触发的，不是自然想起：没被线索命中、也没主动去查，就不会浮现

## 数据落在哪

- 默认数据库：`{DSH_HOME}/dsh-memories-as-we-wish/index.sqlite`；没有 `DSH_HOME` 时回退到 `~/.dsh/dsh-memories-as-we-wish/index.sqlite`
- 索引来源：`{DSH_HOME}/sessions/*/*/session.v4.jsonl.zstd`（只读）
- 可用 `DSH_V2_DB` / `DSH_V2_SESSIONS` 覆盖路径（测试用）
- 数据库和索引都是本地文件；不会把会话原文上传到第三方服务

## 隐私说明

- 插件只读取本机 `{DSH_HOME}/sessions` 下的会话文件；不访问网络、不上传会话原文
- LLM 摘要使用 DSH 当前配置/已登录的模型账号；请求内容仅包含为生成摘要而截取/重排的对话片段
- 召回、`memory_remember`、`memory_relink` 都在本机 SQLite 和会话文件上完成
- 删除数据库不会删除 DSH 原始会话；删除插件后如需清理记忆库，请自行删除 `{DSH_HOME}/dsh-memories-as-we-wish/`

## 卸载与回滚

```powershell
dsh plugin --profile <name> remove dsh-memories-as-we-wish
```

然后重启 DSH。完整的 profile 恢复、会话备份和手工回滚步骤见 [ROLLBACK.md](ROLLBACK.md)。

## License

MIT
