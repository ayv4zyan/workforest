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

export async function execAsync(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  const child = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { stdout, stderr, exitCode }
}

export async function execOkAsync(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const result = await execAsync(cmd, opts)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `${cmd.join(" ")} failed`
    throw new Error(detail)
  }
  return result.stdout
}
