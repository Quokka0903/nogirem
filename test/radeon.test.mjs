import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  antiLagNextRefusalMessage,
  createRadeonControlCommand,
  createRadeonDaemonClient,
  createRadeonManager,
  getRadeonDaemonPaths,
  normalizeRadeonCapabilities,
  normalizeRadeonDaemonSettings,
  normalizeRadeonDaemonStatus,
  normalizeRadeonReceipt,
  normalizeRadeonResult,
  radeonDaemonStatusToHelperResult,
  resolveRadeonApplyRefusal,
  runRadeonHelperWithFallback,
} from "../src/radeon.mjs"

const nativeSource = await readFile(
  new URL("../native/radeon-helper/main.cpp", import.meta.url),
  "utf8",
)

function helperResult(overrides = {}) {
  return {
    detected: true,
    gpus: [{ name: "AMD Radeon 테스트 GPU" }],
    goals: [
      {
        key: "verticalSyncOff",
        label: "수직 동기화 항상 끄기",
        supported: true,
        met: true,
        currentValue: "항상 끄기",
      },
      {
        key: "enhancedSyncOff",
        label: "Enhanced Sync 끄기",
        supported: false,
        met: false,
        currentValue: "지원 안 함",
      },
      {
        key: "antiLagOn",
        label: "Radeon Anti-Lag 켜기",
        supported: true,
        met: true,
        currentValue: "켜기",
      },
    ],
    allMet: true,
    reason: null,
    ...overrides,
  }
}

test("지원하지 않는 Radeon 목표는 완료 판정에서 제외한다", () => {
  const result = normalizeRadeonResult(
    helperResult(),
    { available: true, enabled: false },
  )

  assert.equal(result.vendor, "amd")
  assert.equal(result.allMet, true)
  assert.equal(result.goalsList[1].supported, false)
})

test("마비노기 내부 수직 동기화가 켜져 있으면 목표가 미완료다", () => {
  const result = normalizeRadeonResult(
    helperResult(),
    { available: true, enabled: true },
  )

  assert.equal(result.allMet, false)
  assert.equal(result.goalsList[0].met, false)
  assert.match(result.goalsList[0].currentValue, /게임 설정 켜기/)
})

test("Radeon 적용은 전역 helper 적용 후 게임 수직 동기화를 끄고 검증한다", async () => {
  const calls = []
  let gameEnabled = true
  const manager = createRadeonManager({
    runHelper: async apply => {
      calls.push(["helper", apply])
      return helperResult()
    },
    queryGameVerticalSync: async () => ({
      available: true,
      enabled: gameEnabled,
    }),
    setGameVerticalSync: async enabled => {
      calls.push(["game", enabled])
      gameEnabled = enabled
    },
  })

  const result = await manager.apply()

  assert.equal(result.allMet, true)
  assert.deepEqual(calls, [["helper", true], ["game", false]])
})

test("Radeon 적용 후 남은 목표가 있으면 실패한다", async () => {
  const manager = createRadeonManager({
    runHelper: async () => helperResult({
      goals: [
        {
          key: "antiLagOn",
          label: "Radeon Anti-Lag 켜기",
          supported: true,
          met: false,
          currentValue: "끄기",
        },
      ],
    }),
    queryGameVerticalSync: async () => ({ available: true, enabled: false }),
    setGameVerticalSync: async () => {},
  })

  await assert.rejects(() => manager.apply(), /Radeon Anti-Lag 켜기/)
})

test("Radeon helper 비정상 종료 시 레거시 드라이버 모드로 재시도한다", async () => {
  const calls = []
  const result = await runRadeonHelperWithFallback(async args => {
    calls.push(args)
    if (calls.length === 1) throw new Error("helper crash")
    return { stdout: JSON.stringify(helperResult()) }
  }, true)

  assert.equal(result.detected, true)
  assert.deepEqual(calls, [
    ["--apply"],
    ["--legacy-driver", "--apply"],
  ])
})

test("Radeon helper가 결과 출력 후 종료되면 JSON 결과를 복구한다", async () => {
  const error = new Error("helper exit")
  error.code = 3221225477
  error.stdout = JSON.stringify(helperResult())

  const result = await runRadeonHelperWithFallback(async () => {
    throw error
  }, false)

  assert.equal(result.detected, true)
})

