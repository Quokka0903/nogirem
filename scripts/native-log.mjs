// 네이티브 빌드 로그를 기계가 읽을 수 있는 진단 레코드로 바꾸는 순수 함수 모음.
// 부수 효과가 없어야 test/native-log.test.mjs 에서 그대로 단위 검증할 수 있다.

import { delimiter, join } from "node:path"

export const requestedGenerator = "Visual Studio 16 2019"
export const requestedGeneratorMajor = 16
export const minimumCMakeVersion = "3.20"
export const diagnosticLimit = 12
export const maximumMessageLength = 400

const msvcPositionalPattern =
  /^(?<file>.+?)\((?<line>\d+)(?:,(?<column>\d+))?\)\s*:\s*(?<kind>fatal error|error|warning)\s+(?<code>[A-Za-z]{1,4}\d{3,5})\s*:\s*(?<message>.*)$/
const msvcPlainPattern =
  /^(?<file>(?:[A-Za-z]:)?[^:]{0,200}?)\s*:\s*(?<kind>(?:fatal\s+)?(?:command\s+line\s+)?(?:error|warning))\s+(?<code>[A-Za-z]{1,4}\d{3,5})\s*:\s*(?<message>.*)$/i
const cmakeLocatedPattern =
  /^CMake (?<kind>Error|Warning|Deprecation Warning|Internal Error)(?: \(dev\))? at (?<file>.+?):(?<line>\d+)(?: \((?<code>[^()]*)\))?:\s*$/
const cmakePlainPattern =
  /^CMake (?<kind>Error|Warning|Deprecation Warning|Internal Error)(?: \(dev\))?:\s*(?<message>.*)$/
const cargoHeaderPattern =
  /^(?<kind>error|warning)(?:\[(?<code>[A-Za-z]\d{3,4})\])?\s*:\s*(?<message>.+)$/
const cargoLocationPattern = /^\s*-->\s*(?<file>.+?):(?<line>\d+):(?<column>\d+)\s*$/

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function compactWhitespace(value) {
  return String(value).replace(/\s+/g, " ").trim()
}

function clampMessage(value) {
  const compact = compactWhitespace(value)
  return compact.length > maximumMessageLength
    ? `${compact.slice(0, maximumMessageLength - 1)}…`
    : compact
}

function stripBuildPrefix(line) {
  return String(line).replace(/\r$/, "").replace(/^(\s*)\d+>/, "$1")
}

function stripProjectSuffix(message) {
  return String(message).replace(
    /\s*\[[^\]]*\.(?:vcxproj|sln|csproj|metaproj)\]\s*$/i,
    "",
  )
}

function normalizeSeverity(kind) {
  return /warning/i.test(String(kind)) ? "warning" : "error"
}

