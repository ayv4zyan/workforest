export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
  timedOut?: boolean
}

export function exec(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): ExecResult {
  const result = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs,
  })
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }
}

export function execOk(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): string {
  const result = exec(cmd, opts)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `${cmd.join(" ")} failed`
    throw new Error(detail)
  }
  return result.stdout
}

export async function execAsync(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const timed = opts.timeoutMs !== undefined
  const child = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
    // Own process group so a timeout can kill git and the SSH child it spawned.
    detached: timed,
  })
  let timedOut = false
  const killGroup = () => {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
    } else {
      child.kill("SIGKILL")
    }
  }
  // detached starts a new session, so exit must still reap a pull if the TUI quits.
  if (timed) process.on("exit", killGroup)
  const timer = timed
    ? setTimeout(() => {
        if (child.exitCode !== null) return
        timedOut = true
        killGroup()
      }, opts.timeoutMs)
    : undefined
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { stdout, stderr, exitCode: exitCode ?? 1, timedOut }
  } finally {
    if (timer) clearTimeout(timer)
    if (timed) process.off("exit", killGroup)
  }
}

export async function execOkAsync(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<string> {
  const result = await execAsync(cmd, opts)
  if (result.timedOut) throw new Error(`${cmd.join(" ")} timed out after ${opts.timeoutMs}ms`)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `${cmd.join(" ")} failed`
    throw new Error(detail)
  }
  return result.stdout
}