test("Radeon helper가 두 번 모두 출력 없이 종료되면 종료 코드를 안내한다", async () => {
  await assert.rejects(
    () => runRadeonHelperWithFallback(async () => {
      const error = new Error("helper exit")
      error.code = 3221225477
      throw error
    }, false),
    /종료 코드 0xC0000005/,
  )
})

test("Radeon helper는 결과 출력 후 정적 종료 정리 없이 프로세스를 끝낸다", () => {
  assert.match(nativeSource, /std::fflush\(nullptr\)/)
  assert.match(nativeSource, /ExitProcess\(static_cast<UINT>\(exitCode\)\)/)
})

function daemonStatus(overrides = {}) {
  return {
    running: true,
    pid: 4242,
    mode: "daemon",
    legacyDriver: false,
    detected: true,
    gpus: [{ index: 0, name: "AMD Radeon 테스트 GPU", uniqueId: 7 }],
    capabilities: {
      verticalSync: { supported: true },
      enhancedSync: { supported: false },
      chill: { supported: true },
      antiLag: { supported: true, levelSupported: true, level: "antiLag" },
      frameRateTarget: { supported: true, minFps: 30, maxFps: 300 },
    },
    settings: {
      verticalSync: { supported: true, mode: "alwaysOff", mixed: false },
      enhancedSync: { supported: false, enabled: false, mixed: false },
      chill: { supported: true, enabled: false, mixed: false },
      antiLag: {
        supported: true,
        enabled: true,
        levelSupported: true,
        level: "antiLag",
        mixed: false,
      },
      frameRateTarget: { supported: true, enabled: false, fps: 0, mixed: false },
    },
    receipt: null,
    warnings: [],
    lastCommand: null,
    lastResult: null,
    error: null,
    updatedAt: 1700000000000,
    ...overrides,
  }
}

function acknowledgeControl(command, control, current) {
  if (command === "stop") {
    return { ...current, running: false, lastCommand: "stop", lastResult: "ok" }
  }
  return {
    ...current,
    lastCommand: command,
    lastResult: "ok",
    error: null,
    updatedAt: control.requestedAt + 1,
  }
}

function createDaemonHarness(initialStatus = daemonStatus(), onControl = acknowledgeControl) {
  const calls = []
  let clock = 1000
  let current = initialStatus
  const child = {
    pid: 4242,
    exitCode: null,
    once: () => {},
    kill: () => {
      child.exitCode = 0
    },
  }
  const paths = getRadeonDaemonPaths("C:\\nogirem\\radeon")
  const client = createRadeonDaemonClient({
    ...paths,
    helperPath: "C:\\nogirem\\radeon-helper.exe",
    parentPid: 99,
    spawnHelper: (path, args) => {
      calls.push(["spawn", args])
      return child
    },
    readStatus: async path => (path === paths.receiptPath ? current.receipt : current),
    writeControl: async (path, value) => {
      calls.push(["control", value.command, value.requestId])
      current = onControl(value.command, value, current)
    },
    removeFile: async () => {},
    wait: async () => {},
    now: () => {
      clock += 1
      return clock
    },
  })
  return { client, calls, paths, setStatus: value => { current = value } }
}

test("Radeon daemon 제어 명령은 명령 이름과 요청 시각을 함께 직렬화한다", () => {
  const command = createRadeonControlCommand("probe", { now: () => 1234 })

  assert.deepEqual(command, {
    command: "probe",
    requestId: "probe-1234",
    requestedAt: 1234,
  })
})

test("Radeon daemon 제어 명령은 지정한 요청 ID를 유지한다", () => {
  const command = createRadeonControlCommand("stop", { requestId: "custom", now: () => 7 })

  assert.equal(command.requestId, "custom")
  assert.equal(command.requestedAt, 7)
})

test("Radeon daemon은 알 수 없는 제어 명령을 거부한다", () => {
  assert.throws(() => createRadeonControlCommand("reboot"), /지원하지 않는 Radeon daemon 명령/)
})

test("Radeon daemon 상태는 기능 지원 정보와 함께 정규화된다", () => {
  const status = normalizeRadeonDaemonStatus(daemonStatus())

  assert.equal(status.running, true)
  assert.equal(status.detected, true)
  assert.equal(status.gpus[0].uniqueId, 7)
  assert.deepEqual(status.capabilities.antiLag, {
    supported: true,
    levelSupported: true,
    level: "antiLag",
  })
  assert.deepEqual(status.capabilities.frameRateTarget, {
    supported: true,
    minFps: 30,
    maxFps: 300,
  })
  assert.equal(status.capabilities.enhancedSync.supported, false)
  assert.equal(status.settings.verticalSync.mode, "alwaysOff")
})

