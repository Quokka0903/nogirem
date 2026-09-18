import assert from "node:assert/strict"
import test from "node:test"
import {
  buildSummary,
  capDiagnostics,
  dedupeDiagnostics,
  evaluateGenerator,
  extractFailureHints,
  formatCompactReport,
  parseDiagnostics,
  relativizeProjectPaths,
  summarizeHelperLog,
} from "../scripts/native-log.mjs"

const msvcLog = [
  "MSBuild version 16.11.2+f32259642 for .NET Framework",
  "  main.cpp",
  "native/recorder-helper/main.cpp(412,18): error C2065: 'kBufferSize': undeclared identifier [native/recorder-helper/build/recorder-helper.vcxproj]",
  "native/recorder-helper/main.cpp(87): warning C4996: 'GetVersionExW': was declared deprecated",
  "  1>native/recorder-helper/main.cpp(412,18): error C2065: 'kBufferSize': undeclared identifier",
  "LINK : fatal error LNK1104: cannot open file 'mfplat.lib'",
  "main.obj : error LNK2019: unresolved external symbol wmain referenced in function wmainCRTStartup",
  "cl : Command line warning D9002 : ignoring unknown option '/await'",
].join("\n")

const cmakeLog = [
  "-- Selecting Windows SDK version 10.0.22621.0",
  "CMake Error at CMakeLists.txt:12 (add_executable):",
  "  Cannot find source file:",
  "",
  "    missing-source.cpp",
  "",
  "  Tried extensions .c .cpp .cxx",
  "",
  "Call Stack (most recent call first):",
  "  CMakeLists.txt:3 (include)",
  "",
  "CMake Warning (dev) at CMakeLists.txt:4 (set):",
  "  implicitly converting 'BOOL' to 'STRING'",
  "",
  "CMake Error: Could not create named generator Visual Studio 16 2019",
  "-- Configuring incomplete, errors occurred!",
].join("\n")

const cargoLog = [
  "   Compiling turbo-key-helper v0.1.7 (native/turbo-key)",
  "error[E0382]: borrow of moved value: `shared`",
  "   --> native/turbo-key/src/main.rs:742:13",
  "    |",
  "742 |             shared.stopping.store(true, Ordering::Release);",
  "    |             ^^^^^^ value borrowed here after move",
  "",
  "warning: unused variable: `ideal_processor`",
  "  --> native/turbo-key/src/main.rs:210:9",
  "",
  "error: could not compile `turbo-key-helper` (bin \"turbo-key-helper\") due to 1 previous error",
  "error: linker `link.exe` not found",
].join("\n")

test("MSVC 컴파일러와 링커 출력을 진단 레코드로 정규화한다", () => {
  const records = parseDiagnostics(msvcLog, { helper: "recorder-helper" })
  assert.deepEqual(records[0], {
    helper: "recorder-helper",
    stage: "compile",
    severity: "error",
    code: "C2065",
    file: "native/recorder-helper/main.cpp",
    line: 412,
    column: 18,
    message: "'kBufferSize': undeclared identifier",
  })
  assert.deepEqual(records[1], {
    helper: "recorder-helper",
    stage: "compile",
    severity: "warning",
    code: "C4996",
    file: "native/recorder-helper/main.cpp",
    line: 87,
    column: null,
    message: "'GetVersionExW': was declared deprecated",
  })
  const link = records.find(record => record.code === "LNK1104")
  assert.equal(link.severity, "error")
  assert.equal(link.stage, "link")
  assert.equal(link.file, "LINK")
  assert.equal(link.message, "cannot open file 'mfplat.lib'")
  assert.equal(records.find(record => record.code === "LNK2019").stage, "link")
  const commandLine = records.find(record => record.code === "D9002")
  assert.equal(commandLine.severity, "warning")
  assert.equal(commandLine.stage, "build")
})

test("CMake 오류는 들여쓴 이어지는 줄까지 한 건으로 묶는다", () => {
  const records = parseDiagnostics(cmakeLog, { helper: "radeon-helper" })
  assert.equal(records.length, 3)
  assert.deepEqual(records[0], {
    helper: "radeon-helper",
    stage: "configure",
    severity: "error",
    code: "add_executable",
    file: "CMakeLists.txt",
    line: 12,
    column: null,
    message: "Cannot find source file: missing-source.cpp Tried extensions .c .cpp .cxx",
  })
  assert.equal(records[1].severity, "warning")
  assert.equal(records[1].line, 4)
  assert.equal(records[1].message, "implicitly converting 'BOOL' to 'STRING'")
  assert.deepEqual(records[2], {
    helper: "radeon-helper",
    stage: "configure",
    severity: "error",
    code: null,
    file: null,
    line: null,
    column: null,
    message: "Could not create named generator Visual Studio 16 2019",
  })
})