function normalizeFile(value) {
  const file = compactWhitespace(value).replace(/^["']|["']$/g, "")
  if (!file) return null
  return file.replaceAll("\\", "/")
}

function toNumber(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) ? parsed : null
}

function msvcStage(code) {
  const prefix = String(code ?? "").replace(/\d+$/, "").toUpperCase()
  if (prefix === "LNK") return "link"
  if (prefix === "MSB" || prefix === "D") return "build"
  return "compile"
}

function createRecord({ helper, stage, severity, code, file, line, column, message }) {
  return {
    helper: helper ?? null,
    stage,
    severity,
    code: code ? String(code) : null,
    file: file ?? null,
    line: line ?? null,
    column: column ?? null,
    message: clampMessage(message ?? ""),
  }
}

// 프로젝트 루트 절대 경로를 저장소 상대 경로로 바꿔, 개인정보 마스킹 이후에도
// 진단에 남는 파일 경로가 사람과 에이전트 모두에게 읽히도록 만든다.
export function relativizeProjectPaths(text, root) {
  let result = String(text ?? "")
  if (!root) return result
  const variants = [...new Set([
    String(root),
    String(root).replaceAll("\\", "/"),
    String(root).replaceAll("\\", "\\\\"),
  ])].sort((left, right) => right.length - left.length)
  for (const variant of variants) {
    if (!variant) continue
    result = result.replace(
      new RegExp(`${escapeRegExp(variant)}[\\\\/]+`, "gi"),
      "",
    )
    result = result.replace(new RegExp(escapeRegExp(variant), "gi"), ".")
  }
  return result
}

export function compareVersions(left, right) {
  const leftParts = String(left ?? "").split(/[.+-]/).map(part => Number.parseInt(part, 10) || 0)
  const rightParts = String(right ?? "").split(/[.+-]/).map(part => Number.parseInt(part, 10) || 0)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

// 빌드 스크립트가 고정해 둔 CMake 생성기 문자열이 실제로 사용 가능한지 판정한다.
// cmake 쪽 문제와 Visual Studio 도구 집합 문제를 따로 모아, 한쪽이 없어도 나머지를 숨기지 않는다.
export function evaluateGenerator({ cmakeVersion = null, instances = [] } = {}) {
  const installed = (instances ?? [])
    .map(instance => ({
      version: String(instance?.version ?? instance?.installationVersion ?? ""),
      name: String(instance?.name ?? instance?.displayName ?? "Visual Studio"),
    }))
    .filter(instance => instance.version)
  const matched = installed.find(
    instance => toNumber(instance.version.split(".")[0]) === requestedGeneratorMajor,
  ) ?? null
  let cmakeReason = null
  if (!cmakeVersion) cmakeReason = "cmake를 찾지 못했습니다"
  else if (compareVersions(cmakeVersion, minimumCMakeVersion) < 0) {
    cmakeReason = `cmake ${cmakeVersion}은 최소 요구 버전 ${minimumCMakeVersion}보다 낮습니다`
  }
  let toolsetReason = null
  if (!installed.length) toolsetReason = "Visual Studio C++ 도구 집합을 찾지 못했습니다"
  else if (!matched) {
    const found = installed.map(instance => instance.version).join(", ")
    toolsetReason = `설치된 Visual Studio는 ${found}뿐이라 v${requestedGeneratorMajor}(2019) 도구 집합이 필요합니다`
  }
  const reasons = [cmakeReason, toolsetReason].filter(Boolean)
  return {
    requested: requestedGenerator,
    installed,
    matched: matched?.version ?? null,
    satisfiable: reasons.length === 0,
    reason: reasons.join(" · ") || null,
    cmakeReason,
    toolsetReason,
  }
}

// MSBuild/cl 은 한국어 Windows에서 진단을 UTF-8이 아니라 콘솔 코드 페이지(949)로 낸다.
// 그대로 UTF-8로 읽으면 message 가 깨져 진단이 쓸모없어지므로 코드 페이지를 확인해 둔다.
export const codePageEncodings = {
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  65001: "utf-8",
}

export const defaultOutputEncoding = "windows-1252"

export function encodingFromCodePage(text, fallback = defaultOutputEncoding) {
  const matches = String(text ?? "").match(/\d{3,5}/g)
  if (!matches?.length) return fallback
  return codePageEncodings[Number(matches.at(-1))] ?? fallback
}

// UTF-8로 먼저 엄격하게 읽어 보고, 깨지면 콘솔 코드 페이지로 되읽는다.
// ASCII/UTF-8 출력은 그대로 통과하므로 cargo 같은 UTF-8 도구는 영향이 없다.
export function decodeBuildOutput(buffer, fallbackEncoding = defaultOutputEncoding) {
  if (!buffer?.length) return ""
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer)
  } catch {
    // UTF-8이 아니면 아래에서 코드 페이지로 다시 읽는다
  }
  try {
    return new TextDecoder(fallbackEncoding).decode(buffer)
  } catch {
    return Buffer.from(buffer).toString("latin1")
  }
}

