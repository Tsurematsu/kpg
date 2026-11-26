import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  KPG_NS_USAGE_LABEL,
  createClusterDB,
  deleteClusterDB,
  generateUniqueLabelId,
  getClusterSnapshot,
  getDefaultStorageClass,
  getNamespaces,
  getNodes,
  getSelectableNamespaces,
  isDefaultNamespace,
  labelNamespaceInUse,
  listClusterDBs,
  syncNamespaceUsageLabel,
} from './cnpg.js';
import {
  PROTECTED_SYSTEM_ROLES,
  copyKpgCredentialsSecret,
  getAllStoredUserPasswords,
  getClusterRawPgHba,
  getNetworkAccess,
  setNetworkAccessMode,
  syncAppSecretPassword,
  type NetworkAccessInfo,
  type NetworkAccessMode,
} from './access.js';
import { formatBytes } from './backup.js';
import type { ClusterDBInfo } from '../types/k8s.js';
import type {
  MigrationProgressEvent,
  MigrationStep,
  MigrationStepStatus,
} from './migration.js';

export interface NamespaceMigrationSummary {
  dbName: string;
  sourceNamespace: string;
  targetNamespace: string;
  agentNode: string;
  newPrimary: string;
  bytesDumped: number;
  credentialsCopied: number;
  accessMode: NetworkAccessMode;
  accessDetail: string;
  sourceLabelRemoved: boolean;
  durationSec: number;
}

export function createInitialNamespaceMigrationSteps(): MigrationStep[] {
  return [
    {
      id: 'validate',
      label: 'Validar BD, namespace destino y configuración actual',
      status: 'pending',
    },
    {
      id: 'dump_source',
      label: 'Exportar roles personalizados y volcado SQL (pg_dump)',
      status: 'pending',
    },
    {
      id: 'label_target_ns',
      label: `Marcar namespace destino (${KPG_NS_USAGE_LABEL}=true)`,
      status: 'pending',
    },
    {
      id: 'create_target_cluster',
      label: 'Crear Cluster CNPG en namespace destino',
      status: 'pending',
    },
    {
      id: 'wait_target_ready',
      label: 'Esperar pod primario Healthy (1/1) en destino',
      status: 'pending',
    },
    {
      id: 'restore_data',
      label: 'Restaurar roles y datos SQL en namespace destino',
      status: 'pending',
    },
    {
      id: 'sync_secrets',
      label: 'Copiar credenciales y sincronizar clave app',
      status: 'pending',
    },
    {
      id: 'cleanup_source',
      label: 'Eliminar origen, recrear acceso y limpiar label origen',
      status: 'pending',
    },
    {
      id: 'verify_final',
      label: 'Comprobación final y limpieza de temporales',
      status: 'pending',
    },
  ];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function execCaptureStdout(
  namespace: string,
  podName: string,
  pgArgs: string[],
  timeoutMs = 120000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'kubectl',
      ['exec', '-n', namespace, podName, '-c', 'postgres', '--', ...pgArgs],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Tiempo de espera agotado ejecutando ${pgArgs[0]}.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() || `${pgArgs[0]} finalizó con código ${code ?? -1}.`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

function execDumpToFile(
  namespace: string,
  podName: string,
  pgArgs: string[],
  filePath: string,
  onBytes?: (bytes: number) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const outStream = fs.createWriteStream(filePath, { mode: 0o600 });
    let bytes = 0;
    let stderr = '';
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      outStream.destroy();
      reject(err);
    };

    const child = spawn(
      'kubectl',
      ['exec', '-n', namespace, podName, '-c', 'postgres', '--', ...pgArgs],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      },
    );

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      outStream.write(chunk);
      onBytes?.(bytes);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    outStream.on('error', (err) => {
      child.kill('SIGTERM');
      fail(err);
    });

    child.on('error', (err) => fail(err));

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(
          new Error(
            stderr.trim() || `${pgArgs[0]} finalizó con código ${code ?? -1}.`,
          ),
        );
        return;
      }
      outStream.end(() => {
        if (settled) return;
        settled = true;
        resolve(bytes);
      });
    });
  });
}

