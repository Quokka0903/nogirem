// 네이티브 helper 빌드 검증 하네스.
// 툴체인 확인 → 4개 helper 빌드 → 컴파일러 출력 정규화 → 런타임 스모크 검사 순으로 돌고,
// 사람이 읽을 30줄 요약과 기계가 읽을 build-logs/summary.json 을 함께 남긴다.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { redactDiagnosticText } from "../src/diagnostic-bundle.mjs"
import {
  buildSummary,
  compareVersions,
  evaluateGenerator,
  formatCompactReport,
  relativizeProjectPaths,
  summarizeHelperLog,
} from "./native-log.mjs"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const logDirectory = join(root, "build-logs")
const summaryPath = join(logDirectory, "summary.json")
const buildTimeoutMs = Number(process.env.NOGIREM_NATIVE_BUILD_TIMEOUT_MS) || 20 * 60 * 1000
const probeTimeoutMs = 20 * 1000
const smokeTimeoutMs = Number(process.env.NOGIREM_NATIVE_SMOKE_TIMEOUT_MS) || 20 * 1000

export const exitCodes = {
  ok: 0,
  failed: 1,
  internalError: 2,
  missingToolchain: 3,
  unsupportedPlatform: 4,
}

const helperDefinitions = [
  {
    helper: "input-guard-helper",
    script: "scripts/build-input-guard-helper.mjs",
    artifact: "native/input-guard-helper/bin/input-guard-helper.exe",
    tools: ["cmake", "msvc"],
  },
  {
    helper: "radeon-helper",
    script: "scripts/build-radeon-helper.mjs",
    artifact: "native/radeon-helper/bin/radeon-helper.exe",
    tools: ["cmake", "msvc"],
  },
  {
    helper: "recorder-helper",
    script: "scripts/build-recorder-helper.mjs",
    artifact: "native/recorder-helper/bin/recorder-helper.exe",
    tools: ["cmake", "msvc"],
  },
  {
    helper: "turbo-key",
    script: "scripts/build-turbo-key.mjs",
    artifact: "native/turbo-key/bin/turbo-key-helper.exe",
    tools: ["cargo", "rustc"],
  },
]

const toolNames = {
  cmake: "cmake",
  msvc: "MSVC(Visual Studio C++ 빌드 도구)",
  cargo: "cargo",
  rustc: "rustc",
}

function posixPath(value) {
  return relative(root, value).replaceAll("\\", "/")
}

function runCommand(command, arguments_, { timeout = probeTimeoutMs, cwd = root } = {}) {
  return new Promise(resolve => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(command, arguments_, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      resolve({
        spawned: false,
        code: null,
        timedOut: false,
        stdout: "",
        stderr: String(error?.message ?? error),
        durationMs: 0,
      })
      return
    }
    const stdoutChunks = []
    const stderrChunks = []
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeout)
    timer.unref?.()
    child.stdout?.on("data", chunk => stdoutChunks.push(chunk))
    child.stderr?.on("data", chunk => stderrChunks.push(chunk))
    const settle = (code, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        spawned: !spawnError,
        code,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: spawnError
          ? `${Buffer.concat(stderrChunks).toString("utf8")}${String(spawnError?.message ?? spawnError)}`
          : Buffer.concat(stderrChunks).toString("utf8"),
        durationMs: Date.now() - startedAt,
      })
    }
    child.once("error", error => settle(null, error))
    child.once("close", code => settle(code, null))
  })
}

function parseVersion(text) {
  return /(\d+\.\d+(?:\.\d+)*)/.exec(String(text ?? ""))?.[1] ?? null
}

function cargoCandidates() {
  if (process.platform !== "win32") return ["cargo"]
  return [
    process.env.CARGO_HOME && join(process.env.CARGO_HOME, "bin", "cargo.exe"),
    process.env.USERPROFILE && join(process.env.USERPROFILE, ".cargo", "bin", "cargo.exe"),
    process.env.USERPROFILE && join(
      process.env.USERPROFILE,
      ".rustup",
      "toolchains",
      "stable-x86_64-pc-windows-msvc",
      "bin",
      "cargo.exe",
    ),
    "cargo",
  ].filter(candidate => candidate && (candidate === "cargo" || existsSync(candidate)))
}