// Visual Studio C++ 워크로드는 cmake 를 함께 설치하지만 PATH 에는 올리지 않는다.
// 설치 루트만 주면 번들 cmake 후보 경로를 만들어 준다 (연도·에디션을 하드코딩하지 않는다).
export const visualStudioCMakeSegments = [
  "Common7",
  "IDE",
  "CommonExtensions",
  "Microsoft",
  "CMake",
  "CMake",
  "bin",
  "cmake.exe",
]

export const visualStudioCMakeRelativePath = join(...visualStudioCMakeSegments)

export function visualStudioCMakeCandidates(installationPaths) {
  const seen = new Set()
  const candidates = []
  for (const installationPath of installationPaths ?? []) {
    const trimmed = String(installationPath ?? "").trim()
    if (!trimmed) continue
    const candidate = join(trimmed, visualStudioCMakeRelativePath)
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
  }
  return candidates
}

// 후보가 여럿이면 최소 요구 버전을 넘는 것 중 가장 높은 cmake 를 고른다.
export function pickBestCMake(candidates) {
  const usable = (candidates ?? []).filter(candidate => candidate?.path && candidate?.version)
  if (!usable.length) return null
  const ordered = [...usable].sort((left, right) => compareVersions(right.version, left.version))
  return ordered.find(
    candidate => compareVersions(candidate.version, minimumCMakeVersion) >= 0,
  ) ?? ordered[0]
}

// 자식 프로세스 PATH 앞에 디렉터리를 붙인다. Windows 환경 변수는 대소문자를 가리지 않으므로
// 기존 Path/PATH 항목을 먼저 지워 중복 키가 생기지 않게 한다.
export function mergePathEnv(baseEnv, extraPath, separator = delimiter) {
  if (!extraPath) return undefined
  const merged = {}
  let previous = ""
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (key.toLowerCase() === "path") {
      if (!previous) previous = String(value ?? "")
      continue
    }
    merged[key] = value
  }
  merged.PATH = previous ? `${extraPath}${separator}${previous}` : String(extraPath)
  return merged
}

// 빌드 실패와 "도구가 없어 건너뜀"은 다르다.
// 일부만 빌드된 경우를 partial 로 따로 표시해, 예상된 건너뜀을 실패로 보고하지 않는다.
export function deriveStatus({ helpers = [], smoke = [] } = {}) {
  if (
    helpers.some(entry => entry.status === "failed")
    || smoke.some(entry => entry.status === "failed")
  ) return "failed"
  const skipped = helpers.filter(entry => entry.status === "skipped").length
  if (!skipped) return "ok"
  return helpers.some(entry => entry.status === "ok") ? "partial" : "missing-toolchain"
}

export const exitCodes = {
  ok: 0,
  failed: 1,
  internalError: 2,
  missingToolchain: 3,
  unsupportedPlatform: 4,
}

export function statusExitCode(status) {
  if (status === "ok") return exitCodes.ok
  if (status === "failed") return exitCodes.failed
  if (status === "unsupported-platform") return exitCodes.unsupportedPlatform
  return exitCodes.missingToolchain
}

function flushCMakeBlock(block, records) {
  if (!block) return
  const message = compactWhitespace(block.parts.join(" "))
  records.push(createRecord({
    ...block.record,
    message: message || block.record.message || block.record.code || "CMake 진단",
  }))
}