test("Radeon daemon 기능 조회 실패는 미지원으로 낮춰 읽는다", () => {
  const capabilities = normalizeRadeonCapabilities({
    verticalSync: null,
    antiLag: { supported: false, levelSupported: true, level: "antiLagNext" },
    frameRateTarget: { supported: false, minFps: 30, maxFps: 300 },
    chill: "지원 안 함",
  })

  assert.equal(capabilities.verticalSync.supported, false)
  assert.equal(capabilities.chill.supported, false)
  assert.deepEqual(capabilities.antiLag, {
    supported: false,
    levelSupported: false,
    level: null,
  })
  assert.deepEqual(capabilities.frameRateTarget, {
    supported: false,
    minFps: null,
    maxFps: null,
  })
})

test("Radeon daemon 상태가 없거나 GPU가 없으면 감지되지 않은 것으로 읽는다", () => {
  assert.equal(normalizeRadeonDaemonStatus(null), null)
  assert.equal(normalizeRadeonDaemonStatus({ detected: true, gpus: [] }).detected, false)
  assert.equal(
    normalizeRadeonDaemonStatus({ lastCommand: "launch", lastResult: "성공" }).lastCommand,
    null,
  )
  assert.equal(
    normalizeRadeonDaemonStatus({ lastCommand: "launch", lastResult: "성공" }).lastResult,
    null,
  )
})

test("Radeon daemon 설정의 알 수 없는 수직 동기화 값은 버린다", () => {
  const settings = normalizeRadeonDaemonSettings({
    verticalSync: { supported: true, mode: "언제나 끄기", mixed: false },
    frameRateTarget: { supported: true, enabled: true, fps: "60", mixed: false },
  })

  assert.equal(settings.verticalSync.mode, null)
  assert.equal(settings.frameRateTarget.fps, 0)
})

test("Radeon daemon 영수증은 GPU별 이전 설정 형태로 정규화된다", () => {
  const receipt = normalizeRadeonReceipt({
    version: 1,
    capturedAt: 1700000000000,
    applied: false,
    gpus: [
      {
        index: 0,
        name: "AMD Radeon 테스트 GPU",
        uniqueId: 7,
        before: {
          verticalSync: { supported: true, mode: "alwaysOn", mixed: false },
          enhancedSync: { supported: true, enabled: true, mixed: false },
          chill: { supported: true, enabled: true, mixed: false },
          antiLag: {
            supported: true,
            enabled: false,
            levelSupported: true,
            level: "antiLag",
            mixed: false,
          },
          frameRateTarget: { supported: false, enabled: false, fps: 0, mixed: false },
        },
      },
    ],
  })

  assert.equal(receipt.version, 1)
  assert.equal(receipt.applied, false)
  assert.equal(receipt.gpus[0].uniqueId, 7)
  assert.equal(receipt.gpus[0].before.verticalSync.mode, "alwaysOn")
  assert.equal(receipt.gpus[0].before.antiLag.enabled, false)
  assert.equal(receipt.gpus[0].before.antiLag.level, "antiLag")
  assert.equal(normalizeRadeonReceipt(null), null)
  assert.equal(normalizeRadeonReceipt({ version: 1 }), null)
})

test("Radeon daemon 상태는 기존 helper 결과 형태로 변환된다", () => {
  const raw = radeonDaemonStatusToHelperResult(normalizeRadeonDaemonStatus(daemonStatus()))
  const result = normalizeRadeonResult(raw, { available: true, enabled: false })

  assert.deepEqual(raw.goals.map(goal => goal.key), [
    "verticalSyncOff",
    "enhancedSyncOff",
    "antiLagOn",
    "chillOff",
  ])
  assert.equal(raw.goals[0].currentValue, "항상 끄기")
  assert.equal(raw.goals[1].supported, false)
  assert.equal(result.vendor, "amd")
  assert.equal(result.allMet, true)
})

