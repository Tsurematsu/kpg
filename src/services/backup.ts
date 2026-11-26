import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ClusterDBInfo } from '../types/k8s.js';

export interface LocalBackupResult {
  filePath: string;
  bytesWritten: number;
  durationSec: number;
}

export function buildDefaultBackupPath(dbName: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
  return path.resolve(process.cwd(), 'backups', `${dbName}-${stamp}.sql`);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function runLocalBackup(
  db: ClusterDBInfo,
  destinationPath: string,
  onProgress?: (bytesWritten: number) => void,
): Promise<LocalBackupResult> {
  const primaryPod = db.currentPrimary;
  if (!primaryPod) {
    throw new Error(
      `La BD "${db.name}" no tiene un pod primario activo para realizar el backup.`,
    );
  }

  const resolvedPath = path.resolve(destinationPath);
  const parentDir = path.dirname(resolvedPath);
  fs.mkdirSync(parentDir, { recursive: true });

  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const outStream = fs.createWriteStream(resolvedPath);
    let bytesWritten = 0;
    let stderr = '';
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      outStream.destroy();
      try {
        if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath);
      } catch {
        // ignore cleanup error
      }
      reject(err);
    };

    const child = spawn(
      'kubectl',
      [
        'exec',
        '-n',
        db.namespace,
        primaryPod,
        '-c',
        'postgres',
        '--',
        'pg_dump',
        '-U',
        'postgres',
        '-d',
        'app',
        '--clean',
        '--if-exists',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      },
    );

    child.stdout.on('data', (chunk: Buffer) => {
      bytesWritten += chunk.length;
      outStream.write(chunk);
      onProgress?.(bytesWritten);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    outStream.on('error', (err) => {
      child.kill('SIGTERM');
      fail(err);
    });

    child.on('error', (err) => {
      fail(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(
          new Error(
            stderr.trim() || `pg_dump finalizó con código ${code ?? -1}.`,
          ),
        );
        return;
      }

      outStream.end(() => {
        if (settled) return;
        settled = true;
        const durationSec = Math.max(
          1,
          Math.round((Date.now() - startedAt) / 1000),
        );
        resolve({
          filePath: resolvedPath,
          bytesWritten,
          durationSec,
        });
      });
    });
  });
}