async function probeVersion(candidates, arguments_ = ["--version"]) {
  let lastError = null
  for (const candidate of candidates) {
    const result = await runCommand(candidate, arguments_)
    if (result.spawned && result.code === 0) {
      const output = `${result.stdout}${result.stderr}`.trim()
      return {
        available: true,
        version: parseVersion(output),
        path: candidate,
        error: null,
      }
    }
    lastError = result.timedOut
      ? `${candidate} 확인이 ${probeTimeoutMs}ms 안에 끝나지 않았습니다`
      : (result.stderr.trim().split("\n")[0] || `${candidate} 실행에 실패했습니다`)
  }
  return { available: false, version: null, path: null, error: lastError }
}

async function probeVisualStudio() {
  const vswhere = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  )
  let instances = []
  if (existsSync(vswhere)) {
    const result = await runCommand(vswhere, [
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-format",
      "json",
      "-utf8",
      "-nologo",
    ])
    if (result.spawned && result.code === 0) {
      try {
        const parsed = JSON.parse(result.stdout || "[]")
        instances = (Array.isArray(parsed) ? parsed : []).map(instance => ({
          name: String(instance?.displayName ?? "Visual Studio"),
          version: String(instance?.installationVersion ?? ""),
          path: String(instance?.installationPath ?? ""),
        })).filter(instance => instance.version)
      } catch {
        instances = []
      }
    }
  }
  if (instances.length) {
    const newest = [...instances].sort(
      (left, right) => compareVersions(right.version, left.version),
    )[0]
    return {
      available: true,
      version: newest.version,
      path: newest.path || null,
      instances,
      error: null,
    }
  }
  const msbuild = await probeVersion(["msbuild"], ["-version", "-nologo"])
  if (msbuild.available) {
    return {
      available: true,
      version: msbuild.version,
      path: msbuild.path,
      instances: [{ name: "MSBuild", version: msbuild.version ?? "", path: msbuild.path ?? "" }],
      error: null,
    }
  }
  return {
    available: false,
    version: null,
    path: null,
    instances: [],
    error: existsSync(vswhere)
      ? "vswhere가 C++ 도구 집합이 설치된 Visual Studio를 찾지 못했습니다"
      : "vswhere.exe와 msbuild를 모두 찾지 못했습니다",
  }
}

async function probeToolchain() {
  const [cmake, msvc, cargo] = await Promise.all([
    probeVersion(["cmake"]),
    probeVisualStudio(),
    probeVersion(cargoCandidates()),
  ])
  const rustcCandidates = cargo.path && cargo.path !== "cargo"
    ? [join(dirname(cargo.path), "rustc.exe"), "rustc"]
    : ["rustc"]
  const rustc = await probeVersion(rustcCandidates)
  return {
    cmake,
    msvc,
    cargo,
    rustc,
    generator: evaluateGenerator({
      cmakeVersion: cmake.version,
      instances: msvc.instances,
    }),
  }
}

async function probeGit() {
  const [sha, branch, dirty] = await Promise.all([
    runCommand("git", ["rev-parse", "HEAD"]),
    runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    runCommand("git", ["status", "--porcelain"]),
  ])
  const fullSha = sha.spawned && sha.code === 0 ? sha.stdout.trim() : null
  return {
    sha: fullSha,
    shortSha: fullSha ? fullSha.slice(0, 7) : null,
    branch: branch.spawned && branch.code === 0 ? branch.stdout.trim() : null,
    dirty: dirty.spawned && dirty.code === 0 ? dirty.stdout.trim().length > 0 : null,
  }
}

function sanitizeLog(text) {
  return redactDiagnosticText(relativizeProjectPaths(text, root))
}

// summary.json 에도 도구 설치 경로가 실리므로, 파일로 남기기 전에 같은 규칙으로 마스킹한다.
async function writeSummary(summary) {
  const serialized = redactDiagnosticText(JSON.stringify(summary, null, 2))
  await writeFile(summaryPath, `${serialized}\n`, "utf8")
  return serialized
}

