# ROLLBACK — 移除 memory 插件

> 适用于任意 DSH 安装。先按下面第 0 节设置占位符，再执行命令。
> 回滚会改变插件集合；**不要在 GUI 正在运行时直接改 profile**，先正常退出应用。

## 0. 先设置路径

把 `<...>` 替换成你本机的实际值：

```powershell
$DSH_HOME       = '<DSH_HOME>'        # 例如 C:\Users\<you>\.dsh
$PROFILE_NAME   = '<profile>'         # 例如 desktop
$PROFILE        = Join-Path $DSH_HOME "profiles\$PROFILE_NAME"
$APP_EXE        = '<DeepSeek Harness.exe 的完整路径>'
$CLI            = Join-Path (Split-Path $APP_EXE) 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$PROFILE_BACKUP = '<profile 元数据备份目录>'
$SESSION_BACKUP = '<会话备份目录，可选>'

Get-Content -LiteralPath (Join-Path $PROFILE 'package.json') -Raw -Encoding UTF8
```

确认备份存在（若没有备份，跳过对应恢复步骤，不要伪造备份）：

```powershell
Test-Path (Join-Path $PROFILE_BACKUP 'package.json')
Test-Path (Join-Path $SESSION_BACKUP 'sessions')
```

---

## 1. 正常回滚（推荐，先退出 GUI）

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = $DSH_HOME
$env:CI = '1'

& $APP_EXE --expose-internals $CLI plugin --profile $PROFILE_NAME remove dsh-memories-as-we-wish
& $APP_EXE --expose-internals $CLI plugin --profile $PROFILE_NAME remove billion-context
```

### 1.1 重启并验证

正常关闭 / 重新打开 DSH，然后确认：

1. 工具列表**不再**出现 `memory_recall` / `memory_remember` / `memory_relink`；
2. `billion-context` 的原生压缩门不再加载，DSH 原生 compaction 恢复；
3. 最新会话能打开、能发消息；
4. 若 CLI 报 `profile "<profile>" is managed exclusively...`，改走第 2 节。

---

## 2. 手工回滚（CLI 不适用时）

> 仅在上一步失败或 CLI 拒绝管理该 profile 时使用。先退出 GUI。

### 2.1 恢复 profile 元数据

```powershell
Copy-Item -LiteralPath (Join-Path $PROFILE_BACKUP 'package.json')     -Destination (Join-Path $PROFILE 'package.json')     -Force
Copy-Item -LiteralPath (Join-Path $PROFILE_BACKUP 'cordis.patch.yml') -Destination (Join-Path $PROFILE 'cordis.patch.yml') -Force
Copy-Item -LiteralPath (Join-Path $PROFILE_BACKUP 'pnpm-lock.yaml')   -Destination (Join-Path $PROFILE 'pnpm-lock.yaml')   -Force
```

备份的 `package.json` 不含 `dsh-memories-as-we-wish` / `billion-context` 的 dependency 和 bundle，恢复后即回到安装前配置。`node_modules` 里残留的包不会被加载，可保留；若要清理，先核对绝对路径再删：

```powershell
$nm = Join-Path $PROFILE 'node_modules'
Test-Path (Join-Path $nm 'dsh-memories-as-we-wish')
Test-Path (Join-Path $nm 'billion-context')
# 可选：Remove-Item -LiteralPath (Join-Path $nm 'dsh-memories-as-we-wish') -Recurse -Force
# 可选：Remove-Item -LiteralPath (Join-Path $nm 'billion-context') -Recurse -Force
```

### 2.2 重启

正常重新打开 DSH，按第 1.1 节验证。

---

## 3. 会话文件恢复（只有确认会话损坏时）

> 先退出 GUI。会话恢复会覆盖现有会话文件，**先备份当前 sessions**。

```powershell
$live = Join-Path $DSH_HOME 'sessions'
$now  = Join-Path $DSH_HOME ('backups\sessions-before-rollback-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

New-Item -ItemType Directory -Path $now -Force | Out-Null
Copy-Item -LiteralPath $live -Destination $now -Recurse -Force
Copy-Item -LiteralPath (Join-Path $SESSION_BACKUP 'sessions\*') -Destination $live -Recurse -Force
```

如果只想恢复**某个**会话，先定位备份中的文件：

```powershell
Get-ChildItem -LiteralPath (Join-Path $SESSION_BACKUP 'sessions') -Recurse -Filter 'session.v4.jsonl.zstd' |
  Select-Object FullName
```

然后复制对应文件到 live 的同相对路径（`<project-dir>\<session-id>\session.v4.jsonl.zstd`），不要整目录覆盖。

恢复完成后重启，先打开一个测试会话确认能读取，再打开正在使用的会话。

---

## 4. 生效时机（重要）

- 插件安装/移除只改磁盘上的 profile 配置与包；**运行中的 Electron 进程仍持有旧的内存中插件集合**。
- 两个插件都在**重启后**才稳定生效；`billion-context` 关闭 DSH 原生压缩也只在重启后生效。
- 不要在未获许可时重启正在使用的 DSH 实例，也不要清空 sessions 或数据库。

## 5. 最小回滚验收

- [ ] 工具列表无 `memory_recall` / `memory_remember` / `memory_relink`
- [ ] 启动日志无 `dsh-memories-as-we-wish` / `billion-context` 加载错误
- [ ] 最新会话可打开、可继续对话
- [ ] 原生 compaction 恢复（若同时移除了 billion-context）
