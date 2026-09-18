import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import {
  createRadeonDaemonClient,
  getRadeonDaemonPaths,
} from "../src/radeon.mjs"

const electronMain = await readFile(
  new URL("../electron/main.mjs", import.meta.url),
  "utf8",
)
const electronPreload = await readFile(
  new URL("../electron/preload.cjs", import.meta.url),
  "utf8",
)
const applicationView = await readFile(
  new URL("../web/App.svelte", import.meta.url),
  "utf8",
)

test("Radeon 게임 세션은 daemon 클라이언트로 적용과 복구를 수행한다", () => {
  assert.match(electronMain, /createRadeonDaemonClient,/)
  assert.match(electronMain, /getRadeonDaemonPaths,/)
  assert.match(electronMain, /async function applyRadeonForGameSession\(\)/)
  assert.match(electronMain, /async function restoreRadeonForGameSession\(\)/)
  assert.match(electronMain, /await client\.apply\(\)/)
  assert.match(electronMain, /await client\.restore\(\)/)
})

test("게임 실행 여부 전이에 따라 적용과 복구를 나눈다", () => {
  const monitor = electronMain.slice(
    electronMain.indexOf("function startRadeonSessionMonitor()"),
    electronMain.indexOf("function stopRadeonSessionMonitor()"),
  )
  assert.match(monitor, /readRadeonSessionGameActive\(\)/)
  assert.match(monitor, /syncRadeonSessionWithGame\(gameActive\)/)

  const sync = electronMain.slice(
    electronMain.indexOf("async function syncRadeonSessionWithGame("),
    electronMain.indexOf("function startRadeonSessionMonitor()"),
  )
  assert.match(sync, /if \(gameActive\) await applyRadeonForGameSession\(\)/)
  assert.match(sync, /else await restoreRadeonForGameSession\(\)/)
})

test("같은 상태에서는 daemon을 다시 부르지 않는다", () => {
  const sync = electronMain.slice(
    electronMain.indexOf("async function syncRadeonSessionWithGame("),
    electronMain.indexOf("function startRadeonSessionMonitor()"),
  )
  assert.match(sync, /if \(gameActive === radeonSessionApplied\) return/)
  assert.match(sync, /if \(radeonSessionBusy\) return/)
})

test("Anti-Lag Next 거부는 실패가 아니라 거부로 기록한다", () => {
  assert.match(electronMain, /antiLagNextRefusalMessage,/)
  const sync = electronMain.slice(
    electronMain.indexOf("async function syncRadeonSessionWithGame("),
    electronMain.indexOf("function startRadeonSessionMonitor()"),
  )
  assert.match(sync, /const refused = message === antiLagNextRefusalMessage/)
  assert.match(sync, /radeonSessionLastAction = refused\s*\n\s*\? "refused"/)
})

