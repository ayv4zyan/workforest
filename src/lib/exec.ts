export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
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