// MSVC / CMake / cargo 출력을 한 번에 훑어 등장 순서 그대로 진단 레코드를 만든다.
export function parseDiagnostics(text, { helper = null } = {}) {
  const lines = String(text ?? "").split("\n")
  const records = []
  const consumed = new Set()
  let cmakeBlock = null

  for (let index = 0; index < lines.length; index += 1) {
    if (consumed.has(index)) continue
    const raw = stripBuildPrefix(lines[index])
    const line = raw.trimEnd()

    if (cmakeBlock) {
      if (!line.trim()) {
        cmakeBlock.parts.push("")
        continue
      }
      if (/^\s/.test(raw)) {
        cmakeBlock.parts.push(line.trim())
        continue
      }
      flushCMakeBlock(cmakeBlock, records)
      cmakeBlock = null
    }

    if (!line.trim()) continue

    const msvcPositional = msvcPositionalPattern.exec(line)
    if (msvcPositional) {
      const { file, line: row, column, kind, code, message } = msvcPositional.groups
      records.push(createRecord({
        helper,
        stage: msvcStage(code),
        severity: normalizeSeverity(kind),
        code,
        file: normalizeFile(file),
        line: toNumber(row),
        column: toNumber(column),
        message: stripProjectSuffix(message),
      }))
      continue
    }

    const cmakeLocated = cmakeLocatedPattern.exec(line)
    if (cmakeLocated) {
      const { kind, file, line: row, code } = cmakeLocated.groups
      cmakeBlock = {
        record: {
          helper,
          stage: "configure",
          severity: normalizeSeverity(kind),
          code: code ? compactWhitespace(code) : null,
          file: normalizeFile(file),
          line: toNumber(row),
          column: null,
          message: "",
        },
        parts: [],
      }
      continue
    }

    const cmakePlain = cmakePlainPattern.exec(line)
    if (cmakePlain) {
      const { kind, message } = cmakePlain.groups
      cmakeBlock = {
        record: {
          helper,
          stage: "configure",
          severity: normalizeSeverity(kind),
          code: null,
          file: null,
          line: null,
          column: null,
          message: compactWhitespace(message),
        },
        parts: message.trim() ? [message.trim()] : [],
      }
      continue
    }

    const msvcPlain = msvcPlainPattern.exec(line)
    if (msvcPlain) {
      const { file, kind, code, message } = msvcPlain.groups
      records.push(createRecord({
        helper,
        stage: msvcStage(code),
        severity: normalizeSeverity(kind),
        code,
        file: normalizeFile(file),
        line: null,
        column: null,
        message: stripProjectSuffix(message),
      }))
      continue
    }

    const cargoHeader = cargoHeaderPattern.exec(line)
    if (cargoHeader) {
      const { kind, code, message } = cargoHeader.groups
      let file = null
      let row = null
      let column = null
      for (let ahead = index + 1; ahead < Math.min(lines.length, index + 4); ahead += 1) {
        const candidate = stripBuildPrefix(lines[ahead]).trimEnd()
        if (!candidate.trim()) continue
        const location = cargoLocationPattern.exec(candidate)
        if (location) {
          file = normalizeFile(location.groups.file)
          row = toNumber(location.groups.line)
          column = toNumber(location.groups.column)
          consumed.add(ahead)
        }
        break
      }
      records.push(createRecord({
        helper,
        stage: "cargo",
        severity: normalizeSeverity(kind),
        code,
        file,
        line: row,
        column,
        message,
      }))
      continue
    }
  }

  flushCMakeBlock(cmakeBlock, records)
  return records
}

export function diagnosticKey(record) {
  return [
    record.severity,
    record.code ?? "",
    record.file ?? "",
    record.line ?? "",
    record.column ?? "",
    record.message,
  ].join("|")
}

export function dedupeDiagnostics(records) {
  const seen = new Set()
  const unique = []
  for (const record of records ?? []) {
    const key = diagnosticKey(record)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(record)
  }
  return unique
}

// 오류를 먼저 남기고 남는 자리만 경고로 채워, 요약이 짧아도 실마리를 잃지 않게 한다.
export function capDiagnostics(records, limit = diagnosticLimit) {
  const list = records ?? []
  if (limit <= 0) return { diagnostics: [], truncated: list.length }
  if (list.length <= limit) return { diagnostics: [...list], truncated: 0 }
  const errors = list.filter(record => record.severity === "error")
  const warnings = list.filter(record => record.severity !== "error")
  const kept = [...errors.slice(0, limit), ...warnings].slice(0, limit)
  const order = new Map(list.map((record, index) => [record, index]))
  kept.sort((left, right) => order.get(left) - order.get(right))
  return { diagnostics: kept, truncated: list.length - kept.length }
}