test("Radeon daemon에서 GPU별 설정이 다르면 목표를 미완료로 본다", () => {
  const raw = radeonDaemonStatusToHelperResult(normalizeRadeonDaemonStatus(daemonStatus({
    settings: {
      ...daemonStatus().settings,
      chill: { supported: true, enabled: false, mixed: true },
    },
  })))

  assert.equal(raw.goals[3].met, false)
  assert.equal(raw.goals[3].currentValue, "GPU별 설정 다름")
  assert.equal(raw.allMet, false)
})

test("Anti-Lag Next가 켜져 있으면 적용을 거부한다", () => {
  const warned = normalizeRadeonDaemonStatus(daemonStatus({ warnings: ["antiLagNext"] }))
  const levelled = normalizeRadeonDaemonStatus(daemonStatus({
    capabilities: {
      ...daemonStatus().capabilities,
      antiLag: { supported: true, levelSupported: true, level: "antiLagNext" },
    },
  }))

  assert.equal(resolveRadeonApplyRefusal(warned), antiLagNextRefusalMessage)
  assert.equal(resolveRadeonApplyRefusal(levelled), antiLagNextRefusalMessage)
  assert.equal(resolveRadeonApplyRefusal(normalizeRadeonDaemonStatus(daemonStatus())), null)
})

test("Anti-Lag Next 상태에서는 apply 명령을 보내지 않는다", async () => {
  const harness = createDaemonHarness(daemonStatus({ warnings: ["antiLagNext"] }))
  await harness.client.start()

  await assert.rejects(() => harness.client.apply(), new RegExp(antiLagNextRefusalMessage))
  assert.deepEqual(
    harness.calls.filter(call => call[0] === "control").map(call => call[1]),
    ["probe"],
  )
})

test("Radeon daemon 클라이언트는 실행 인자와 명령 순서를 유지한다", async () => {
  const harness = createDaemonHarness()
  await harness.client.start()
  await harness.client.apply()
  await harness.client.restore()
  await harness.client.stop()

  assert.deepEqual(harness.calls[0], ["spawn", [
    "--daemon",
    `--status-path=${harness.paths.statusPath}`,
    `--control-path=${harness.paths.controlPath}`,
    "--parent-pid=99",
  ]])
  assert.deepEqual(
    harness.calls.filter(call => call[0] === "control").map(call => call[1]),
    ["probe", "apply", "restore", "stop"],
  )
})

test("Radeon daemon 명령이 실패로 끝나면 상태의 오류를 알린다", async () => {
  const harness = createDaemonHarness(daemonStatus(), (command, control, current) => ({
    ...current,
    lastCommand: command,
    lastResult: "error",
    error: "되돌릴 이전 설정 기록이 없습니다",
    updatedAt: control.requestedAt + 1,
  }))
  await harness.client.start()

  await assert.rejects(() => harness.client.restore(), /되돌릴 이전 설정 기록이 없습니다/)
})

test("Radeon daemon 영수증 파일은 클라이언트에서 읽어 확인할 수 있다", async () => {
  const receipt = {
    version: 1,
    capturedAt: 1700000000000,
    applied: true,
    gpus: [{ index: 0, name: "AMD Radeon 테스트 GPU", uniqueId: 7, before: {} }],
  }
  const harness = createDaemonHarness(daemonStatus({ receipt }))
  await harness.client.start()

  const stored = await harness.client.readReceipt()

  assert.equal(stored.applied, true)
  assert.equal(stored.gpus[0].uniqueId, 7)
  assert.equal(stored.gpus[0].before.antiLag.supported, false)
})

test("Radeon helper는 적용 전에 영수증을 먼저 디스크에 남긴다", () => {
  const applyCommand = nativeSource.slice(
    nativeSource.indexOf("void runApplyCommand("),
    nativeSource.indexOf("void runRestoreCommand("),
  )
  const refusal = applyCommand.indexOf("ANTILAGNEXT")
  const persistReceipt = applyCommand.indexOf("writeFileAtomic(receiptPath")
  const applySettings = applyCommand.indexOf("applyGpuSettings(")

  assert.ok(refusal > 0)
  assert.ok(persistReceipt > 0)
  assert.ok(applySettings > 0)
  assert.ok(refusal < persistReceipt)
  assert.ok(persistReceipt < applySettings)
})

test("Radeon helper는 Anti-Lag 레벨을 ANTILAG으로만 설정한다", () => {
  assert.match(nativeSource, /SetLevel\(ANTILAG\)/)
  assert.doesNotMatch(nativeSource, /SetLevel\s*\(\s*ANTILAGNEXT/)
})
