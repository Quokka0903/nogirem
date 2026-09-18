import assert from "node:assert/strict"
import test from "node:test"
import {
  buildSummary,
  capDiagnostics,
  decodeBuildOutput,
  dedupeDiagnostics,
  defaultOutputEncoding,
  deriveStatus,
  encodingFromCodePage,
  evaluateGenerator,
  exitCodes,
  extractFailureHints,
  formatCompactReport,
  mergePathEnv,
  parseDiagnostics,
  pickBestCMake,
  relativizeProjectPaths,
  statusExitCode,
  summarizeHelperLog,
  visualStudioCMakeCandidates,
  visualStudioCMakeRelativePath,
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

test("코드 페이지로 나온 MSVC 진단을 깨뜨리지 않고 읽는다", () => {
  assert.equal(encodingFromCodePage("Active code page: 949"), "euc-kr")
  assert.equal(encodingFromCodePage("Active code page: 65001"), "utf-8")
  assert.equal(encodingFromCodePage("현재 코드 페이지: 936"), "gbk")
  // 모르는 코드 페이지나 읽을 수 없는 출력은 기본값으로 떨어진다
  assert.equal(encodingFromCodePage("Active code page: 437"), defaultOutputEncoding)
  assert.equal(encodingFromCodePage(""), defaultOutputEncoding)
  assert.equal(encodingFromCodePage(null), defaultOutputEncoding)

  // CP949로 나온 "선언되지 않은 식별자입니다"
  const cp949 = Buffer.from(
    "6d61696e2e63707028333232302c35293a206572726f722043323036353a2027"
    + "415544494f434c49454e545f41435449564154494f4e5f504152414d53273a20"
    + "bcb1bef0b5c7c1f620becac0ba20bdc4bab0c0dac0d4b4cfb4d92e",
    "hex",
  )
  const decoded = decodeBuildOutput(cp949, "euc-kr")
  assert.equal(
    decoded,
    "main.cpp(3220,5): error C2065: 'AUDIOCLIENT_ACTIVATION_PARAMS': 선언되지 않은 식별자입니다.",
  )
  // UTF-8로 그냥 읽으면 대체 문자로 깨진다
  assert.ok(decodeBuildOutput(cp949, "utf-8").includes("�"))
  // ASCII/UTF-8 출력은 대체 인코딩이 있어도 그대로 통과한다
  assert.equal(decodeBuildOutput(Buffer.from("error C2065: x"), "euc-kr"), "error C2065: x")
  assert.equal(decodeBuildOutput(Buffer.from("오류 C2065", "utf8"), "euc-kr"), "오류 C2065")
  assert.equal(decodeBuildOutput(Buffer.alloc(0), "euc-kr"), "")
  assert.equal(decodeBuildOutput(undefined), "")
  // 지원하지 않는 인코딩 이름을 받아도 던지지 않는다
  assert.equal(typeof decodeBuildOutput(cp949, "not-a-real-encoding"), "string")

  // 코드 페이지로 읽은 다음이라야 진단 message 가 온전하다
  const [record] = parseDiagnostics(decoded, { helper: "recorder-helper" })
  assert.equal(record.code, "C2065")
  assert.equal(record.line, 3220)
  assert.equal(record.column, 5)
  assert.equal(record.message, "'AUDIOCLIENT_ACTIVATION_PARAMS': 선언되지 않은 식별자입니다.")
})

test("Visual Studio 설치 경로에서 동봉 cmake 후보를 만든다", () => {
  const installs = [
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Community",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise",
    // 대소문자만 다른 중복은 한 번만 남는다
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\enterprise",
    "   ",
    "",
  ]
  const candidates = visualStudioCMakeCandidates(installs)
  assert.equal(candidates.length, 2)
  assert.equal(
    candidates[0],
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Community\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe",
  )
  assert.equal(
    candidates[1],
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe",
  )
  // 연도나 에디션을 상대 경로에 박아 두지 않는다 (vswhere -find 인자로도 쓴다)
  assert.equal(
    visualStudioCMakeRelativePath,
    "Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe",
  )
  assert.deepEqual(visualStudioCMakeCandidates([]), [])
  assert.deepEqual(visualStudioCMakeCandidates(undefined), [])
})

test("cmake 후보가 여럿이면 최소 버전을 넘는 가장 높은 것을 고른다", () => {
  const vs2019 = { path: "vs2019\\cmake.exe", version: "3.20.21032501" }
  const vs2022 = { path: "vs2022\\cmake.exe", version: "3.29.5" }
  const tooOld = { path: "vs2017\\cmake.exe", version: "3.12.18" }
  assert.equal(pickBestCMake([vs2019, vs2022, tooOld]), vs2022)
  assert.equal(pickBestCMake([tooOld, vs2019]), vs2019)
  // 전부 최소 버전 미만이면 그래도 가장 높은 것을 돌려줘 원인을 드러낸다
  assert.equal(pickBestCMake([tooOld, { path: "old\\cmake.exe", version: "3.5.0" }]), tooOld)
  assert.equal(pickBestCMake([]), null)
  assert.equal(pickBestCMake([{ path: "no-version\\cmake.exe", version: null }]), null)
  assert.equal(pickBestCMake(undefined), null)
})

test("PATH 밖 cmake는 자식 PATH 앞에 붙이고 중복 키를 남기지 않는다", () => {
  // Windows 는 환경 변수 이름의 대소문자를 가리지 않으므로 Path/PATH 가 함께 남으면 안 된다
  const merged = mergePathEnv({ Path: "C:\\Windows", HOME: "C:\\Users\\Tester" }, "C:\\vs\\cmake\\bin", ";")
  assert.deepEqual(Object.keys(merged).filter(key => key.toLowerCase() === "path"), ["PATH"])
  assert.equal(merged.PATH, "C:\\vs\\cmake\\bin;C:\\Windows")
  assert.equal(merged.HOME, "C:\\Users\\Tester")
  assert.equal(mergePathEnv({ PATH: "" }, "C:\\vs\\cmake\\bin", ";").PATH, "C:\\vs\\cmake\\bin")
  assert.equal(mergePathEnv({}, "C:\\vs\\cmake\\bin", ";").PATH, "C:\\vs\\cmake\\bin")
  // PATH 에서 찾았으면 환경을 건드리지 않는다 (undefined = 그대로 상속)
  assert.equal(mergePathEnv({ Path: "C:\\Windows" }, null), undefined)
  assert.equal(mergePathEnv({ Path: "C:\\Windows" }, ""), undefined)
})

test("도구가 없어 건너뛴 helper는 실패가 아니라 partial로 구분한다", () => {
  const built = { status: "ok" }
  const skipped = { status: "skipped" }
  const failed = { status: "failed" }
  assert.equal(deriveStatus({ helpers: [built, built], smoke: [] }), "ok")
  assert.equal(deriveStatus({ helpers: [built, built, built, skipped], smoke: [] }), "partial")
  assert.equal(deriveStatus({ helpers: [skipped, skipped], smoke: [] }), "missing-toolchain")
  assert.equal(deriveStatus({ helpers: [built, failed], smoke: [] }), "failed")
  // 스모크 실패도 전체를 실패로 끌어내린다
  assert.equal(
    deriveStatus({ helpers: [built, skipped], smoke: [{ status: "failed" }] }),
    "failed",
  )
  assert.equal(deriveStatus(), "ok")

  assert.equal(statusExitCode("ok"), exitCodes.ok)
  assert.equal(statusExitCode("failed"), exitCodes.failed)
  assert.equal(statusExitCode("unsupported-platform"), exitCodes.unsupportedPlatform)
  // partial 은 예상된 건너뜀이므로 실패(1)가 아니라 도구 없음(3)으로 알린다
  assert.equal(statusExitCode("partial"), exitCodes.missingToolchain)
  assert.equal(statusExitCode("missing-toolchain"), exitCodes.missingToolchain)
})

test("VS 동봉 cmake로 빌드하면 요약 줄에 출처를 표시한다", () => {
  const summary = buildSummary({
    status: "partial",
    exitCode: exitCodes.missingToolchain,
    generatedAt: "2026-09-18T00:00:00.000Z",
    durationMs: 120000,
    platform: { os: "win32", arch: "x64", node: "v20.20.2" },
    git: { shortSha: "72621e0", dirty: false },
    toolchain: {
      cmake: { available: true, version: "3.20.21032501", source: "visual-studio" },
      msvc: { available: true, version: "17.14.36811.4" },
      cargo: { available: false, version: null },
      rustc: { available: false, version: null },
      generator: {
        requested: "Visual Studio 16 2019",
        satisfiable: true,
        matched: "16.11.36631.11",
        reason: null,
      },
    },
    missing: ["cargo", "rustc"],
    helpers: [
      summarizeHelperLog({ helper: "radeon-helper", status: "ok", durationMs: 40000, text: "" }),
      summarizeHelperLog({ helper: "turbo-key", status: "skipped", reason: "cargo 없음", text: "" }),
    ],
    smoke: [{ helper: "radeon-helper", name: "status", status: "ok" }],
  })
  const lines = formatCompactReport(summary)
  assert.match(lines[0], /status=partial/)
  assert.match(lines[1], /cmake=3\.20\.21032501\(vs\)/)
  assert.match(lines[2], /satisfiable=yes toolset=16\.11\.36631\.11/)
  assert.equal(summary.counts.built, 1)
  assert.equal(summary.counts.skipped, 1)
  assert.equal(summary.counts.failed, 0)
  // PATH 에서 찾은 cmake 는 출처 표시가 붙지 않는다
  const onPath = formatCompactReport(buildSummary({
    status: "ok",
    exitCode: 0,
    generatedAt: "2026-09-18T00:00:00.000Z",
    toolchain: { cmake: { available: true, version: "3.29.2", source: "path" } },
    helpers: [],
    smoke: [],
  }))
  assert.match(onPath[1], /cmake=3\.29\.2 /)
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