test("기동 시 남은 영수증을 찾아 복구하고, 게임이 살아 있으면 세션을 잇는다", () => {
  const recovery = electronMain.slice(
    electronMain.indexOf("async function recoverRadeonSessionOnStartup()"),
    electronMain.indexOf("async function initializeRadeonSession()"),
  )
  assert.match(recovery, /await client\.readReceipt\(\)/)
  assert.match(recovery, /if \(!receipt\) return/)
  assert.match(recovery, /await detectMabinogi\(\)/)
  assert.match(recovery, /if \(gameActive\) \{/)
  assert.match(recovery, /radeonSessionLastAction = "resumed"/)
  assert.match(recovery, /await syncRadeonSessionWithGame\(false\)/)
})

test("설정이 꺼져 있어도 남은 영수증은 복구한다", () => {
  const initialize = electronMain.slice(
    electronMain.indexOf("async function initializeRadeonSession()"),
    electronMain.indexOf("async function setRadeonSessionEnabled("),
  )
  const recoverAt = initialize.indexOf("await recoverRadeonSessionOnStartup()")
  const guardAt = initialize.indexOf("if (!radeonSessionDesiredEnabled) return")
  assert.ok(recoverAt > 0, "기동 복구 호출이 있어야 한다")
  assert.ok(guardAt > recoverAt, "복구를 설정 확인보다 먼저 수행해야 한다")
})

test("기능을 끄면 적용 상태를 남기지 않는다", () => {
  const setter = electronMain.slice(
    electronMain.indexOf("async function setRadeonSessionEnabled("),
    electronMain.indexOf("async function finishRadeonSessionForExit()"),
  )
  assert.match(setter, /stopRadeonSessionMonitor\(\)/)
  assert.match(setter, /if \(radeonSessionApplied\) await syncRadeonSessionWithGame\(false\)/)
})

test("종료 시 게임이 살아 있으면 적용을 유지하고 아니면 되돌린다", () => {
  const exit = electronMain.slice(
    electronMain.indexOf("async function finishRadeonSessionForExit()"),
    electronMain.indexOf("function quotePowerShellLiteral("),
  )
  assert.match(exit, /if \(!radeonSessionApplied\)/)
  assert.match(exit, /await detectMabinogi\(\)/)
  assert.match(exit, /await restoreRadeonForGameSession\(\)/)
  assert.match(electronMain, /stopBlackboxHelper\(\),\s*\n\s*finishRadeonSessionForExit\(\),/)
})

test("설정은 userData의 radeon 폴더에 보관한다", () => {
  assert.match(electronMain, /function getRadeonPaths\(\)/)
  assert.match(electronMain, /join\(app\.getPath\("userData"\), "radeon"\)/)
  assert.match(electronMain, /settingsPath: join\(directory, "settings\.json"\)/)
  assert.match(electronMain, /sessionEnabled: Boolean\(sessionEnabled\)/)
})

test("IPC와 preload가 게임 세션 설정을 노출한다", () => {
  assert.match(electronMain, /ipcMain\.handle\("optimization:get-radeon-session"/)
  assert.match(electronMain, /ipcMain\.handle\("optimization:set-radeon-session-enabled"/)
  assert.match(
    electronMain,
    /허용되지 않은 Radeon 게임 세션 설정 요청입니다/,
    "메인 창이 아닌 요청은 거부해야 한다",
  )
  assert.match(electronPreload, /getRadeonSession: \(\) => ipcRenderer\.invoke\("optimization:get-radeon-session"\)/)
  assert.match(electronPreload, /setRadeonSessionEnabled: enabled =>/)
  assert.match(electronPreload, /onRadeonSessionChanged: callback =>/)
})

test("UI는 AMD일 때만 게임 세션 토글을 보여준다", () => {
  assert.match(applicationView, /\{#if services\.graphics\.data\.vendor === "amd"\}/)
  assert.match(applicationView, /마비노기 실행 중에만 적용/)
  assert.match(applicationView, /toggleRadeonSession\(event\.currentTarget\.checked\)/)
  assert.match(applicationView, /removeRadeonSessionListener\(\)/)
})

test("daemon 경로에 상태·제어·영수증이 모두 들어간다", () => {
  const paths = getRadeonDaemonPaths("C:\\work")
  assert.equal(paths.directory, "C:\\work")
  assert.ok(paths.statusPath.endsWith("status.json"))
  assert.ok(paths.controlPath.endsWith("control.json"))
  assert.ok(paths.receiptPath.endsWith("radeon-receipt.json"))
})

test("게임 세션 적용은 Anti-Lag Next 앞에서 apply 명령을 보내지 않는다", async () => {
  const written = []
  const status = {
    running: true,
    detected: true,
    gpus: [{ index: 0, name: "AMD Radeon", uniqueId: 1 }],
    settings: {
      antiLag: { supported: true, enabled: true, levelSupported: true, level: "antiLagNext" },
    },
    warnings: ["antiLagNext"],
    lastCommand: "probe",
    lastResult: "ok",
    error: null,
  }
  let lastCommand = "probe"
  const client = createRadeonDaemonClient({
    ...getRadeonDaemonPaths("C:\\work"),
    spawnHelper: () => ({ pid: 1, exitCode: null, once() {}, kill() {} }),
    readStatus: async () => ({ ...status, lastCommand, updatedAt: Date.now() }),
    writeControl: async (_path, control) => {
      written.push(control.command)
      lastCommand = control.command
    },
    removeFile: async () => {},
    wait: async () => {},
  })

  await client.start()
  await assert.rejects(() => client.apply(), /Anti-Lag Next/)
  assert.deepEqual(written, ["probe"], "apply 명령이 daemon에 전달되면 안 된다")
})

test("프레임 부스트가 꺼져 있어도 게임을 직접 확인한다", () => {
  const reader = electronMain.slice(
    electronMain.indexOf("async function readRadeonSessionGameActive()"),
    electronMain.indexOf("async function syncRadeonSessionWithGame("),
  )
  assert.match(reader, /if \(status\.running\) return status\.gameActive === true/)
  assert.match(reader, /return detectMabinogi\(\)/)
  assert.match(reader, /radeonSessionFallbackIntervalMs/)
})

test("종료와 기동 판정은 affinity helper 상태에 의존하지 않는다", () => {
  const exit = electronMain.slice(
    electronMain.indexOf("async function finishRadeonSessionForExit()"),
    electronMain.indexOf("function quotePowerShellLiteral("),
  )
  assert.doesNotMatch(exit, /readAffinityRuntimeStatus/)
  const recovery = electronMain.slice(
    electronMain.indexOf("async function recoverRadeonSessionOnStartup()"),
    electronMain.indexOf("async function initializeRadeonSession()"),
  )
  assert.doesNotMatch(recovery, /readAffinityRuntimeStatus/)
})

test("apply 도중의 중간 상태를 실패로 읽지 않는다", async () => {
  // daemon 은 영수증을 남긴 직후, Set* 을 시작하기 전에 상태를 한 번 기록한다.
  // 그 기록에는 lastCommand 만 들어 있고 lastResult 는 비어 있다.
  const base = {
    running: true,
    detected: true,
    gpus: [{ index: 0, name: "AMD Radeon", uniqueId: 1 }],
    settings: {
      verticalSync: { supported: true, mode: "alwaysOff" },
      antiLag: { supported: true, enabled: true, levelSupported: false, level: null },
    },
    warnings: [],
    error: null,
  }
  let reads = 0
  const client = createRadeonDaemonClient({
    ...getRadeonDaemonPaths("C:\work"),
    spawnHelper: () => ({ pid: 1, exitCode: null, once() {}, kill() {} }),
    readStatus: async () => {
      reads += 1
      if (reads <= 2) return { ...base, lastCommand: "probe", lastResult: "ok", updatedAt: Date.now() }
      // 세 번째 읽기가 apply 중간 상태, 그 다음이 결론이다.
      if (reads === 3) return { ...base, lastCommand: "apply", lastResult: "", updatedAt: Date.now() }
      return { ...base, lastCommand: "apply", lastResult: "ok", updatedAt: Date.now() }
    },
    writeControl: async () => {},
    removeFile: async () => {},
    wait: async () => {},
  })

  await client.start()
  const result = await client.apply()
  assert.equal(result.lastResult, "ok", "중간 상태를 건너뛰고 결론을 기다려야 한다")
})
