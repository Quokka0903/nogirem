import { execFile, spawn } from "node:child_process"
import { unlink } from "node:fs/promises"
import { promisify } from "node:util"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { writeJsonAtomic } from "./atomic-json.mjs"
import { readRuntimeStatusJson } from "./runtime-status.mjs"
import {
  queryMabinogiVerticalSync,
  setMabinogiVerticalSync,
} from "./game-graphics.mjs"

const execFileAsync = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))

function resolveHelperPath() {
  const executableRoot = root.includes("app.asar")
    ? root.replace("app.asar", "app.asar.unpacked")
    : root
  return join(
    executableRoot,
    "native",
    "radeon-helper",
    "bin",
    "radeon-helper.exe",
  )
}

export function normalizeRadeonResult(raw, gameVerticalSync = null) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.gpus) || !Array.isArray(raw.goals)) {
    throw new Error("Radeon helper가 올바르지 않은 결과를 반환했습니다")
  }
  const goalsList = raw.goals.map(goal => ({
    key: String(goal.key ?? ""),
    label: String(goal.label ?? goal.key ?? ""),
    supported: goal.supported === true,
    met: goal.supported === true && goal.met === true,
    currentValue: goal.currentValue == null ? null : String(goal.currentValue),
  }))
  const verticalSync = goalsList.find(goal => goal.key === "verticalSyncOff")
  if (verticalSync?.supported && gameVerticalSync) {
    const gameSettingOff = gameVerticalSync.available && gameVerticalSync.enabled === false
    verticalSync.met = verticalSync.met && gameSettingOff
    if (!gameSettingOff) {
      verticalSync.currentValue = `${verticalSync.currentValue ?? "드라이버 확인"} · 게임 설정 켜기`
    }
  }
  const applicableGoals = goalsList.filter(goal => goal.supported)
  const detected = raw.detected === true && raw.gpus.length > 0
  return {
    supported: process.platform === "win32" && process.arch === "x64",
    detected,
    amd: detected,
    vendor: detected ? "amd" : null,
    vendorLabel: detected ? "AMD Radeon" : null,
    title: "AMD Radeon 전역 설정",
    scope: "global",
    scopeLabel: "Radeon GPU 전역 설정",
    persistentGlobal: detected,
    reason: raw.reason == null ? null : String(raw.reason),
    gpus: raw.gpus.map(gpu => ({ name: String(gpu.name ?? "AMD Radeon GPU") })),
    gameVerticalSync,
    goalsList,
    allMet: detected
      && raw.reason == null
      && raw.allMet === true
      && applicableGoals.length > 0
      && applicableGoals.every(goal => goal.met),
  }
}

export function createRadeonManager({
  runHelper,
  queryGameVerticalSync = queryMabinogiVerticalSync,
  setGameVerticalSync = setMabinogiVerticalSync,
}) {
  async function check() {
    if (process.platform !== "win32" || process.arch !== "x64") {
      return normalizeRadeonResult({
        detected: false,
        gpus: [],
        goals: [],
        reason: "Windows x64에서만 Radeon 설정을 조회할 수 있습니다",
      })
    }
    const [raw, gameVerticalSync] = await Promise.all([
      runHelper(false),
      queryGameVerticalSync(),
    ])
    return normalizeRadeonResult(raw, gameVerticalSync)
  }

  async function apply() {
    const raw = await runHelper(true)
    if (!raw.detected) {
      throw new Error(raw.reason ?? "AMD Radeon GPU 또는 드라이버를 찾지 못했습니다")
    }
    await setGameVerticalSync(false)
    const result = normalizeRadeonResult(raw, await queryGameVerticalSync())
    if (!result.allMet) {
      const unmet = result.goalsList
        .filter(goal => goal.supported && !goal.met)
        .map(goal => goal.label)
      throw new Error(`Radeon 최적화 적용 후 검증 실패: ${unmet.join(", ") || result.reason}`)
    }
    return result
  }

  return { check, apply }
}

