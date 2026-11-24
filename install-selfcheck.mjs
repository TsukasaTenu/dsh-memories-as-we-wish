#!/usr/bin/env node
/**
 * install-selfcheck.mjs
 *
 * A/B self-check for a DSH memory-plugin installation.
 * A = before install (source integrity, manifest, entry import, deps)
 * B = after install, before restart (profile manifest, composed config, installed hash, isolated combo)
 *
 * This script is read-only with respect to the target profile.  For a profile
 * managed by the Electron desktop host, `dsh --dump-config` refuses to run
 * directly ("managed exclusively by the Electron application"), so the script
 * validates the exact same package.json + cordis patch layers in a throw-away
 * profile that shares the real node_modules through a junction.
 *
 * Usage:
 *   node install-selfcheck.mjs
 *   node install-selfcheck.mjs --profile desktop --dsh-home <DSH_HOME>
 *   node install-selfcheck.mjs --isolated-home <ISOLATED_DSH_HOME>
 *   node install-selfcheck.mjs --json
 *
 * Exit code 0 = every automated A/B check is PASS (WARN is allowed).
 * Exit code 1 = at least one FAIL.
 */

import { createHash } from 'node:crypto'
import {
  readFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync,
  symlinkSync, unlinkSync, rmSync, lstatSync
} from 'node:fs'
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import os from 'node:os'

