import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { promisify } from "node:util"
import {
  resolvePowerShellExecutable,
  runPowerShellScript,
} from "../src/powershell.mjs"

const execFileAsync = promisify(execFile)

const [powerShellSource, mainSource, networkSource, nicSource] = await Promise.all([
  readFile(new URL("../src/powershell.mjs", import.meta.url), "utf8"),
  readFile(new URL("../electron/main.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/network.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/nic.mjs", import.meta.url), "utf8"),
])

test("런타임 PowerShell 본문은 명령줄 대신 표준입력으로 전달한다", () => {
  assert.match(
    powerShellSource,
    /\[IO\.StreamReader\]::new\(\[Console\]::OpenStandardInput\(\),\[Text\.UTF8Encoding\]::new\(\$false\),\$false\)/,
  )
  assert.match(powerShellSource, /child\.stdin\.end\(String\(script\), "utf8"\)/)
  assert.doesNotMatch(mainSource, /powershell\.exe|-EncodedCommand/)
  assert.doesNotMatch(networkSource, /powershell\.exe/)
  assert.doesNotMatch(nicSource, /powershell\.exe/)
})

test("Windows PowerShell은 PATH보다 시스템 고정 경로를 우선한다", () => {
  const expectedPath =
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  assert.equal(
    resolvePowerShellExecutable({
      platform: "win32",
      environment: {
        SystemRoot: "C:\\Windows",
        PATH: "",
      },
      fileExists: path => path === expectedPath,
    }),
    expectedPath,
  )
})

test("PATH에 PowerShell 폴더가 없어도 시스템 고정 경로로 실행한다", {
  skip: process.platform !== "win32",
}, async () => {
  const moduleUrl = new URL("../src/powershell.mjs", import.meta.url).href
  const childScript = `
import { runPowerShellScript } from ${JSON.stringify(moduleUrl)}
const { stdout } = await runPowerShellScript("Write-Output 314")
process.stdout.write(stdout)
`
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", childScript],
    {
      env: {
        ...process.env,
        PATH: "",
        Path: "",
      },
      windowsHide: true,
    },
  )
  assert.equal(stdout.trim(), "314")
})

test("메모리와 affinity helper는 PowerShell 없이 직접 분리 실행한다", () => {
  const helperStart = mainSource.indexOf("async function launchDetachedElectronHelper(")
  const helperEnd = mainSource.indexOf("async function stopAffinityHelper()", helperStart)
  const helperSource = mainSource.slice(helperStart, helperEnd)

  assert.match(helperSource, /spawn\(process\.execPath, helperArguments,/)
  assert.match(helperSource, /detached: true/)
  assert.match(helperSource, /child\.unref\(\)/)
  assert.match(helperSource, /launchMemoryHelper[\s\S]*launchDetachedElectronHelper\(helperArguments\)/)
  assert.match(helperSource, /launchAffinityHelper[\s\S]*launchDetachedElectronHelper\(helperArguments\)/)
})

test("메모리 helper의 주기적 게임 감지는 네이티브 프로세스 목록을 사용한다", () => {
  const detectionStart = mainSource.indexOf("async function detectMabinogi()")
  const detectionEnd = mainSource.indexOf("async function runMemoryHelper()", detectionStart)
  const detectionSource = mainSource.slice(detectionStart, detectionEnd)

  assert.match(detectionSource, /listNativeProcesses\(\)/)
  assert.match(detectionSource, /queryProcessPath\(processInfo\.pid\)/)
  assert.match(detectionSource, /matchesGameProcess\(/)
  assert.doesNotMatch(detectionSource, /runPowerShellScript|Get-Process|powershell\.exe/i)
})

test("PowerShell 표준입력 실행 결과를 UTF-8로 반환한다", {
  skip: process.platform !== "win32",
}, async () => {
  const { stdout } = await runPowerShellScript(
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Write-Output 123",
  )
  assert.equal(stdout.trim(), "123")
})

test("여러 줄 PowerShell 본문을 하나의 스크립트 블록으로 실행한다", {
  skip: process.platform !== "win32",
}, async () => {
  const { stdout } = await runPowerShellScript(`
function Get-TestValue {
  return "특수 네트워크 환경"
}
$value = Get-TestValue
if ($value) {
  [pscustomobject]@{
    value = $value
  } | ConvertTo-Json -Compress
  exit 0
}
throw "결과 없음"
`)
  assert.deepEqual(JSON.parse(stdout), { value: "특수 네트워크 환경" })
})

test("PowerShell 표준입력 실행이 제한 시간을 넘으면 종료한다", {
  skip: process.platform !== "win32",
}, async () => {
  await assert.rejects(
    runPowerShellScript("Start-Sleep -Seconds 5", { timeout: 100 }),
    error => error?.code === "ETIMEDOUT" && error?.killed === true,
  )
})