function execRestoreFromFile(
  namespace: string,
  podName: string,
  database: string,
  filePath: string,
  stopOnError = true,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '-i',
      '-n',
      namespace,
      podName,
      '-c',
      'postgres',
      '--',
      'psql',
      '-U',
      'postgres',
      '-d',
      database,
      '-X',
      '-q',
    ];
    if (stopOnError) {
      args.push('-v', 'ON_ERROR_STOP=1');
    }

    const child = spawn('kubectl', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const inStream = fs.createReadStream(filePath);
    let stderr = '';
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      inStream.destroy();
      reject(err);
    };

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    inStream.on('error', (err) => {
      child.kill('SIGTERM');
      fail(err);
    });

    child.stdin.on('error', () => {
      // Handle EPIPE gracefully; close event will report actual exit code
    });

    child.on('error', (err) => fail(err));

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() || `psql restore finalizó con código ${code ?? -1}.`,
          ),
        );
        return;
      }
      resolve();
    });

    inStream.pipe(child.stdin);
  });
}

function extractRoleNameFromStatement(stmt: string): string | null {
  const m = stmt.match(
    /^\s*(?:CREATE|ALTER|DROP)\s+ROLE\s+(?:"([^"]+)"|([a-zA-Z0-9_$-]+))/i,
  );
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function isProtectedRoleName(roleName: string): boolean {
  return PROTECTED_SYSTEM_ROLES.has(roleName) || roleName.startsWith('pg_');
}

function filterGlobalsSql(rawSql: string): string {
  const lines = rawSql.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) continue;

    // Skip cluster-level config lines that aren't needed or could conflict
    if (/^SET\s+/i.test(trimmed) || /^SELECT\s+pg_catalog\.set_config/i.test(trimmed)) {
      continue;
    }

    const roleName = extractRoleNameFromStatement(trimmed);
    if (roleName) {
      if (isProtectedRoleName(roleName)) continue;
      // CNPG creates "app" automatically; skip CREATE ROLE app but keep ALTER ROLE app (password/attrs)
      if (/^CREATE\s+ROLE\s+/i.test(trimmed) && roleName === 'app') {
        continue;
      }
      kept.push(line);
      continue;
    }

    // Keep GRANT membership statements that don't target protected system roles
    if (/^GRANT\s+/i.test(trimmed)) {
      const mentionsProtected = [...PROTECTED_SYSTEM_ROLES].some((sysRole) =>
        new RegExp(`\\b${sysRole}\\b`).test(trimmed),
      );
      if (!mentionsProtected) {
        kept.push(line);
      }
    }
  }

  return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}