const SCRIPT = fileURLToPath(import.meta.url)
const SOURCE = resolve(dirname(SCRIPT))
const TOOLING = new Set(['install-selfcheck.mjs', 'ROLLBACK.md', '.gitignore'])
const isTooling = (f) => TOOLING.has(f) || f.startsWith('test/') || f.startsWith('tools/')

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') { out.json = true; continue }
    if (a === '--help' || a === '-h') { out.help = true; continue }
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1]
      if (val === undefined || val.startsWith('--')) throw new Error(`missing value for ${a}`)
      out[key] = val
      i++
      continue
    }
    throw new Error(`unknown argument: ${a}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('Usage: node install-selfcheck.mjs [--profile desktop] [--dsh-home DIR] [--source DIR]')
  console.log('       [--session-backup DIR] [--profile-backup DIR] [--isolated-home DIR]')
  console.log('       [--isolated-profile mem] [--app-exe EXE] [--cli CLI] [--json]')
  process.exit(0)
}

const DSH_HOME = resolve(args['dsh-home'] || process.env.DSH_HOME || join(os.homedir(), '.dsh'))
const PROFILE = args.profile || 'desktop'
const APP_EXE = args['app-exe'] || process.env.DSH_APP_EXE ||
  (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe') : '')
const CLI = args.cli || (APP_EXE ? join(dirname(APP_EXE), 'resources', 'app.asar', 'dsh', 'node_modules',
  '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js') : '')
const NODE = process.execPath

const results = []
function record (id, title, status, detail) {
  results.push({ id, title, status, detail: detail ?? '' })
}

function fmt (v) { return String(v).replace(/\r?\n/g, ' ') }

function statusLine (r) {
  const mark = r.status === 'PASS' ? '[PASS]' : r.status === 'FAIL' ? '[FAIL]' : r.status === 'WARN' ? '[WARN]' : '[INFO]'
  return `${mark} ${r.id} ${r.title}${r.detail ? ' — ' + r.detail : ''}`
}

function walkFiles (root, rel = '', acc = []) {
  const abs = rel ? join(root, rel) : root
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name === '.git' || name === '.plugin-manager') continue
    const r = rel ? join(rel, name) : name
    const stat = statSync(join(root, r))
    if (stat.isDirectory()) walkFiles(root, r, acc)
    else acc.push(r.replaceAll(sep, '/'))
  }
  return acc
}

function sha256File (path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function hashTree (root, { excludeTooling = false } = {}) {
  const files = walkFiles(root)
    .filter(f => !(excludeTooling && isTooling(f)))
    .sort()
  const entries = files.map(f => [f, sha256File(join(root, f))])
  const digest = createHash('sha256')
  for (const [f, h] of entries) digest.update(f + '\0' + h + '\0')
  return { files: entries, digest: digest.digest('hex') }
}

function listDirs (path) {
  try { return readdirSync(path, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return [] }
}

function findLatestProfileBackup () {
  const root = join(DSH_HOME, 'backups')
  const candidates = listDirs(root).filter(n => n.startsWith('desktop-before-memories-')).sort().reverse()
  return candidates.length ? join(root, candidates[0]) : null
}

function countFiles (root) {
  if (!existsSync(root)) return 0
  let n = 0
  for (const f of walkFiles(root)) { void f; n++ }
  return n
}

function cliEnv (home) {
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, CI: '1' }
}

function runCli (cliArgs, home) {
  if (!APP_EXE || !CLI) {
    return { status: null, stdout: '', stderr: 'DeepSeek Harness app not found; pass --app-exe or set DSH_APP_EXE' }
  }
  return spawnSync(APP_EXE, ['--expose-internals', CLI, ...cliArgs], {
    env: cliEnv(home),
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  })
}

function removeTempProfile (dir) {
  const link = join(dir, 'node_modules')
  try {
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link)
    else rmSync(link, { recursive: true, force: true })
  } catch {}
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

/** Validate a profile's composed config. Falls back to a temporary clone when
 *  the profile is managed by the Electron app (desktop). Read-only on the real
 *  profile. */
function dumpProfileConfig (profile, home) {
  const direct = runCli(['--profile', profile, '--dump-config'], home)
  const directOut = String(direct.stdout || '')
  const directErr = String(direct.stderr || '')
  if (direct.status === 0 && directOut.trim()) {
    return { ok: true, method: 'direct', exit: direct.status, out: directOut, err: directErr, temp: null }
  }

  const profileDir = join(home, 'profiles', profile)
  const nodeModules = join(profileDir, 'node_modules')
  if (!existsSync(join(profileDir, 'package.json')) || !existsSync(nodeModules)) {
    return { ok: false, method: 'direct', exit: direct.status, out: directOut, err: directErr || 'profile package.json/node_modules missing', temp: null }
  }

  const tmpName = `selfcheck-${process.pid}-${Date.now().toString(36)}`
  const tmpDir = join(home, 'profiles', tmpName)
  try {
    mkdirSync(tmpDir, { recursive: true })
    for (const f of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      const src = join(profileDir, f)
      if (existsSync(src)) copyFileSync(src, join(tmpDir, f))
    }
    symlinkSync(nodeModules, join(tmpDir, 'node_modules'), 'junction')
    const r = runCli(['--profile', tmpName, '--dump-config'], home)
    const out = String(r.stdout || '')
    const err = String(r.stderr || '')
    const ok = r.status === 0 && out.trim().length > 0
    return {
      ok,
      method: 'temp-clone',
      exit: r.status,
      out,
      err,
      temp: tmpDir,
      directBlocked: /managed exclusively|Electron application/i.test(directErr)
    }
  } catch (e) {
    return { ok: false, method: 'temp-clone', exit: null, out: '', err: e.message, temp: tmpDir }
  } finally {
    // Deliberately do NOT delete in the success path before caller inspects? we return
    // data only; cleanup is safe here because out/err are already strings.
    removeTempProfile(tmpDir)
  }
}

// ---------------------------------------------------------------------------
// A. pre-install checks
// ---------------------------------------------------------------------------
const pkgPath = join(SOURCE, 'package.json')
let pkg = null
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  record('A3', 'package.json 可解析', 'PASS', `${pkg.name}@${pkg.version}`)
} catch (e) {
  record('A3', 'package.json 可解析', 'FAIL', e.message)
}

const pluginName = pkg?.name || 'dsh-memories-as-we-wish'
const patchRel = pkg?.dsh?.bundle?.patch || pkg?.['dsh.bundle.patch']
let patchPath = null
if (patchRel) {
  patchPath = isAbsolute(patchRel) ? patchRel : resolve(SOURCE, patchRel)
  if (existsSync(patchPath)) {
    const patchText = readFileSync(patchPath, 'utf8')
    const mentions = patchText.includes(`id: ${pluginName}`) || patchText.includes(`name: ${pluginName}`)
    record('A3b', 'bundle patch 文件存在且指向本插件', mentions ? 'PASS' : 'WARN',
      `${relative(SOURCE, patchPath)}${mentions ? '' : '（未找到插件 id/name）'}`)
  } else {
    record('A3b', 'bundle patch 文件存在', 'FAIL', `${patchPath} 不存在`)
  }
} else {
  record('A3b', 'bundle patch 文件存在', 'FAIL', 'package.json 无 dsh.bundle.patch')
}

// A2: source hash (tooling files such as this script are not part of the installed package)
let sourceHash = null
try {
  sourceHash = hashTree(SOURCE, { excludeTooling: true })
  record('A2', '插件源目录 hash', 'PASS', `${sourceHash.files.length} files, sha256=${sourceHash.digest.slice(0, 16)}…`)
} catch (e) {
  record('A2', '插件源目录 hash', 'FAIL', e.message)
}

// A4: entry import
try {
  const entryRel = (typeof pkg?.exports?.['.'] === 'string' ? pkg.exports['.'] : pkg?.main) || 'index.js'
  const entry = resolve(SOURCE, entryRel)
  const mod = await import(pathToFileURL(entry).href)
  const keys = Object.keys(mod).sort()
  record('A4', '入口可 import', keys.includes('apply') ? 'PASS' : 'FAIL',
    `${entryRel} exports=${keys.join(',')}`)
} catch (e) {
  record('A4', '入口可 import', 'FAIL', e.message)
}

// A5: local dependency closure (and bare imports that do not resolve)
try {
  const jsFiles = walkFiles(SOURCE).filter(f => f.endsWith('.js'))
  const missing = []
  const bare = []
  const seen = new Set()
  const re = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g
  for (const rel of jsFiles) {
    const abs = join(SOURCE, rel)
    const text = readFileSync(abs, 'utf8')
    let m
    while ((m = re.exec(text))) {
      const spec = m[1]
      if (spec.startsWith('node:')) continue
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = resolve(dirname(abs), spec)
        if (!existsSync(target)) missing.push(`${rel} -> ${spec}`)
      } else {
        bare.push(`${rel} -> ${spec}`)
      }
    }
    seen.add(rel)
  }
  record('A5', '依赖无缺失', missing.length === 0 && bare.length === 0 ? 'PASS' : 'FAIL',
    missing.length || bare.length ? `missing=${missing.join('; ')} bare=${bare.join('; ')}` : `${seen.size} js files, only node:/relative imports`)
} catch (e) {
  record('A5', '依赖无缺失', 'FAIL', e.message)
}

// A1: backups
const sessionBackup = args['session-backup'] || process.env.DSH_SESSION_BACKUP ||
  join(dirname(SOURCE), '_backup', 'sessions-2026-11-23-2100')
const profileBackup = args['profile-backup'] || findLatestProfileBackup()
try {
  const sessionOk = existsSync(sessionBackup) && existsSync(join(sessionBackup, 'sessions')) && countFiles(join(sessionBackup, 'sessions')) > 0
  const profileOk = profileBackup && ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'].every(f => existsSync(join(profileBackup, f)))
  const detail = `session=${sessionOk ? sessionBackup : '缺失'} profile=${profileOk ? profileBackup : '缺失'}`
  record('A1', '装前备份存在', sessionOk && profileOk ? 'PASS' : 'FAIL', detail)
} catch (e) {
  record('A1', '装前备份存在', 'FAIL', e.message)
}

// ---------------------------------------------------------------------------
// B. post-install / pre-restart checks
// ---------------------------------------------------------------------------
const profileDir = join(DSH_HOME, 'profiles', PROFILE)
const profilePkgPath = join(profileDir, 'package.json')
let profilePkg = null
let installedDir = null
try {
  profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
  installedDir = join(profileDir, 'node_modules', pluginName)
  const dep = profilePkg.dependencies?.[pluginName]
  const bundles = profilePkg.dsh?.profile?.bundles || []
  const hasBundle = bundles.includes(pluginName)
  const installed = existsSync(installedDir)
  const instPkg = installed ? JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')) : null
  const ok = Boolean(dep) && hasBundle && installed && instPkg?.name === pluginName
  record('B1', 'profile 有插件条目/bundle', ok ? 'PASS' : 'FAIL',
    `dependency=${dep || 'MISSING'} bundle=${hasBundle} installed=${installed} version=${instPkg?.version || '-'}`)
} catch (e) {
  record('B1', 'profile 有插件条目/bundle', 'FAIL', e.message)
}

// B2: composed config must parse (equivalent for managed desktop profile)
let dump = null
try {
  dump = dumpProfileConfig(PROFILE, DSH_HOME)
  const out = dump.out || ''
  const hasOurs = out.includes(`# == ${pluginName}`) || new RegExp(`- id:\\s*${pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(out)
  const hasBillion = out.includes('# == billion-context') && /^\s*name:\s*billion-context(?:\/|$)/m.test(out)
  const hasGateConfig = out.includes('gateThreshold: 0.55') && out.includes('enabled: true')
  const err = String(dump.err || '').trim()
  // desktop 组合必须带 billion-context；隔离 lab 只验证记忆插件本身。
  const needsBillion = PROFILE === 'desktop'
  const ok = dump.ok && hasOurs && (!needsBillion || hasBillion) && !/^\s*error:/im.test(err)
  record('B2', 'profile 配置可解析', ok ? 'PASS' : 'FAIL',
    `exit=${dump.exit} method=${dump.method} lines=${out.split(/\r?\n/).length} ours=${hasOurs} billion=${hasBillion}${needsBillion ? '' : '（本 profile 不要求）'} gateConfig=${hasGateConfig}${err ? ' err=' + fmt(err).slice(0, 160) : ''}`)
} catch (e) {
  record('B2', 'profile 配置可解析', 'FAIL', e.message)
}