async function buildHelper(definition) {
  const result = await runCommand(process.execPath, [join(root, definition.script)], {
    timeout: buildTimeoutMs,
  })
  const captured = sanitizeLog([
    `# ${definition.helper} · node ${definition.script}`,
    result.stdout,
    result.stderr,
    result.timedOut ? `# 빌드가 ${buildTimeoutMs}ms 제한을 넘겨 중단되었습니다` : "",
  ].filter(Boolean).join("\n"))
  const logPath = join(logDirectory, `${definition.helper}.log`)
  await writeFile(logPath, captured, "utf8")
  const built = result.spawned && result.code === 0 && existsSync(join(root, definition.artifact))
  const reason = result.timedOut
    ? "빌드 제한 시간을 초과했습니다"
    : (result.spawned
      ? (result.code === 0 ? "빌드 산출물을 찾지 못했습니다" : null)
      : "빌드 스크립트를 실행하지 못했습니다")
  return summarizeHelperLog({
    helper: definition.helper,
    status: built ? "ok" : "failed",
    reason: built ? null : reason,
    exitCode: result.code,
    durationMs: result.durationMs,
    script: definition.script,
    logPath: posixPath(logPath),
    artifact: definition.artifact,
    text: captured,
  })
}

function smokeResult(helper, name, status, { reason = null, exitCode = null, durationMs = 0, detail = null } = {}) {
  return { helper, name, status, reason, exitCode, durationMs: Math.round(durationMs), detail }
}

// radeon-helper: 인자 없이 실행하면 JSON 상태 문서를 출력한다.
async function smokeRadeon(binary) {
  const name = "radeon-helper status json"
  const result = await runCommand(binary, [], { timeout: smokeTimeoutMs })
  if (!result.spawned || result.code !== 0) {
    return smokeResult("radeon-helper", name, "failed", {
      reason: result.timedOut ? "제한 시간 초과" : `종료 코드 ${result.code}`,
      exitCode: result.code,
      durationMs: result.durationMs,
    })
  }
  try {
    const parsed = JSON.parse(result.stdout.trim())
    const missingKeys = ["detected", "gpus", "goals", "allMet"].filter(key => !(key in parsed))
    if (missingKeys.length || !Array.isArray(parsed.gpus) || !Array.isArray(parsed.goals)) {
      return smokeResult("radeon-helper", name, "failed", {
        reason: `상태 JSON 항목이 올바르지 않습니다 (${missingKeys.join(", ") || "gpus/goals 배열 아님"})`,
        exitCode: result.code,
        durationMs: result.durationMs,
      })
    }
    return smokeResult("radeon-helper", name, "ok", {
      exitCode: result.code,
      durationMs: result.durationMs,
      detail: `detected=${parsed.detected === true} gpus=${parsed.gpus.length} goals=${parsed.goals.length}`,
    })
  } catch (error) {
    return smokeResult("radeon-helper", name, "failed", {
      reason: `상태 JSON을 해석하지 못했습니다: ${String(error?.message ?? error)}`,
      exitCode: result.code,
      durationMs: result.durationMs,
    })
  }
}

// recorder-helper: electron/main.mjs 가 이미 쓰는 --mode=drives 를 그대로 재사용한다.
async function smokeRecorder(binary) {
  const name = "recorder-helper --mode=drives"
  const result = await runCommand(binary, ["--mode=drives"], { timeout: smokeTimeoutMs })
  if (!result.spawned || result.code !== 0) {
    return smokeResult("recorder-helper", name, "failed", {
      reason: result.timedOut ? "제한 시간 초과" : `종료 코드 ${result.code}`,
      exitCode: result.code,
      durationMs: result.durationMs,
    })
  }
  try {
    const parsed = JSON.parse(result.stdout.trim() || "null")
    if (!Array.isArray(parsed)) {
      return smokeResult("recorder-helper", name, "failed", {
        reason: "드라이브 목록이 JSON 배열이 아닙니다",
        exitCode: result.code,
        durationMs: result.durationMs,
      })
    }
    return smokeResult("recorder-helper", name, "ok", {
      exitCode: result.code,
      durationMs: result.durationMs,
      detail: `drives=${parsed.length}`,
    })
  } catch (error) {
    return smokeResult("recorder-helper", name, "failed", {
      reason: `드라이브 목록 JSON을 해석하지 못했습니다: ${String(error?.message ?? error)}`,
      exitCode: result.code,
      durationMs: result.durationMs,
    })
  }
}

