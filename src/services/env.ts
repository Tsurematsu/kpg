import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildConnectionUrlsForUser,
  type NodePortInfo,
  type NodePortUserCredential,
  type TlsPolicyMode,
} from './access.js';
import type { ClusterDBInfo } from '../types/k8s.js';

export type EnvConnectionMode = 'nodeport' | 'internal';
export type EnvWriteMode = 'overwrite' | 'append';

export interface EnvGenerationOptions {
  db: ClusterDBInfo;
  users: NodePortUserCredential[];
  connectionMode: EnvConnectionMode;
  nodePortInfo: NodePortInfo | null;
  tlsMode: TlsPolicyMode;
  database?: string;
}

export interface GeneratedEnvResult {
  contentFull: string;
  contentMasked: string;
  host: string;
  port: number;
  sslMode: string;
  missingPasswordUsers: string[];
}

export interface DirectoryEntry {
  name: string;
  fullPath: string;
  isParent?: boolean;
}

const IGNORED_DIRS = new Set(['node_modules', '.git']);

function toEnvVarSuffix(username: string): string {
  return username
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'USER';
}

function formatEnvValue(raw: string): string {
  if (!raw) return '""';
  if (/[\s#"'`$\\]/.test(raw)) {
    const escaped = raw
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$');
    return `"${escaped}"`;
  }
  return raw;
}

function getSslModeParam(tlsMode: TlsPolicyMode): string {
  if (tlsMode === 'disabled') return 'disable';
  if (tlsMode === 'required') return 'require';
  return 'prefer';
}

export function getInternalServiceHost(db: ClusterDBInfo): string {
  return `${db.name}-rw.${db.namespace}.svc.cluster.local`;
}

export function generateEnvContent(
  options: EnvGenerationOptions,
): GeneratedEnvResult {
  const {
    db,
    users,
    connectionMode,
    nodePortInfo,
    tlsMode,
    database = 'app',
  } = options;

  const useNodePort = connectionMode === 'nodeport' && nodePortInfo !== null;
  const host = useNodePort
    ? nodePortInfo.hostIp
    : getInternalServiceHost(db);
  const port = useNodePort ? nodePortInfo.nodePort : 5432;
  const effectiveTls = useNodePort ? nodePortInfo.tlsMode : tlsMode;
  const sslMode = getSslModeParam(effectiveTls);

  const missingPasswordUsers = users
    .filter((u) => !u.password)
    .map((u) => u.username);

  const buildLines = (masked: boolean): string => {
    const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const connDesc = useNodePort
      ? `NodePort (${nodePortInfo.serviceName} -> ${host}:${port})`
      : `Service interno k8s (${host}:${port})`;

    const lines: string[] = [
      `# Generado por kpg · BD: ${db.name} (ns: ${db.namespace}) · ${nowIso} UTC`,
      `# Conexión: ${connDesc} · TLS: ${sslMode}`,
      `PGHOST=${host}`,
      `PGPORT=${port}`,
      `PGDATABASE=${database}`,
      `PGSSLMODE=${sslMode}`,
      '',
    ];

    if (users.length === 1) {
      const u = users[0];
      const urls = buildConnectionUrlsForUser(
        host,
        port,
        u.username,
        u.password,
        effectiveTls,
        database,
      );
      const passValue = u.password
        ? masked
          ? '********'
          : u.password
        : '<SIN_GUARDAR>';

      lines.push(
        `# Usuario: ${u.username} (${u.permissions.join(', ') || 'LOGIN'})`,
      );
      lines.push(`PGUSER=${u.username}`);
      lines.push(`PGPASSWORD=${formatEnvValue(passValue)}`);
      lines.push(`DATABASE_URL="${masked ? urls.urlMasked : urls.urlFull}"`);
    } else {
      for (const u of users) {
        const suffix = toEnvVarSuffix(u.username);
        const urls = buildConnectionUrlsForUser(
          host,
          port,
          u.username,
          u.password,
          effectiveTls,
          database,
        );
        const passValue = u.password
          ? masked
            ? '********'
            : u.password
          : '<SIN_GUARDAR>';

        lines.push(
          `# Usuario: ${u.username} (${u.permissions.join(', ') || 'LOGIN'})`,
        );
        lines.push(`DB_USER_${suffix}=${u.username}`);
        lines.push(`DB_PASSWORD_${suffix}=${formatEnvValue(passValue)}`);
        lines.push(
          `DATABASE_URL_${suffix}="${masked ? urls.urlMasked : urls.urlFull}"`,
        );
        lines.push('');
      }
    }

    return `${lines.join('\n').trimEnd()}\n`;
  };

  return {
    contentFull: buildLines(false),
    contentMasked: buildLines(true),
    host,
    port,
    sslMode,
    missingPasswordUsers,
  };
}

export function listSubdirectories(
  dirPath: string,
  showHidden = false,
): { currentDir: string; entries: DirectoryEntry[]; error?: string } {
  const resolved = path.resolve(dirPath);
  const parent = path.dirname(resolved);
  const entries: DirectoryEntry[] = [];

  if (parent !== resolved) {
    entries.push({
      name: '.. (subir un nivel)',
      fullPath: parent,
      isParent: true,
    });
  }

  try {
    const raw = fs.readdirSync(resolved, { withFileTypes: true });
    const subdirs = raw
      .filter((d) => {
        if (!d.isDirectory()) return false;
        if (IGNORED_DIRS.has(d.name)) return false;
        if (!showHidden && d.name.startsWith('.')) return false;
        return true;
      })
      .map((d) => ({
        name: d.name,
        fullPath: path.join(resolved, d.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    entries.push(...subdirs);
    return { currentDir: resolved, entries };
  } catch (err) {
    return {
      currentDir: resolved,
      entries,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function getHomeDir(): string {
  return os.homedir();
}

export function getLaunchDir(): string {
  return process.cwd();
}

export function buildDefaultEnvFilename(dbName: string): string {
  return `.env.${dbName}`;
}

export function fileExists(targetPath: string): boolean {
  try {
    return fs.existsSync(path.resolve(targetPath));
  } catch {
    return false;
  }
}

export function writeEnvFile(
  targetPath: string,
  content: string,
  mode: EnvWriteMode,
): { filePath: string; bytesWritten: number } {
  const resolved = path.resolve(targetPath);
  const parentDir = path.dirname(resolved);
  fs.mkdirSync(parentDir, { recursive: true });

  if (mode === 'append' && fs.existsSync(resolved)) {
    const existing = fs.readFileSync(resolved, 'utf8');
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    fs.appendFileSync(resolved, `${separator}${content}`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } else {
    fs.writeFileSync(resolved, content, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  try {
    fs.chmodSync(resolved, 0o600);
  } catch {
    // Ignore chmod issues on non-POSIX filesystems
  }

  const stat = fs.statSync(resolved);
  return {
    filePath: resolved,
    bytesWritten: stat.size,
  };
}