// B3: installed files = source files
try {
  if (!sourceHash) throw new Error('source hash unavailable')
  const installedHash = hashTree(installedDir, { excludeTooling: true })
  const srcMap = new Map(sourceHash.files)
  const insMap = new Map(installedHash.files)
  const missing = [...srcMap.keys()].filter(f => !insMap.has(f))
  const mismatch = [...srcMap.keys()].filter(f => insMap.has(f) && srcMap.get(f) !== insMap.get(f))
  const extra = [...insMap.keys()].filter(f => !srcMap.has(f))
  const ok = missing.length === 0 && mismatch.length === 0
  record('B3', '已装文件 hash = 源', ok ? 'PASS' : 'FAIL',
    `files=${installedHash.files.length} missing=${missing.length} mismatch=${mismatch.length} extra=${extra.length}${missing.length ? ' missing=' + missing.join(',') : ''}${mismatch.length ? ' mismatch=' + mismatch.join(',') : ''}`)
} catch (e) {
  record('B3', '已装文件 hash = 源', 'FAIL', e.message)
}

// B4: isolated same-combination check (configuration + installed hash; the real
// model turn is covered by the isolated COMBO-20 evidence, not re-run here)
const isolatedHome = args['isolated-home'] || process.env.DSH_ISOLATED_HOME ||
  join(dirname(SOURCE), 'memory-test', 'eval', 'memories-lab', '.dsh-home')