async function runNativeHelper(apply) {
  const helperPath = resolveHelperPath()
  try {
    return await runRadeonHelperWithFallback(
      args => execFileAsync(helperPath, args, {
        windowsHide: true,
        timeout: 30000,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      }),
      apply,
    )
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        detected: false,
        gpus: [],
        goals: [],
        reason: "Radeon 설정 helper를 찾지 못했습니다",
      }
    }
    if (error instanceof SyntaxError) {
      throw new Error("Radeon 설정 helper 응답을 해석할 수 없습니다")
    }
    throw error
  }
}

export async function runRadeonHelperWithFallback(execute, apply) {
  const argumentSets = [
    apply ? ["--apply"] : [],
    apply ? ["--legacy-driver", "--apply"] : ["--legacy-driver"],
  ]
  let initialError
  for (const args of argumentSets) {
    try {
      const { stdout } = await execute(args)
      return JSON.parse(stdout.trim())
    } catch (error) {
      if (error instanceof SyntaxError) throw error
      const recoveredOutput = String(error?.stdout ?? "").trim()
      if (recoveredOutput) {
        try {
          return JSON.parse(recoveredOutput)
        } catch {
        }
      }
      if (!initialError) {
        initialError = error
        continue
      }
      const numericCode = Number(error?.code)
      const exitCode = Number.isInteger(numericCode)
        ? `0x${(numericCode >>> 0).toString(16).padStart(8, "0").toUpperCase()}`
        : String(error?.code ?? error?.signal ?? "알 수 없음")
      throw new Error(`Radeon 설정 helper가 비정상 종료되었습니다 (종료 코드 ${exitCode})`)
    }
  }
  throw initialError
}

export const radeonDaemonCommands = ["probe", "apply", "restore", "stop"]
export const antiLagNextWarning = "antiLagNext"
export const antiLagNextRefusalMessage =
  "Radeon Anti-Lag Next가 켜져 있어 설정을 변경하지 않았습니다"

const antiLagLevels = ["antiLag", "antiLagNext"]
const verticalSyncModes = [
  "alwaysOff",
  "offUnlessAppSpecifies",
  "onUnlessAppSpecifies",
  "alwaysOn",
  "unknown",
]
const verticalSyncModeLabels = {
  alwaysOff: "항상 끄기",
  offUnlessAppSpecifies: "응용 프로그램 지정 시 켜기",
  onUnlessAppSpecifies: "응용 프로그램 지정 시 끄기",
  alwaysOn: "항상 켜기",
  unknown: "알 수 없음",
}
const daemonResults = ["ok", "refused", "error"]
const unsupportedText = "지원 안 함"
const mixedText = "GPU별 설정 다름"

function flag(value) {
  return value === true
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null
}

function memberOrNull(list, value) {
  return list.includes(value) ? value : null
}

function objectOrEmpty(value) {
  return value && typeof value === "object" ? value : {}
}

export function createRadeonControlCommand(command, { requestId = null, now = Date.now } = {}) {
  if (!radeonDaemonCommands.includes(command)) {
    throw new Error(`지원하지 않는 Radeon daemon 명령입니다: ${command}`)
  }
  const requestedAt = now()
  return {
    command,
    requestId: requestId ?? `${command}-${requestedAt}`,
    requestedAt,
  }
}

export function normalizeRadeonCapabilities(raw) {
  const source = objectOrEmpty(raw)
  const antiLag = objectOrEmpty(source.antiLag)
  const frameRateTarget = objectOrEmpty(source.frameRateTarget)
  const antiLagSupported = flag(antiLag.supported)
  const frameRateTargetSupported = flag(frameRateTarget.supported)
  return {
    verticalSync: { supported: flag(objectOrEmpty(source.verticalSync).supported) },
    enhancedSync: { supported: flag(objectOrEmpty(source.enhancedSync).supported) },
    chill: { supported: flag(objectOrEmpty(source.chill).supported) },
    antiLag: {
      supported: antiLagSupported,
      levelSupported: antiLagSupported && flag(antiLag.levelSupported),
      level: antiLagSupported ? memberOrNull(antiLagLevels, antiLag.level) : null,
    },
    frameRateTarget: {
      supported: frameRateTargetSupported,
      minFps: frameRateTargetSupported ? integerOrNull(frameRateTarget.minFps) : null,
      maxFps: frameRateTargetSupported ? integerOrNull(frameRateTarget.maxFps) : null,
    },
  }
}