// input-guard-helper: ensureInputGuardStarted 가 쓰는 --restore-only=1 복구 경로만 확인한다.
// 종료 코드 2는 다른 인스턴스가 잠금을 쥔 정상 상태라 실패로 보지 않는다.
async function smokeInputGuard(binary) {
  const name = "input-guard-helper --restore-only=1"
  const result = await runCommand(binary, ["--restore-only=1"], { timeout: smokeTimeoutMs })
  if (result.spawned && result.code === 0) {
    return smokeResult("input-guard-helper", name, "ok", {
      exitCode: 0,
      durationMs: result.durationMs,
    })
  }
  if (result.spawned && result.code === 2) {
    return smokeResult("input-guard-helper", name, "skipped", {
      reason: "다른 helper 인스턴스가 실행 중이라 복구 경로를 확인하지 못했습니다",
      exitCode: 2,
      durationMs: result.durationMs,
    })
  }
  return smokeResult("input-guard-helper", name, "failed", {
    reason: result.timedOut ? "제한 시간 초과" : `종료 코드 ${result.code}`,
    exitCode: result.code,
    durationMs: result.durationMs,
  })
}

// turbo-key: 전역 키보드 훅을 설치하는 모드는 절대 돌리지 않는다.
// native/turbo-key/src/main.rs 의 run() 은 모든 인자를 먼저 검증하고
// SetWindowsHookExW 는 그 뒤에 호출하므로, 잘못된 인자만 주면 훅 없이 종료한다.
async function smokeTurboKey(binary) {
  const name = "turbo-key 인자 검증 실패 경로"
  const statusPath = join(tmpdir(), `nogirem-turbo-key-smoke-${process.pid}.json`)
  const controlPath = join(tmpdir(), `nogirem-turbo-key-smoke-${process.pid}.control.json`)
  try {
    const result = await runCommand(binary, [
      `--status-path=${statusPath}`,
      `--control-path=${controlPath}`,
      `--parent-pid=${process.pid}`,
      "--affinity-mask=not-a-mask",
    ], { timeout: smokeTimeoutMs })
    if (!result.spawned) {
      return smokeResult("turbo-key", name, "failed", {
        reason: "helper를 실행하지 못했습니다",
        durationMs: result.durationMs,
      })
    }
    if (result.timedOut || result.code === 0) {
      return smokeResult("turbo-key", name, "failed", {
        reason: result.timedOut
          ? "잘못된 인자인데도 종료하지 않았습니다"
          : "잘못된 인자인데도 종료 코드 0을 반환했습니다",
        exitCode: result.code,
        durationMs: result.durationMs,
      })
    }
    let statusError = null
    if (existsSync(statusPath)) {
      try {
        const parsed = JSON.parse(await readFile(statusPath, "utf8"))
        statusError = parsed?.running === false && typeof parsed?.error === "string" ? parsed.error : null
      } catch {
        statusError = null
      }
    }
    return smokeResult("turbo-key", name, "ok", {
      exitCode: result.code,
      durationMs: result.durationMs,
      detail: statusError ? `상태 JSON error="${statusError}"` : "상태 JSON 없이 즉시 종료",
    })
  } finally {
    await rm(statusPath, { force: true }).catch(() => {})
    await rm(controlPath, { force: true }).catch(() => {})
  }
}

const smokeRunners = {
  "radeon-helper": smokeRadeon,
  "recorder-helper": smokeRecorder,
  "input-guard-helper": smokeInputGuard,
  "turbo-key": smokeTurboKey,
}

function printHelp() {
  console.log([
    "사용법: node scripts/verify-native.mjs [--json]",
    "",
    "  네이티브 helper 빌드 도구를 확인하고 4개 helper를 모두 빌드한 뒤",
    "  컴파일러 출력을 정규화해 build-logs/summary.json 과 요약을 남깁니다.",
    "",
    "  --json   요약 JSON만 출력합니다 (CI/에이전트용)",
    "  --help   이 도움말을 출력합니다",
    "",
    "종료 코드: 0=성공 1=빌드/스모크 실패 2=하네스 오류 3=빌드 도구 없음 4=미지원 플랫폼",
  ].join("\n"))
}