const isolatedProfile = args['isolated-profile'] || 'mem'
try {
  const isoDir = join(isolatedHome, 'profiles', isolatedProfile)
  const isoInstalled = join(isoDir, 'node_modules', pluginName)
  const isoPkg = JSON.parse(readFileSync(join(isoDir, 'package.json'), 'utf8'))
  const isoHasBundle = (isoPkg.dsh?.profile?.bundles || []).includes(pluginName)
  const isoHash = hashTree(isoInstalled, { excludeTooling: true })
  const srcMap = new Map(sourceHash?.files || [])
  const insMap = new Map(isoHash.files)
  const isoMismatch = [...srcMap.keys()].filter(f => insMap.get(f) !== srcMap.get(f)).length
  const isoDump = dumpProfileConfig(isolatedProfile, isolatedHome)
  const hasOurs = (isoDump.out || '').includes(`# == ${pluginName}`)
  const ok = isoHasBundle && isoMismatch === 0 && isoDump.ok && hasOurs
  record('B4', '隔离环境同组合可解析', ok ? 'PASS' : 'FAIL',
    `${isoDir} bundle=${isoHasBundle} hashMismatch=${isoMismatch} dump=${isoDump.ok ? 'ok/' + isoDump.method : 'FAIL'} ours=${hasOurs}（完整对话证据见 COMBO-20-RESULTS.json，本脚本不发模型请求）`)
} catch (e) {
  record('B4', '隔离环境同组合可解析', 'FAIL', `${e.message}（可用 --isolated-home 指定；若尚未建隔离环境需先补跑）`)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const fail = results.filter(r => r.status === 'FAIL')
const pass = results.filter(r => r.status === 'PASS')
const warn = results.filter(r => r.status === 'WARN')

if (args.json) {
  console.log(JSON.stringify({
    source: SOURCE,
    dshHome: DSH_HOME,
    profile: PROFILE,
    ok: fail.length === 0,
    counts: { pass: pass.length, fail: fail.length, warn: warn.length },
    results,
    cChecklist: [
      'C1 打开最新会话，能读取且无解压失败',
      'C2 插件日志出现“已启用/loaded”',
      'C3 工具列表出现 memory_recall / memory_remember / memory_relink',
      'C4 发一条消息能收到回复（turn/end）'
    ]
  }, null, 2))
  process.exitCode = fail.length ? 1 : 0
} else {
  const groups = [
    ['A. 装前（已备份）', results.filter(r => r.id.startsWith('A'))],
    ['B. 装后、重启前', results.filter(r => r.id.startsWith('B'))]
  ]
  console.log('DSH memory plugin install self-check')
  console.log(`source  = ${SOURCE}`)
  console.log(`profile = ${PROFILE} @ ${DSH_HOME}`)
  console.log('')
  for (const [title, rows] of groups) {
    console.log(title)
    for (const r of rows) console.log('  ' + statusLine(r))
    console.log('')
  }
  console.log('C. 重启后（人工验证，脚本不能代替）')
  console.log('  C1 打开最新会话，能读取且无解压失败')
  console.log('  C2 插件日志出现“已启用/loaded”')
  console.log('  C3 工具列表出现 memory_recall / memory_remember / memory_relink')
  console.log('  C4 发一条消息能收到回复（turn/end）')
  console.log('')
  console.log('D. 回滚（重启前先看 ROLLBACK.md，不要直接在运行中的进程上改）')
  console.log(`  dsh plugin --profile ${PROFILE} remove ${pluginName}`)
  console.log(`  dsh plugin --profile ${PROFILE} remove billion-context`)
  console.log('')
  console.log(`RESULT: ${fail.length ? 'FAIL' : 'PASS'}  pass=${pass.length} fail=${fail.length} warn=${warn.length}`)
  if (fail.length) console.log('FAILED: ' + fail.map(r => r.id).join(', '))
  process.exitCode = fail.length ? 1 : 0
}
