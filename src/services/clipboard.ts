import { spawn } from 'node:child_process';

export interface ClipboardResult {
  ok: boolean;
  method: string;
  error?: string;
}

function trySpawnClipboard(
  binary: string,
  args: string[],
  text: string,
  timeoutMs = 2500,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };

    let child;
    try {
      child = spawn(binary, args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        env: process.env,
      });
    } catch {
      finish(false);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      finish(false);
    }, timeoutMs);

    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));

    try {
      child.stdin.on('error', () => finish(false));
      child.stdin.write(text, 'utf8');
      child.stdin.end();
    } catch {
      finish(false);
    }
  });
}

function tryOsc52(text: string): boolean {
  if (!process.stdout.isTTY) return false;
  try {
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    process.stdout.write(`\x1b]52;c;${encoded}\x07`);
    return true;
  } catch {
    return false;
  }
}

export async function copyToClipboard(text: string): Promise<ClipboardResult> {
  if (!text) {
    return { ok: false, method: 'none', error: 'Texto vacío.' };
  }

  const platform = process.platform;

  if (platform === 'win32') {
    if (await trySpawnClipboard('clip', [], text)) {
      return { ok: true, method: 'clip' };
    }
    if (
      await trySpawnClipboard(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
        text,
      )
    ) {
      return { ok: true, method: 'powershell' };
    }
  } else if (platform === 'darwin') {
    if (await trySpawnClipboard('pbcopy', [], text)) {
      return { ok: true, method: 'pbcopy' };
    }
  } else {
    const candidates: Array<{ bin: string; args: string[]; label: string }> = [];
    if (process.env.WAYLAND_DISPLAY) {
      candidates.push({ bin: 'wl-copy', args: [], label: 'wl-copy' });
    }
    candidates.push(
      { bin: 'xclip', args: ['-selection', 'clipboard'], label: 'xclip' },
      { bin: 'xsel', args: ['--clipboard', '--input'], label: 'xsel' },
    );
    if (!process.env.WAYLAND_DISPLAY) {
      candidates.push({ bin: 'wl-copy', args: [], label: 'wl-copy' });
    }
    candidates.push({ bin: 'clip.exe', args: [], label: 'clip.exe' });

    for (const c of candidates) {
      if (await trySpawnClipboard(c.bin, c.args, text)) {
        return { ok: true, method: c.label };
      }
    }
  }

  if (tryOsc52(text)) {
    return { ok: true, method: 'OSC52' };
  }

  return {
    ok: false,
    method: 'none',
    error: 'No se encontró xclip/xsel/wl-copy ni soporte de portapapeles.',
  };
}