test("cargo 오류는 다음 줄의 --> 위치를 합쳐 기록한다", () => {
  const records = parseDiagnostics(cargoLog, { helper: "turbo-key" })
  assert.deepEqual(records[0], {
    helper: "turbo-key",
    stage: "cargo",
    severity: "error",
    code: "E0382",
    file: "native/turbo-key/src/main.rs",
    line: 742,
    column: 13,
    message: "borrow of moved value: `shared`",
  })
  assert.deepEqual(records[1], {
    helper: "turbo-key",
    stage: "cargo",
    severity: "warning",
    code: null,
    file: "native/turbo-key/src/main.rs",
    line: 210,
    column: 9,
    message: "unused variable: `ideal_processor`",
  })
  const bare = records.filter(record => record.file === null)
  assert.equal(bare.length, 2)
  assert.equal(bare[1].message, "linker `link.exe` not found")
  assert.equal(records.every(record => record.stage === "cargo"), true)
})

test("한 로그에 섞인 CMake·MSVC·cargo 출력을 등장 순서대로 읽는다", () => {
  const records = parseDiagnostics([cmakeLog, msvcLog, cargoLog].join("\n"))
  assert.deepEqual(
    records.map(record => record.stage).filter((stage, index, all) => stage !== all[index - 1]),
    ["configure", "compile", "link", "build", "cargo"],
  )
  assert.equal(records.every(record => record.helper === null), true)
})

test("같은 진단이 반복되면 한 건으로 합친다", () => {
  const records = parseDiagnostics(msvcLog, { helper: "recorder-helper" })
  const duplicates = records.filter(record => record.code === "C2065")
  assert.equal(duplicates.length, 2)
  const unique = dedupeDiagnostics(records)
  assert.equal(unique.filter(record => record.code === "C2065").length, 1)
  assert.equal(unique.length, records.length - 1)
})

test("진단 개수를 제한할 때 오류를 먼저 남기고 원래 순서를 지킨다", () => {
  const records = [
    { severity: "warning", code: "C4996", message: "w1" },
    { severity: "error", code: "C2065", message: "e1" },
    { severity: "warning", code: "C4244", message: "w2" },
    { severity: "error", code: "C2143", message: "e2" },
    { severity: "warning", code: "C4100", message: "w3" },
  ]
  const capped = capDiagnostics(records, 3)
  assert.deepEqual(capped.diagnostics.map(record => record.message), ["w1", "e1", "e2"])
  assert.equal(capped.truncated, 2)
  assert.deepEqual(capDiagnostics(records, 10), { diagnostics: records, truncated: 0 })
  assert.deepEqual(capDiagnostics(records, 0), { diagnostics: [], truncated: 5 })
  const errorsOnly = capDiagnostics(records, 2)
  assert.deepEqual(errorsOnly.diagnostics.map(record => record.message), ["e1", "e2"])
})

test("helper 요약은 중복을 뺀 개수와 잘라낸 진단 수를 함께 보고한다", () => {
  const entry = summarizeHelperLog({
    helper: "recorder-helper",
    status: "failed",
    exitCode: 1,
    durationMs: 12345.6,
    script: "scripts/build-recorder-helper.mjs",
    logPath: "build-logs/recorder-helper.log",
    artifact: "native/recorder-helper/bin/recorder-helper.exe",
    text: msvcLog,
    limit: 2,
  })
  assert.equal(entry.errorCount, 3)
  assert.equal(entry.warningCount, 2)
  assert.equal(entry.diagnostics.length, 2)
  assert.equal(entry.diagnosticsTruncated, 3)
  assert.equal(entry.diagnostics.every(record => record.severity === "error"), true)
  assert.equal(entry.durationMs, 12346)
  assert.equal(entry.logPath, "build-logs/recorder-helper.log")
})