export function normalizeRadeonDaemonSettings(raw) {
  const source = objectOrEmpty(raw)
  const verticalSync = objectOrEmpty(source.verticalSync)
  const enhancedSync = objectOrEmpty(source.enhancedSync)
  const chill = objectOrEmpty(source.chill)
  const antiLag = objectOrEmpty(source.antiLag)
  const frameRateTarget = objectOrEmpty(source.frameRateTarget)
  const verticalSyncSupported = flag(verticalSync.supported)
  const antiLagSupported = flag(antiLag.supported)
  const frameRateTargetSupported = flag(frameRateTarget.supported)
  return {
    verticalSync: {
      supported: verticalSyncSupported,
      mode: verticalSyncSupported ? memberOrNull(verticalSyncModes, verticalSync.mode) : null,
      mixed: verticalSyncSupported && flag(verticalSync.mixed),
    },
    enhancedSync: {
      supported: flag(enhancedSync.supported),
      enabled: flag(enhancedSync.supported) && flag(enhancedSync.enabled),
      mixed: flag(enhancedSync.supported) && flag(enhancedSync.mixed),
    },
    chill: {
      supported: flag(chill.supported),
      enabled: flag(chill.supported) && flag(chill.enabled),
      mixed: flag(chill.supported) && flag(chill.mixed),
    },
    antiLag: {
      supported: antiLagSupported,
      enabled: antiLagSupported && flag(antiLag.enabled),
      levelSupported: antiLagSupported && flag(antiLag.levelSupported),
      level: antiLagSupported ? memberOrNull(antiLagLevels, antiLag.level) : null,
      mixed: antiLagSupported && flag(antiLag.mixed),
    },
    frameRateTarget: {
      supported: frameRateTargetSupported,
      enabled: frameRateTargetSupported && flag(frameRateTarget.enabled),
      fps: frameRateTargetSupported ? integerOrNull(frameRateTarget.fps) ?? 0 : 0,
      mixed: frameRateTargetSupported && flag(frameRateTarget.mixed),
    },
  }
}

export function normalizeRadeonReceipt(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.gpus)) return null
  return {
    version: integerOrNull(raw.version) ?? 1,
    capturedAt: integerOrNull(raw.capturedAt),
    applied: flag(raw.applied),
    gpus: raw.gpus.map((gpu, index) => ({
      index: integerOrNull(objectOrEmpty(gpu).index) ?? index,
      name: String(objectOrEmpty(gpu).name ?? "AMD Radeon GPU"),
      uniqueId: integerOrNull(objectOrEmpty(gpu).uniqueId),
      before: normalizeRadeonDaemonSettings(objectOrEmpty(gpu).before),
    })),
  }
}

export function normalizeRadeonDaemonStatus(raw) {
  if (!raw || typeof raw !== "object") return null
  const gpus = Array.isArray(raw.gpus) ? raw.gpus : []
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter(warning => typeof warning === "string")
    : []
  return {
    running: flag(raw.running),
    pid: integerOrNull(raw.pid),
    mode: "daemon",
    legacyDriver: flag(raw.legacyDriver),
    detected: flag(raw.detected) && gpus.length > 0,
    gpus: gpus.map((gpu, index) => ({
      index: integerOrNull(objectOrEmpty(gpu).index) ?? index,
      name: String(objectOrEmpty(gpu).name ?? "AMD Radeon GPU"),
      uniqueId: integerOrNull(objectOrEmpty(gpu).uniqueId),
    })),
    capabilities: normalizeRadeonCapabilities(raw.capabilities),
    settings: normalizeRadeonDaemonSettings(raw.settings),
    receipt: normalizeRadeonReceipt(raw.receipt),
    warnings,
    lastCommand: memberOrNull(radeonDaemonCommands, raw.lastCommand),
    lastResult: memberOrNull(daemonResults, raw.lastResult),
    error: raw.error == null ? null : String(raw.error),
    updatedAt: integerOrNull(raw.updatedAt),
  }
}

