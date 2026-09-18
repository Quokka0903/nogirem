import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { resolve } from "node:path"
import electronPath from "electron"

const host = "127.0.0.1"
const viteEntryPath = resolve("node_modules", "vite", "bin", "vite.js")
let viteProcess = null
let electronProcess = null
let stopping = false

function reserveFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, host, () => {
      const address = server.address()
      server.close(error => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
  })
}

async function waitForNogirem(url, timeoutMs = 15000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (viteProcess?.exitCode !== null) {
      throw new Error(`Vite 개발 서버가 종료되었습니다 (${viteProcess.exitCode})`)
    }
    try {
      const response = await fetch(url)
      const document = await response.text()
      if (response.ok && document.includes("마비노기 꿔 부스터")) return
    } catch {
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Nogirem 개발 서버가 ${timeoutMs}ms 안에 준비되지 않았습니다`)
}

function stop() {
  if (stopping) return
  stopping = true
  if (electronProcess?.exitCode === null) electronProcess.kill()
  if (viteProcess?.exitCode === null) viteProcess.kill()
}

process.once("SIGINT", stop)
process.once("SIGTERM", stop)
process.once("exit", stop)

try {
  const port = await reserveFreePort()
  const serverUrl = `http://${host}:${port}`
  console.log(`Nogirem 개발 서버: ${serverUrl}`)
  viteProcess = spawn(process.execPath, [
    viteEntryPath,
    "--host",
    host,
    "--port",
    String(port),
    "--strictPort",
  ], {
    cwd: process.cwd(),
    stdio: "inherit",
  })
  viteProcess.once("exit", code => {
    if (!stopping && code !== 0) process.exitCode = code ?? 1
    stop()
  })
  await waitForNogirem(serverUrl)
  electronProcess = spawn(electronPath, [
    ".",
    "--dev",
    `--dev-server-url=${serverUrl}`,
  ], {
    cwd: process.cwd(),
    stdio: "inherit",
  })
  electronProcess.once("exit", code => {
    if (code && !stopping) {
      process.exitCode = code
      stop()
    }
  })
} catch (error) {
  console.error(error)
  process.exitCode = 1
  stop()
}

