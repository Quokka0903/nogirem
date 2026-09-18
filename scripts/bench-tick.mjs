import { createProcessMetadataCache, listNativeProcesses } from "../src/affinity.mjs"

// affinity.mjs가 pollIntervalMs마다 수행하는 listProcesses() 작업량을 측정한다.
// cold = 틱마다 캐시를 새로 만들어 모든 PID를 다시 조회하는 캐시 도입 이전 경로,
// warm = 캐시를 유지해 불변 메타데이터를 재사용하는 현재 경로.
const argumentValue = name => {
  const prefix = `--${name}=`
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length)
}

const iterations = Number(argumentValue("iterations") ?? 50)
const warmups = Number(argumentValue("warmups") ?? 3)
const mode = argumentValue("mode") ?? "both"

if (!Number.isInteger(iterations) || iterations < 1) {
  throw new Error("--iterations는 1 이상의 정수여야 합니다")
}
if (!Number.isInteger(warmups) || warmups < 0) {
  throw new Error("--warmups는 0 이상의 정수여야 합니다")
}
if (!["cold", "warm", "both"].includes(mode)) {
  throw new Error("--mode는 cold, warm, both 중 하나여야 합니다")
}

const megabytes = value => Number((value / 1024 / 1024).toFixed(2))
const round = value => Number(value.toFixed(2))

const measure = label => {
  const freshCachePerTick = label === "cold"
  const sharedCache = createProcessMetadataCache()
  const runTick = () => (freshCachePerTick ? createProcessMetadataCache() : sharedCache)
    .attach(listNativeProcesses())

  for (let index = 0; index < warmups; index += 1) runTick()

  globalThis.gc?.()
  const probeBefore = process.memoryUsage()
  const processCount = runTick().length
  const probeAfter = process.memoryUsage()

  globalThis.gc?.()
  const before = process.memoryUsage()
  const durations = []
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint()
    runTick()
    durations.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  const after = process.memoryUsage()

  const sorted = [...durations].sort((left, right) => left - right)
  const total = durations.reduce((sum, value) => sum + value, 0)

  return {
    mode: label,
    iterations,
    processCount,
    meanMsPerTick: round(total / iterations),
    medianMsPerTick: round(sorted[Math.floor(sorted.length / 2)]),
    minMsPerTick: round(sorted[0]),
    maxMsPerTick: round(sorted.at(-1)),
    tickHeapUsedMiB: megabytes(probeAfter.heapUsed - probeBefore.heapUsed),
    tickArrayBuffersMiB: megabytes(probeAfter.arrayBuffers - probeBefore.arrayBuffers),
    runHeapUsedDeltaMiB: megabytes(after.heapUsed - before.heapUsed),
    runArrayBuffersDeltaMiB: megabytes(after.arrayBuffers - before.arrayBuffers),
    runRssDeltaMiB: megabytes(after.rss - before.rss),
    gcExposed: typeof globalThis.gc === "function",
  }
}

const results = (mode === "both" ? ["cold", "warm"] : [mode]).map(measure)

for (const result of results) {
  console.log(`[bench:${result.mode}] ${JSON.stringify(result, null, 2)}`)
}

if (results.length === 2) {
  const [cold, warm] = results
  const speedup = round(cold.medianMsPerTick / warm.medianMsPerTick)
  console.log(
    `틱당 ${cold.medianMsPerTick}ms → ${warm.medianMsPerTick}ms (${speedup}배), `
    + `틱당 힙 ${cold.tickHeapUsedMiB}MiB → ${warm.tickHeapUsedMiB}MiB, `
    + `틱당 버퍼 ${cold.tickArrayBuffersMiB}MiB → ${warm.tickArrayBuffersMiB}MiB `
    + `(프로세스 ${warm.processCount}개, ${iterations}회 측정)`,
  )
}