export async function migrateClusterDBNamespace(
  db: ClusterDBInfo,
  targetNamespace: string,
  hostIp: string,
  onProgress: (event: MigrationProgressEvent) => void,
): Promise<NamespaceMigrationSummary> {
  const startedAt = Date.now();
  const steps = createInitialNamespaceMigrationSteps();
  let currentPercent = 0;

  const emit = (
    stepId: string,
    status: MigrationStepStatus,
    percent: number,
    detail?: string,
    log?: string,
  ) => {
    currentPercent = Math.max(currentPercent, Math.min(100, percent));
    for (const s of steps) {
      if (s.id === stepId) {
        s.status = status;
        if (detail !== undefined) s.detail = detail;
      }
    }
    onProgress({
      percent: currentPercent,
      steps: steps.map((s) => ({ ...s })),
      log,
    });
  };

  let activeStepId = 'validate';
  let tmpDir: string | null = null;

  try {
    // ── STEP 1: VALIDATE ───────────────────────────────────────────────
    activeStepId = 'validate';
    emit(
      'validate',
      'running',
      4,
      'Verificando BD origen, namespaces y acceso actual...',
      `Validando traslado de "${db.name}" (${db.namespace} → ${targetNamespace})...`,
    );

    const [freshDbs, allNamespaces, allNodes] = await Promise.all([
      listClusterDBs(),
      getNamespaces(),
      getNodes(),
    ]);

    const freshDb = freshDbs.find(
      (d) => d.name === db.name && d.namespace === db.namespace,
    );
    if (!freshDb) {
      throw new Error(
        `No se encontró la BD "${db.name}" en el namespace "${db.namespace}".`,
      );
    }
    if (freshDb.hibernated) {
      throw new Error(
        `La BD "${db.name}" está apagada (hibernada). Enciéndela primero con (p).`,
      );
    }
    if (freshDb.instances !== 1 || freshDb.replicas.length > 0) {
      throw new Error(
        `La BD "${db.name}" tiene ${freshDb.instances} instancias. Reduce sus réplicas a 0 antes de mover de namespace.`,
      );
    }
    if (
      !freshDb.healthy ||
      freshDb.readyInstances !== 1 ||
      !freshDb.currentPrimary
    ) {
      throw new Error(
        `La BD "${db.name}" no está Healthy (${freshDb.phase}, ready: ${freshDb.readyInstances}/${freshDb.instances}).`,
      );
    }

    const selectable = getSelectableNamespaces(allNamespaces);
    const targetNsInfo = selectable.find((ns) => ns.name === targetNamespace);
    if (!targetNsInfo) {
      throw new Error(
        `El namespace "${targetNamespace}" no existe, no está Active o está excluido (default/sistema).`,
      );
    }
    if (targetNamespace === freshDb.namespace) {
      throw new Error(
        'El namespace destino no puede ser igual al namespace actual.',
      );
    }
    if (
      freshDbs.some(
        (d) => d.name === freshDb.name && d.namespace === targetNamespace,
      )
    ) {
      throw new Error(
        `Ya existe una BD llamada "${freshDb.name}" en el namespace "${targetNamespace}".`,
      );
    }

    const agentNode = freshDb.primaryNode;
    if (!agentNode || agentNode === '—' || agentNode === 'Pending') {
      throw new Error('No se pudo determinar el agente donde corre el primario.');
    }

    const [rawPgHba, storedCreds, sourceAccess, defaultSc] = await Promise.all([
      getClusterRawPgHba(freshDb),
      getAllStoredUserPasswords(freshDb),
      getNetworkAccess(freshDb, hostIp),
      getDefaultStorageClass(),
    ]);

    const appPassword = storedCreds.app?.password ?? null;
    const labelId = freshDb.labelId ?? generateUniqueLabelId(allNodes);
    const storageSize = freshDb.storageSize || '5Gi';
    const storageClass = freshDb.storageClass || defaultSc;
    const imageName =
      freshDb.imageName || 'ghcr.io/cloudnative-pg/postgresql:16.8';

    emit(
      'validate',
      'done',
      10,
      `${freshDb.namespace} → ${targetNamespace} · Agente ${agentNode} · Acceso: ${sourceAccess?.mode ?? 'close'}`,
      `Validado: ${freshDb.currentPrimary} @ ${agentNode}, storage ${storageSize} (${storageClass}).`,
    );

    // ── STEP 2: DUMP SOURCE ────────────────────────────────────────────
    activeStepId = 'dump_source';
    emit(
      'dump_source',
      'running',
      14,
      'Exportando roles globales y base de datos app...',
      `Ejecutando pg_dumpall --globals-only y pg_dump sobre ${freshDb.currentPrimary}...`,
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpg-nsmove-'));
    try {
      fs.chmodSync(tmpDir, 0o700);
    } catch {
      // ignore chmod issues on non-POSIX filesystems
    }

    const globalsPath = path.join(tmpDir, 'globals.sql');
    const appDumpPath = path.join(tmpDir, 'app.sql');

    const rawGlobals = await execCaptureStdout(
      freshDb.namespace,
      freshDb.currentPrimary,
      ['pg_dumpall', '-U', 'postgres', '--globals-only'],
    );
    const filteredGlobals = filterGlobalsSql(rawGlobals);
    fs.writeFileSync(globalsPath, filteredGlobals, {
      encoding: 'utf8',
      mode: 0o600,
    });

    const bytesDumped = await execDumpToFile(
      freshDb.namespace,
      freshDb.currentPrimary,
      ['pg_dump', '-U', 'postgres', '-d', 'app', '--clean', '--if-exists'],
      appDumpPath,
      (bytes) => {
        emit(
          'dump_source',
          'running',
          22,
          `Volcando base "app": ${formatBytes(bytes)} exportados...`,
        );
      },
    );

    emit(
      'dump_source',
      'done',
      28,
      `Exportados ${formatBytes(bytesDumped)} + roles globales`,
      `Volcado completado (${formatBytes(bytesDumped)}). La BD origen sigue intacta.`,
    );

    // ── STEP 3: LABEL TARGET NAMESPACE ─────────────────────────────────
    activeStepId = 'label_target_ns';
    emit(
      'label_target_ns',
      'running',
      31,
      `Aplicando ${KPG_NS_USAGE_LABEL}=true en "${targetNamespace}"...`,
      `Registrando uso de kpg en el namespace "${targetNamespace}"...`,
    );
    await labelNamespaceInUse(targetNamespace);
    emit(
      'label_target_ns',
      'done',
      34,
      `${targetNamespace} marcado con ${KPG_NS_USAGE_LABEL}=true`,
      `Namespace destino "${targetNamespace}" marcado con ${KPG_NS_USAGE_LABEL}=true.`,
    );

    // ── STEP 4: CREATE TARGET CLUSTER ──────────────────────────────────
    activeStepId = 'create_target_cluster';
    emit(
      'create_target_cluster',
      'running',
      38,
      `Aplicando Cluster "${freshDb.name}" en "${targetNamespace}"...`,
      `Creando Cluster "${freshDb.name}" en "${targetNamespace}" (agente ${agentNode})...`,
    );

    await createClusterDB(
      {
        name: freshDb.name,
        namespace: targetNamespace,
        agentNode,
        storageSize,
        storageClass,
        imageName,
        labelId,
        pgHba: rawPgHba ?? undefined,
        skipNodeLabelRollback: Boolean(freshDb.labelId),
      },
      (msg) => {
        emit('create_target_cluster', 'running', 42, msg);
      },
    );

    emit(
      'create_target_cluster',
      'done',
      45,
      `Cluster "${freshDb.name}" creado en "${targetNamespace}"`,
      `Cluster aplicado en "${targetNamespace}". Esperando inicialización del pod...`,
    );

    // ── STEP 5: WAIT TARGET READY ──────────────────────────────────────
    activeStepId = 'wait_target_ready';
    emit(
      'wait_target_ready',
      'running',
      48,
      `Esperando pod primario Healthy en "${targetNamespace}"...`,
      `Monitoreando arranque de "${freshDb.name}" en "${targetNamespace}"...`,
    );

    let targetDb: ClusterDBInfo | null = null;
    const readyDeadline = Date.now() + 5 * 60 * 1000;
    let waitPercent = 48;

    while (Date.now() < readyDeadline) {
      await sleep(2500);
      try {
        const dbs = await listClusterDBs();
        const found = dbs.find(
          (d) => d.name === freshDb.name && d.namespace === targetNamespace,
        );
        if (found) {
          if (
            found.healthy &&
            found.readyInstances === 1 &&
            found.currentPrimary
          ) {
            targetDb = found;
            break;
          }
          waitPercent = Math.min(60, waitPercent + 1);
          emit(
            'wait_target_ready',
            'running',
            waitPercent,
            `${found.phase || 'Iniciando'} · ready ${found.readyInstances}/${found.instances}`,
          );
        }
      } catch {
        // continue polling
      }
    }

    if (!targetDb || !targetDb.currentPrimary) {
      throw new Error(
        `Tiempo de espera agotado esperando a que "${freshDb.name}" en "${targetNamespace}" esté Healthy. La BD origen en "${freshDb.namespace}" NO fue eliminada.`,
      );
    }

    emit(
      'wait_target_ready',
      'done',
      62,
      `${targetDb.currentPrimary} @ ${targetDb.primaryNode} · Healthy (1/1)`,
      `Nueva instancia ${targetDb.currentPrimary} lista en "${targetNamespace}".`,
    );

    // ── STEP 6: RESTORE DATA & ROLES ───────────────────────────────────
    activeStepId = 'restore_data';
    emit(
      'restore_data',
      'running',
      66,
      'Restaurando roles personalizados y base "app"...',
      `Restaurando roles y datos en ${targetDb.currentPrimary} (${targetNamespace})...`,
    );

    if (filteredGlobals.trim().length > 0) {
      await execRestoreFromFile(
        targetNamespace,
        targetDb.currentPrimary,
        'postgres',
        globalsPath,
        true,
      );
    }

    emit(
      'restore_data',
      'running',
      71,
      `Restaurando volcado SQL (${formatBytes(bytesDumped)}) en base "app"...`,
    );
    await execRestoreFromFile(
      targetNamespace,
      targetDb.currentPrimary,
      'app',
      appDumpPath,
      true,
    );

    emit(
      'restore_data',
      'done',
      76,
      `Roles y ${formatBytes(bytesDumped)} restaurados correctamente`,
      `Datos y roles restaurados en "${targetNamespace}/${targetDb.name}".`,
    );

    // ── STEP 7: SYNC SECRETS ───────────────────────────────────────────
    activeStepId = 'sync_secrets';
    emit(
      'sync_secrets',
      'running',
      79,
      'Copiando credenciales kpg y sincronizando Secret app...',
      `Copiando Secrets de credenciales hacia "${targetNamespace}"...`,
    );

    const credentialsCopied = await copyKpgCredentialsSecret(freshDb, targetDb);
    if (appPassword) {
      await syncAppSecretPassword(targetDb, appPassword);
    }

    emit(
      'sync_secrets',
      'done',
      84,
      `${credentialsCopied} credencial(es) kpg copiadas${appPassword ? ' · Secret app sincronizado' : ''}`,
      'Credenciales sincronizadas en el namespace destino.',
    );

    // ── STEP 8: CLEANUP SOURCE & RECREATE ACCESS ───────────────────────
    activeStepId = 'cleanup_source';
    emit(
      'cleanup_source',
      'running',
      86,
      'Verificando salud del destino antes de eliminar origen...',
      `Re-validando "${targetNamespace}/${targetDb.name}" antes de limpiar "${freshDb.namespace}"...`,
    );

    const [preCleanupDbs, preCleanupNodes] = await Promise.all([
      listClusterDBs(),
      getNodes(),
    ]);
    const verifiedTarget = preCleanupDbs.find(
      (d) => d.name === freshDb.name && d.namespace === targetNamespace,
    );
    if (!verifiedTarget || !verifiedTarget.healthy || verifiedTarget.readyInstances !== 1) {
      throw new Error(
        `Bloqueo de seguridad: la BD destino en "${targetNamespace}" no está Healthy. No se eliminará el origen en "${freshDb.namespace}".`,
      );
    }

    emit(
      'cleanup_source',
      'running',
      89,
      `Eliminando BD origen "${freshDb.namespace}/${freshDb.name}"...`,
      `Eliminando recursos antiguos en "${freshDb.namespace}"...`,
    );

    await deleteClusterDB(freshDb, preCleanupDbs, preCleanupNodes, (msg) => {
      emit('cleanup_source', 'running', 90, msg);
    });

    let recreatedAccess: NetworkAccessInfo | null = null;
    if (sourceAccess) {
      emit(
        'cleanup_source',
        'running',
        92,
        `Recreando acceso ${sourceAccess.mode} en "${targetNamespace}"...`,
        `Recreando Service (${sourceAccess.mode}) en "${targetNamespace}"...`,
      );
      recreatedAccess = await setNetworkAccessMode(
        verifiedTarget,
        hostIp,
        sourceAccess.mode,
        sourceAccess.nodePort,
      );
    }

    let sourceLabelRemoved = false;
    if (!isDefaultNamespace(freshDb.namespace)) {
      const postCleanupDbs = await listClusterDBs();
      const stillInUse = await syncNamespaceUsageLabel(
        freshDb.namespace,
        postCleanupDbs,
      );
      sourceLabelRemoved = !stillInUse;
    }

    const accessMode: NetworkAccessMode = recreatedAccess?.mode ?? 'close';
    const accessDetail = recreatedAccess
      ? recreatedAccess.mode === 'nodeport'
        ? `NodePort ${recreatedAccess.hostIp}:${recreatedAccess.port}`
        : `ClusterIP ${recreatedAccess.shortDns}:${recreatedAccess.port}`
      : 'sin acceso fijo';

    emit(
      'cleanup_source',
      'done',
      94,
      `Origen limpiado · Acceso: ${accessDetail}`,
      `Limpieza completada en "${freshDb.namespace}".`,
    );

    // ── STEP 9: FINAL VERIFICATION ─────────────────────────────────────
    activeStepId = 'verify_final';
    emit(
      'verify_final',
      'running',
      97,
      'Ejecutando comprobación final del cluster...',
      'Verificando estado final en destino y ausencia en origen...',
    );

    const finalSnap = await getClusterSnapshot();
    const finalTarget = finalSnap.dbs.find(
      (d) => d.name === freshDb.name && d.namespace === targetNamespace,
    );
    const oldStillExists = finalSnap.dbs.some(
      (d) => d.name === freshDb.name && d.namespace === freshDb.namespace,
    );

    if (!finalTarget || !finalTarget.healthy || finalTarget.readyInstances !== 1) {
      throw new Error(
        `Comprobación final inesperada en "${targetNamespace}": ${finalTarget?.phase ?? 'no encontrada'}.`,
      );
    }
    if (oldStillExists) {
      throw new Error(
        `La BD origen aún aparece en "${freshDb.namespace}". Verifica el estado en el panel principal.`,
      );
    }

    const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    emit(
      'verify_final',
      'done',
      100,
      `✔ Healthy · 1/1 · ${finalTarget.currentPrimary} en ns "${targetNamespace}"`,
      `Traslado de namespace completado y verificado en ${durationSec}s.`,
    );

    return {
      dbName: freshDb.name,
      sourceNamespace: freshDb.namespace,
      targetNamespace,
      agentNode: finalTarget.primaryNode,
      newPrimary: finalTarget.currentPrimary,
      bytesDumped,
      credentialsCopied,
      accessMode,
      accessDetail,
      sourceLabelRemoved,
      durationSec,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(activeStepId, 'error', currentPercent, message, `✖ Error: ${message}`);
    throw err;
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore temp dir cleanup errors
      }
    }
  }
}