async function main() {
  const argumentList = process.argv.slice(2)
  if (argumentList.includes("--help") || argumentList.includes("-h")) {
    printHelp()
    return exitCodes.ok
  }
  const jsonOnly = argumentList.includes("--json")
  const startedAt = Date.now()
  await mkdir(logDirectory, { recursive: true })

  const platform = { os: process.platform, arch: process.arch, node: process.version }
  const git = await probeGit()

  if (process.platform !== "win32") {
    const summary = buildSummary({
      status: "unsupported-platform",
      exitCode: exitCodes.unsupportedPlatform,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      platform,
      git,
      toolchain: {},
      missing: [],
      helpers: [],
      smoke: [],
    })
    summary.summaryPath = posixPath(summaryPath)
    const serialized = await writeSummary(summary)
    if (jsonOnly) console.log(serialized)
    else console.log("[native-verify] 네이티브 helper는 Windows x64에서만 빌드할 수 있습니다")
    return exitCodes.unsupportedPlatform
  }

  const toolchain = await probeToolchain()
  const toolIssues = new Map()
  for (const name of ["cmake", "msvc", "cargo", "rustc"]) {
    if (!toolchain[name]?.available) toolIssues.set(name, `${toolNames[name]} 없음`)
  }
  if (!toolIssues.has("msvc") && toolchain.generator.toolsetReason) {
    toolIssues.set("msvc", toolchain.generator.toolsetReason)
  }
  if (!toolIssues.has("cmake") && toolchain.generator.cmakeReason) {
    toolIssues.set("cmake", toolchain.generator.cmakeReason)
  }

  const helpers = []
  const smoke = []
  const missing = new Set()
  for (const definition of helperDefinitions) {
    const unmet = definition.tools.filter(tool => toolIssues.has(tool))
    if (unmet.length) {
      for (const tool of unmet) missing.add(tool)
      helpers.push(summarizeHelperLog({
        helper: definition.helper,
        status: "skipped",
        reason: unmet.map(tool => toolIssues.get(tool)).join(" · "),
        script: definition.script,
        artifact: definition.artifact,
        text: "",
      }))
      smoke.push(smokeResult(definition.helper, "빌드 전 스모크 보류", "skipped", {
        reason: "빌드하지 않아 스모크 검사를 건너뛰었습니다",
      }))
      continue
    }
    const entry = await buildHelper(definition)
    helpers.push(entry)
    if (entry.status !== "ok") {
      smoke.push(smokeResult(definition.helper, "빌드 후 스모크 보류", "skipped", {
        reason: "빌드에 실패해 스모크 검사를 건너뛰었습니다",
      }))
      continue
    }
    smoke.push(await smokeRunners[definition.helper](join(root, definition.artifact)))
  }

  const buildFailed = helpers.some(entry => entry.status === "failed")
    || smoke.some(entry => entry.status === "failed")
  const status = buildFailed
    ? "failed"
    : (missing.size ? "missing-toolchain" : "ok")
  const exitCode = buildFailed
    ? exitCodes.failed
    : (missing.size ? exitCodes.missingToolchain : exitCodes.ok)

  const summary = buildSummary({
    status,
    exitCode,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    platform,
    git,
    toolchain,
    missing: ["cmake", "msvc", "cargo", "rustc"].filter(tool => missing.has(tool)),
    helpers,
    smoke,
  })
  summary.summaryPath = posixPath(summaryPath)
  const serialized = await writeSummary(summary)

  if (jsonOnly) {
    console.log(serialized)
    return exitCode
  }
  for (const line of formatCompactReport(summary)) console.log(line)
  if (status === "missing-toolchain") {
    console.log("[native-verify] 설치 안내:")
    if (missing.has("cmake")) console.log("[native-verify]   - cmake 3.20 이상: https://cmake.org/download/")
    if (missing.has("msvc")) console.log(`[native-verify]   - Visual Studio 2019(v16) C++ 워크로드 또는 Build Tools (생성기 "${toolchain.generator.requested}")`)
    if (missing.has("cargo") || missing.has("rustc")) console.log("[native-verify]   - rustup 설치 후 x86_64-pc-windows-msvc 타깃: https://rustup.rs")
  }
  return exitCode
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(`[native-verify] 하네스 실행 중 오류: ${String(error?.stack ?? error)}`)
  process.exitCode = exitCodes.internalError
}