// 안전 규칙: Anti-Lag Next는 안티치트 오탐 이력이 있어 이 앱에서는 절대 켜지
// 않는다. daemon도 같은 이유로 적용을 거부하지만, 클라이언트에서 먼저 막아
// apply 명령 자체를 보내지 않는다.
export function resolveRadeonApplyRefusal(status) {
  if (!status) return null
  if (status.warnings?.includes(antiLagNextWarning)) return antiLagNextRefusalMessage
  if (status.capabilities?.antiLag?.level === antiLagNextWarning) return antiLagNextRefusalMessage
  if (status.settings?.antiLag?.level === antiLagNextWarning) return antiLagNextRefusalMessage
  return null
}

function booleanSettingText(setting) {
  if (!setting.supported) return unsupportedText
  if (setting.mixed) return mixedText
  return setting.enabled ? "켜기" : "끄기"
}

export function radeonDaemonStatusToHelperResult(status) {
  if (!status) {
    return {
      detected: false,
      gpus: [],
      goals: [],
      allMet: false,
      reason: "Radeon 설정 daemon 상태를 읽지 못했습니다",
    }
  }
  const settings = status.settings
  const verticalSync = settings.verticalSync
  const goals = [
    {
      key: "verticalSyncOff",
      label: "수직 동기화 항상 끄기",
      supported: verticalSync.supported,
      met: verticalSync.supported && !verticalSync.mixed && verticalSync.mode === "alwaysOff",
      currentValue: verticalSync.supported
        ? (verticalSync.mixed
          ? mixedText
          : verticalSyncModeLabels[verticalSync.mode] ?? verticalSyncModeLabels.unknown)
        : unsupportedText,
    },
    {
      key: "enhancedSyncOff",
      label: "Enhanced Sync 끄기",
      supported: settings.enhancedSync.supported,
      met: settings.enhancedSync.supported
        && !settings.enhancedSync.mixed
        && !settings.enhancedSync.enabled,
      currentValue: booleanSettingText(settings.enhancedSync),
    },
    {
      key: "antiLagOn",
      label: "Radeon Anti-Lag 켜기",
      supported: settings.antiLag.supported,
      met: settings.antiLag.supported && !settings.antiLag.mixed && settings.antiLag.enabled,
      currentValue: booleanSettingText(settings.antiLag),
    },
    {
      key: "chillOff",
      label: "Radeon Chill 끄기",
      supported: settings.chill.supported,
      met: settings.chill.supported && !settings.chill.mixed && !settings.chill.enabled,
      currentValue: booleanSettingText(settings.chill),
    },
  ]
  const applicableGoals = goals.filter(goal => goal.supported)
  return {
    detected: status.detected,
    gpus: status.gpus.map(gpu => ({ name: gpu.name })),
    goals,
    allMet: status.detected
      && applicableGoals.length > 0
      && applicableGoals.every(goal => goal.met),
    reason: status.error,
  }
}

export function getRadeonDaemonPaths(directory) {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error("Radeon daemon 작업 폴더를 지정해야 합니다")
  }
  return {
    directory,
    statusPath: join(directory, "status.json"),
    controlPath: join(directory, "control.json"),
    receiptPath: join(directory, "radeon-receipt.json"),
  }
}

