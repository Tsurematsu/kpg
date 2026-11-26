import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunKubectlOptions {
  stdin?: string;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export function runCommand(
  binary: string,
  args: string[],
  options: RunKubectlOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 1500);
          }, options.timeoutMs)
        : null;

    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8');
      stdout += text;
      options.onStdout?.(text);
    });

    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8');
      stderr += text;
      options.onStderr?.(text);
    });

    child.on('error', (err) => {
      stderr += err.message;
      finish(-1);
    });

    child.on('close', (code) => {
      finish(code ?? -1);
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export function runKubectl(
  args: string[],
  options: RunKubectlOptions = {},
): Promise<CommandResult> {
  return runCommand('kubectl', args, options);
}

export async function runKubectlJson<T>(
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const res = await runKubectl([...args, '-o', 'json'], {
    timeoutMs: options.timeoutMs ?? 15000,
  });

  if (res.code !== 0) {
    const msg = res.stderr.trim() || res.stdout.trim() || `kubectl exited with code ${res.code}`;
    throw new Error(msg);
  }

  return JSON.parse(res.stdout) as T;
}