// cmake/cargo 실행 자체가 실패하면 컴파일러 진단이 한 건도 없다.
// 그럴 때 로그를 통째로 읽게 두지 않도록, 오류처럼 보이는 줄만 몇 개 건져 준다.
export function extractFailureHints(text, { limit = 3 } = {}) {
  const lines = String(text ?? "")
    .split("\n")
    .map(line => compactWhitespace(line))
    .filter(line => line && !line.startsWith("#"))
  if (!lines.length) return []
  const interesting = lines.filter(
    line => /\b(?:error|fatal|failed|failure|cannot|unable|not found|enoent)\b/i.test(line)
      || /오류|실패|찾지 못|없습니다/.test(line),
  )
  const picked = interesting.length ? interesting.slice(0, limit) : lines.slice(-limit)
  return picked.map(line => clampMessage(line))
}

export function summarizeHelperLog({
  helper,
  status,
  reason = null,
  exitCode = null,
  durationMs = 0,
  script = null,
  logPath = null,
  artifact = null,
  text = "",
  limit = diagnosticLimit,
}) {
  const unique = dedupeDiagnostics(parseDiagnostics(text, { helper }))
  const { diagnostics, truncated } = capDiagnostics(unique, limit)
  return {
    helper,
    status,
    reason,
    script,
    exitCode,
    durationMs: Math.max(0, Math.round(durationMs)),
    errorCount: unique.filter(record => record.severity === "error").length,
    warningCount: unique.filter(record => record.severity === "warning").length,
    diagnostics,
    diagnosticsTruncated: truncated,
    failureHints: status === "failed" && !diagnostics.length ? extractFailureHints(text) : [],
    logPath,
    artifact,
  }
}

export function buildSummary({
  status,
  exitCode,
  generatedAt,
  durationMs = 0,
  platform = {},
  git = {},
  toolchain = {},
  missing = [],
  helpers = [],
  smoke = [],
}) {
  return {
    schemaVersion: 1,
    status,
    exitCode,
    generatedAt,
    durationMs: Math.max(0, Math.round(durationMs)),
    platform,
    git,
    toolchain,
    missing: [...missing],
    helpers,
    smoke,
    counts: {
      helpers: helpers.length,
      built: helpers.filter(entry => entry.status === "ok").length,
      failed: helpers.filter(entry => entry.status === "failed").length,
      skipped: helpers.filter(entry => entry.status === "skipped").length,
      errors: helpers.reduce((total, entry) => total + entry.errorCount, 0),
      warnings: helpers.reduce((total, entry) => total + entry.warningCount, 0),
      smokePassed: smoke.filter(entry => entry.status === "ok").length,
      smokeFailed: smoke.filter(entry => entry.status === "failed").length,
      smokeSkipped: smoke.filter(entry => entry.status === "skipped").length,
    },
  }
}

function formatSeconds(durationMs) {
  return `${(Math.max(0, durationMs) / 1000).toFixed(1)}s`
}

function formatDiagnostic(record) {
  const location = record.file
    ? `${record.file}${record.line ? `:${record.line}` : ""}${record.column ? `:${record.column}` : ""}`
    : "(위치 없음)"
  const code = record.code ? ` ${record.code}` : ""
  return `${record.helper ?? "?"} ${record.stage} ${record.severity}${code} ${location} ${record.message}`
}

function toolLabel(tool) {
  if (!tool?.available) return "없음"
  const version = tool.version ?? "설치됨"
  return tool.source === "visual-studio" ? `${version}(vs)` : version
}