test("컴파일러 진단이 없는 실패는 로그의 오류 줄을 힌트로 남긴다", () => {
  const crashLog = [
    "# turbo-key · node scripts/build-turbo-key.mjs",
    "node:internal/child_process:285",
    "      const err = new ErrnoException(exitCode, syscall);",
    "",
    "Error: spawn cargo ENOENT",
    "    at ChildProcess._handle.onexit (node:internal/child_process:285:19)",
    "  code: 'ENOENT',",
    "  syscall: 'spawn cargo',",
    "Node.js v20.20.2",
  ].join("\n")
  // 스택 프레임 같은 잡음은 건너뛰고 오류처럼 보이는 줄만 고른다
  assert.deepEqual(extractFailureHints(crashLog, { limit: 2 }), [
    "Error: spawn cargo ENOENT",
    "code: 'ENOENT',",
  ])
  const entry = summarizeHelperLog({ helper: "turbo-key", status: "failed", text: crashLog })
  assert.equal(entry.diagnostics.length, 0)
  assert.equal(entry.failureHints[0], "Error: spawn cargo ENOENT")
  // 오류처럼 보이는 줄이 없으면 마지막 줄로 대신한다
  assert.deepEqual(extractFailureHints("첫 줄\n둘째 줄\n셋째 줄", { limit: 1 }), ["셋째 줄"])
  assert.deepEqual(extractFailureHints(""), [])
  // 진단을 찾은 실패는 힌트를 만들지 않는다
  assert.deepEqual(
    summarizeHelperLog({ helper: "recorder-helper", status: "failed", text: msvcLog }).failureHints,
    [],
  )
  assert.deepEqual(
    summarizeHelperLog({ helper: "radeon-helper", status: "ok", text: crashLog }).failureHints,
    [],
  )
})

test("빌드 요약은 helper와 스모크 결과를 집계한다", () => {
  const summary = buildSummary({
    status: "failed",
    exitCode: 1,
    generatedAt: "2026-09-18T00:00:00.000Z",
    durationMs: 9000,
    platform: { os: "win32", arch: "x64", node: "v20.20.2" },
    git: { sha: "5d62ca4abc", shortSha: "5d62ca4", branch: "main", dirty: false },
    toolchain: { cmake: { available: true, version: "3.29.2" } },
    missing: ["cargo"],
    helpers: [
      summarizeHelperLog({ helper: "radeon-helper", status: "ok", text: "" }),
      summarizeHelperLog({ helper: "recorder-helper", status: "failed", text: msvcLog }),
      summarizeHelperLog({ helper: "turbo-key", status: "skipped", reason: "cargo 없음", text: "" }),
    ],
    smoke: [
      { helper: "radeon-helper", name: "status", status: "ok" },
      { helper: "recorder-helper", name: "drives", status: "skipped" },
      { helper: "turbo-key", name: "args", status: "skipped" },
    ],
  })
  assert.equal(summary.schemaVersion, 1)
  assert.deepEqual(summary.counts, {
    helpers: 3,
    built: 1,
    failed: 1,
    skipped: 1,
    errors: 3,
    warnings: 2,
    smokePassed: 1,
    smokeFailed: 0,
    smokeSkipped: 2,
  })
  assert.deepEqual(summary.missing, ["cargo"])
})

test("요약 출력은 30줄 안쪽으로 접히고 로그 위치를 알려준다", () => {
  const summary = buildSummary({
    status: "failed",
    exitCode: 1,
    generatedAt: "2026-09-18T00:00:00.000Z",
    durationMs: 95200,
    platform: { os: "win32", arch: "x64", node: "v20.20.2" },
    git: { sha: "5d62ca4abc", shortSha: "5d62ca4", branch: "main", dirty: true },
    toolchain: {
      cmake: { available: true, version: "3.29.2" },
      msvc: { available: true, version: "16.11.34" },
      cargo: { available: false, version: null },
      rustc: { available: false, version: null },
      generator: { requested: "Visual Studio 16 2019", satisfiable: true, reason: null },
    },
    missing: ["cargo", "rustc"],
    helpers: [
      summarizeHelperLog({
        helper: "recorder-helper",
        status: "failed",
        durationMs: 31000,
        logPath: "build-logs/recorder-helper.log",
        text: [cmakeLog, msvcLog].join("\n"),
      }),
      summarizeHelperLog({ helper: "turbo-key", status: "skipped", reason: "cargo 없음", text: "" }),
    ],
    smoke: [
      { helper: "recorder-helper", name: "drives", status: "failed", reason: "종료 코드 1" },
      { helper: "turbo-key", name: "args", status: "skipped", reason: "빌드하지 않음" },
    ],
  })
  summary.summaryPath = "build-logs/summary.json"
  const lines = formatCompactReport(summary)
  assert.ok(lines.length <= 30, `요약이 ${lines.length}줄로 너무 깁니다`)
  assert.equal(lines.every(line => line.startsWith("[native-verify] ")), true)
  assert.match(lines[0], /^\[native-verify\] status=failed sha=5d62ca4\+dirty platform=win32\/x64 node=v20\.20\.2 elapsed=95\.2s$/)
  assert.match(lines[1], /cmake=3\.29\.2 msvc=16\.11\.34 cargo=없음 rustc=없음/)
  assert.match(lines[2], /generator="Visual Studio 16 2019" satisfiable=yes/)
  assert.ok(lines.some(line => /recorder-helper failed .*errors=\d+ warnings=\d+ smoke=failed/.test(line)))
  assert.ok(lines.some(line => /turbo-key +skipped.*smoke=skipped · cargo 없음$/.test(line)))
  assert.ok(lines.some(line => line.includes("C2065") || line.includes("add_executable")))
  assert.ok(lines.some(line => line.includes("스모크 실패:")))
  assert.ok(lines.some(line => line.includes("전체 로그: build-logs/recorder-helper.log")))
  assert.equal(lines.at(-1), "[native-verify] 요약 파일: build-logs/summary.json")
})