export function createRadeonDaemonClient({
  directory = null,
  statusPath,
  controlPath,
  receiptPath = null,
  helperPath = null,
  parentPid = process.pid,
  legacyDriver = false,
  spawnHelper = spawn,
  readStatus = readRuntimeStatusJson,
  writeControl = writeJsonAtomic,
  removeFile = null,
  wait = delay,
  now = Date.now,
  timeoutMs = 5000,
  pollIntervalMs = 100,
}) {
  if (!statusPath || !controlPath) {
    throw new Error("Radeon daemon 상태/제어 경로가 필요합니다")
  }
  const remove = removeFile ?? (path => unlink(path).catch(() => {}))
  let child = null

  async function status() {
    return normalizeRadeonDaemonStatus(await readStatus(statusPath))
  }

  async function waitForStatus(predicate, waitMs = timeoutMs) {
    const deadline = now() + waitMs
    for (;;) {
      const current = await status()
      if (current && predicate(current)) return current
      if (now() >= deadline) return null
      await wait(pollIntervalMs)
    }
  }

  async function start() {
    if (child && child.exitCode === null) {
      return await waitForStatus(current => current.running) ?? await status()
    }
    await Promise.all([remove(statusPath), remove(controlPath)])
    const args = [
      "--daemon",
      `--status-path=${statusPath}`,
      `--control-path=${controlPath}`,
      `--parent-pid=${parentPid}`,
    ]
    if (legacyDriver) args.push("--legacy-driver")
    const spawned = spawnHelper(helperPath ?? resolveHelperPath(), args, {
      windowsHide: true,
      stdio: "ignore",
    })
    child = spawned
    let spawnError = null
    spawned.once?.("error", error => {
      spawnError = error
    })
    spawned.once?.("exit", () => {
      if (child === spawned) child = null
    })
    const current = await waitForStatus(value => value.running || value.error != null)
    if (!current?.running) {
      try {
        if (spawned.pid && spawned.exitCode === null) spawned.kill()
      } catch {
      }
      if (child === spawned) child = null
      throw new Error(
        current?.error
        ?? spawnError?.message
        ?? "Radeon 설정 daemon 실행을 확인하지 못했습니다",
      )
    }
    return current
  }

  async function send(command) {
    const control = createRadeonControlCommand(command, { now })
    await writeControl(controlPath, control)
    if (command === "stop") return control
    const current = await waitForStatus(value => value.lastCommand === command
      && value.lastResult != null
      && value.updatedAt != null
      && value.updatedAt >= control.requestedAt)
    if (!current) {
      throw new Error(`Radeon 설정 daemon이 ${command} 명령에 응답하지 않았습니다`)
    }
    if (current.lastResult !== "ok") {
      throw new Error(current.error ?? `Radeon 설정 daemon ${command} 명령이 실패했습니다`)
    }
    return current
  }

  function probe() {
    return send("probe")
  }

  async function apply() {
    const current = await probe()
    const refusal = resolveRadeonApplyRefusal(current)
    if (refusal) throw new Error(refusal)
    return send("apply")
  }

  function restore() {
    return send("restore")
  }

  async function stop() {
    const spawned = child
    if (!spawned || spawned.exitCode !== null) {
      child = null
      return null
    }
    await writeControl(controlPath, createRadeonControlCommand("stop", { now }))
    const current = await waitForStatus(value => value.running === false)
    if (child === spawned) child = null
    return current
  }

  async function readReceipt() {
    if (!receiptPath) return null
    return normalizeRadeonReceipt(await readStatus(receiptPath))
  }

  return {
    directory,
    statusPath,
    controlPath,
    receiptPath,
    start,
    stop,
    send,
    probe,
    apply,
    restore,
    status,
    readReceipt,
  }
}

const defaultManager = createRadeonManager({ runHelper: runNativeHelper })
let sharedDaemonClient = null

function resolveDaemonClient(option) {
  const settings = option === true ? {} : objectOrEmpty(option)
  const paths = getRadeonDaemonPaths(settings.directory)
  if (sharedDaemonClient?.directory !== paths.directory) {
    sharedDaemonClient = createRadeonDaemonClient({
      ...paths,
      legacyDriver: settings.legacyDriver === true,
    })
  }
  return sharedDaemonClient
}

async function runDaemonHelper(option, apply) {
  const client = resolveDaemonClient(option)
  await client.start()
  return radeonDaemonStatusToHelperResult(apply ? await client.apply() : await client.probe())
}

function resolveManager(options) {
  const daemon = options?.daemon
  if (!daemon) return defaultManager
  return createRadeonManager({ runHelper: apply => runDaemonHelper(daemon, apply) })
}

export function checkRadeonSettings(options = {}) {
  return resolveManager(options).check()
}

export function applyRadeonSettings(options = {}) {
  return resolveManager(options).apply()
}