// 에이전트가 한눈에 읽도록 30줄 안팎으로 접은 보고서. 세부 내용은 로그 파일로 넘긴다.
export function formatCompactReport(summary, {
  tag = "native-verify",
  maximumDiagnostics = 6,
  maximumPerHelper = 3,
  maximumSmoke = 3,
  maximumHints = 4,
} = {}) {
  const lines = []
  const push = value => lines.push(`[${tag}] ${value}`)
  const git = summary.git ?? {}
  const platform = summary.platform ?? {}
  push([
    `status=${summary.status}`,
    `sha=${git.shortSha ?? "unknown"}${git.dirty ? "+dirty" : ""}`,
    `platform=${platform.os ?? "?"}/${platform.arch ?? "?"}`,
    `node=${platform.node ?? "?"}`,
    `elapsed=${formatSeconds(summary.durationMs)}`,
  ].join(" "))
  const toolchain = summary.toolchain ?? {}
  push(`toolchain cmake=${toolLabel(toolchain.cmake)} msvc=${toolLabel(toolchain.msvc)} cargo=${toolLabel(toolchain.cargo)} rustc=${toolLabel(toolchain.rustc)}`)
  const generator = toolchain.generator
  if (generator) {
    push([
      `generator="${generator.requested}"`,
      `satisfiable=${generator.satisfiable ? "yes" : "no"}`,
      generator.matched ? `toolset=${generator.matched}` : "",
      generator.reason ? `· ${generator.reason}` : "",
    ].filter(Boolean).join(" "))
  }
  if (summary.missing?.length) {
    push(`빌드 도구가 없어 건너뛴 항목이 있습니다: ${summary.missing.join(", ")}`)
  }

  const nameWidth = Math.max(0, ...(summary.helpers ?? []).map(entry => entry.helper.length))
  const smokeByHelper = new Map()
  for (const entry of summary.smoke ?? []) {
    const previous = smokeByHelper.get(entry.helper)
    if (previous === "failed") continue
    smokeByHelper.set(entry.helper, previous === "ok" && entry.status === "skipped" ? "ok" : entry.status)
  }
  for (const entry of summary.helpers ?? []) {
    const smoke = smokeByHelper.get(entry.helper) ?? "none"
    push([
      entry.helper.padEnd(nameWidth),
      entry.status.padEnd(7),
      formatSeconds(entry.durationMs).padStart(7),
      `errors=${entry.errorCount}`,
      `warnings=${entry.warningCount}`,
      `smoke=${smoke}`,
      entry.status === "skipped" && entry.reason ? `· ${entry.reason}` : "",
    ].join(" ").trimEnd())
  }

  const highlights = []
  for (const entry of summary.helpers ?? []) {
    const errors = entry.diagnostics.filter(record => record.severity === "error")
    highlights.push(...(errors.length ? errors : entry.diagnostics).slice(0, maximumPerHelper))
  }
  if (highlights.length) {
    push("주요 진단:")
    for (const record of highlights.slice(0, maximumDiagnostics)) {
      push(`  - ${formatDiagnostic(record)}`)
    }
    if (highlights.length > maximumDiagnostics) {
      push(`  - 그 외 ${highlights.length - maximumDiagnostics}건은 summary.json 을 확인하세요`)
    }
  }

  const unexplained = (summary.helpers ?? []).filter(
    entry => entry.status === "failed" && !entry.diagnostics.length && entry.failureHints?.length,
  )
  if (unexplained.length) {
    push("진단을 찾지 못한 실패 (로그 첫 오류 줄):")
    for (const entry of unexplained.slice(0, maximumHints)) {
      push(`  - ${entry.helper}: ${entry.failureHints[0]}`)
    }
  }

  const smokeFailures = (summary.smoke ?? []).filter(entry => entry.status === "failed")
  if (smokeFailures.length) {
    push("스모크 실패:")
    for (const entry of smokeFailures.slice(0, maximumSmoke)) {
      push(`  - ${entry.helper} ${entry.name}: ${entry.reason ?? "실패"}`)
    }
  }

  const logPaths = (summary.helpers ?? [])
    .filter(entry => entry.logPath && entry.status !== "skipped")
    .map(entry => entry.logPath)
  if (logPaths.length) {
    push(`전체 로그: ${logPaths.join(", ")}`)
  }
  push(`요약 파일: ${summary.summaryPath ?? "build-logs/summary.json"}`)
  return lines
}