test("빌드 도구가 없으면 생성기를 쓸 수 없다고 알린다", () => {
  assert.deepEqual(
    evaluateGenerator({ cmakeVersion: null, instances: [] }),
    {
      requested: "Visual Studio 16 2019",
      installed: [],
      matched: null,
      satisfiable: false,
      reason: "cmake를 찾지 못했습니다 · Visual Studio C++ 도구 집합을 찾지 못했습니다",
      cmakeReason: "cmake를 찾지 못했습니다",
      toolsetReason: "Visual Studio C++ 도구 집합을 찾지 못했습니다",
    },
  )
  const oldCMake = evaluateGenerator({
    cmakeVersion: "3.19.8",
    instances: [{ version: "16.11.34" }],
  })
  assert.equal(oldCMake.satisfiable, false)
  assert.match(oldCMake.cmakeReason, /최소 요구 버전 3\.20/)
  assert.equal(oldCMake.toolsetReason, null)
  // cmake가 없어도 Visual Studio 버전 문제는 따로 드러나야 한다
  const only2022 = evaluateGenerator({
    cmakeVersion: null,
    instances: [{ name: "Visual Studio Build Tools 2022", version: "17.14.36811.4" }],
  })
  assert.equal(only2022.satisfiable, false)
  assert.equal(only2022.matched, null)
  assert.equal(
    only2022.toolsetReason,
    "설치된 Visual Studio는 17.14.36811.4뿐이라 v16(2019) 도구 집합이 필요합니다",
  )
  assert.match(only2022.reason, /cmake를 찾지 못했습니다 · 설치된 Visual Studio는/)
  const ok = evaluateGenerator({
    cmakeVersion: "3.29.2",
    instances: [
      { name: "Visual Studio Community 2022", version: "17.10.3" },
      { name: "Visual Studio Build Tools 2019", version: "16.11.34" },
    ],
  })
  assert.equal(ok.satisfiable, true)
  assert.equal(ok.matched, "16.11.34")
  assert.equal(ok.reason, null)
  assert.equal(ok.cmakeReason, null)
  assert.equal(ok.toolsetReason, null)
})

test("저장소 절대 경로를 상대 경로로 바꿔 마스킹 뒤에도 파일을 찾을 수 있다", () => {
  const root = "C:\\Users\\Tester\\nogirem"
  const text = [
    "C:\\Users\\Tester\\nogirem\\native\\radeon-helper\\main.cpp(41,3): error C2065: 'x': undeclared identifier",
    "C:/Users/Tester/nogirem/native/radeon-helper/main.cpp(42,3): warning C4996: deprecated",
    "\"path\":\"C:\\\\Users\\\\Tester\\\\nogirem\\\\build-logs\"",
    "작업 폴더: C:\\Users\\Tester\\nogirem",
  ].join("\n")
  const relativized = relativizeProjectPaths(text, root)
  assert.doesNotMatch(relativized, /Tester/)
  assert.match(relativized, /^native\\radeon-helper\\main\.cpp\(41,3\)/m)
  assert.match(relativized, /^native\/radeon-helper\/main\.cpp\(42,3\)/m)
  assert.match(relativized, /"path":"build-logs"/)
  assert.match(relativized, /작업 폴더: \./)
  const records = parseDiagnostics(relativized, { helper: "radeon-helper" })
  assert.equal(records[0].file, "native/radeon-helper/main.cpp")
  assert.equal(records[1].file, "native/radeon-helper/main.cpp")
  assert.equal(relativizeProjectPaths(text, ""), text)
})
