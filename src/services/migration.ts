import { runKubectl } from './kubectl.js';
import {
  destroyClusterInstance,
  getAgentNodes,
  getClusterSnapshot,
  getNodes,
  labelNode,
  listClusterDBs,
  patchClusterInstances,
  unlabelNode,
} from './cnpg.js';
import type { ClusterDBInfo } from '../types/k8s.js';

export type MigrationStepStatus = 'pending' | 'running' | 'done' | 'error';

export interface MigrationStep {
  id: string;
  label: string;
  status: MigrationStepStatus;
  detail?: string;
}

export interface MigrationProgressEvent {
  percent: number;
  steps: MigrationStep[];
  log?: string;
}

export interface MigrationSummary {
  dbName: string;
  namespace: string;
  sourceNode: string;
  targetNode: string;
  oldPrimary: string;
  newPrimary: string;
  oldTimeline?: number;
  newTimeline?: number;
  labelDisplay: string;
  labelRemovedFromSource: boolean;
  pvcsRemaining: string[];
  durationSec: number;
}

interface CnpgReplicationEntry {
  applicationName?: string;
  state?: string;
  sentLsn?: string;
  writeLsn?: string;
  flushLsn?: string;
  replayLsn?: string;
  writeLag?: string;
  flushLag?: string;
  replayLag?: string;
  syncState?: string;
}

interface CnpgInstanceItem {
  isPrimary?: boolean;
  isPodReady?: boolean;
  isWalReceiverActive?: boolean;
  node?: string;
  currentLsn?: string;
  receivedLsn?: string;
  replayLsn?: string;
  timeLineID?: number;
  error?: string;
  replicationInfo?: CnpgReplicationEntry[];
  pod?: {
    metadata?: {
      name?: string;
    };
    status?: {
      phase?: string;
    };
  };
}

interface CnpgStatusJson {
  cluster?: {
    spec?: {
      instances?: number;
    };
    status?: {
      phase?: string;
      readyInstances?: number;
      currentPrimary?: string;
      targetPrimary?: string;
    };
  };
  instanceStatus?: {
    items?: CnpgInstanceItem[];
  };
}

export function createInitialMigrationSteps(): MigrationStep[] {
  return [
    { id: 'validate', label: 'Validar estado inicial de la BD y agentes', status: 'pending' },
    { id: 'label_target', label: 'Copiar label de la BD al agente destino', status: 'pending' },
    { id: 'scale_up', label: 'Escalar a 2 instancias para crear réplica', status: 'pending' },
    { id: 'wait_sync', label: 'Esperar réplica en streaming y sincronización', status: 'pending' },
    { id: 'promote', label: 'Promover instancia en agente destino (switchover)', status: 'pending' },
    { id: 'wait_promote', label: 'Esperar confirmación del nuevo primario', status: 'pending' },
    { id: 'cleanup_old', label: 'Destruir instancia vieja, bajar a 1, borrar PVC y label origen', status: 'pending' },
    { id: 'verify_final', label: 'Comprobación final automática del cluster', status: 'pending' },
  ];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCnpgStatusJson(
  name: string,
  namespace: string,
): Promise<CnpgStatusJson> {
  const res = await runKubectl(
    ['cnpg', 'status', name, '-n', namespace, '-o', 'json'],
    { timeoutMs: 15000 },
  );
  if (res.code !== 0) {
    throw new Error(
      res.stderr.trim() ||
        res.stdout.trim() ||
        `Error ejecutando kubectl cnpg status ${name}.`,
    );
  }
  return JSON.parse(res.stdout) as CnpgStatusJson;
}

function isLagZeroOrNegligible(lag?: string): boolean {
  if (!lag || lag.trim() === '') return true;
  // Format from Postgres is typically "00:00:00" or "00:00:00.001234"
  const match = lag.trim().match(/^(\d+):(\d+):(\d+)(?:\.(\d+))?$/);
  if (!match) return false;
  const hours = Number.parseInt(match[1], 10);
  const mins = Number.parseInt(match[2], 10);
  const secs = Number.parseInt(match[3], 10);
  return hours === 0 && mins === 0 && secs === 0;
}

function parseInstanceNum(podName: string, clusterName: string): number {
  const prefix = `${clusterName}-`;
  if (!podName.startsWith(prefix)) {
    throw new Error(`No se pudo extraer el número de instancia de "${podName}".`);
  }
  const numStr = podName.slice(prefix.length);
  if (!/^\d+$/.test(numStr)) {
    throw new Error(`Número de instancia inválido en "${podName}".`);
  }
  return Number.parseInt(numStr, 10);
}

export async function migrateClusterDB(
  db: ClusterDBInfo,
  targetNode: string,
  onProgress: (event: MigrationProgressEvent) => void,
): Promise<MigrationSummary> {
  const startedAt = Date.now();
  const steps = createInitialMigrationSteps();
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

  try {
    // ── STEP 1: VALIDATE ───────────────────────────────────────────────
    activeStepId = 'validate';
    emit('validate', 'running', 4, 'Verificando estado actual...', 'Iniciando validación previa al traslado...');

    const [freshDbs, allNodes, initialStatus] = await Promise.all([
      listClusterDBs(),
      getNodes(),
      getCnpgStatusJson(db.name, db.namespace),
    ]);

    const freshDb = freshDbs.find(
      (d) => d.name === db.name && d.namespace === db.namespace,
    );
    if (!freshDb) {
      throw new Error(`No se encontró la BD "${db.name}" en el namespace ${db.namespace}.`);
    }
    if (freshDb.instances !== 1 || freshDb.replicas.length > 0) {
      throw new Error(
        `La BD "${db.name}" tiene ${freshDb.instances} instancias. Reduce las réplicas a 0 antes de trasladar.`,
      );
    }
    if (!freshDb.healthy || freshDb.readyInstances !== 1) {
      throw new Error(
        `La BD "${db.name}" no está en estado sano (${freshDb.phase}, ready: ${freshDb.readyInstances}/${freshDb.instances}).`,
      );
    }
    if (!freshDb.labelId) {
      throw new Error(
        `La BD "${db.name}" no tiene un nodeSelector/label configurado en spec.affinity.nodeSelector.`,
      );
    }

    const oldPrimary = freshDb.currentPrimary;
    const sourceNode = freshDb.primaryNode;
    if (!oldPrimary || !sourceNode || sourceNode === '—') {
      throw new Error('No se pudo determinar la instancia primaria ni el agente de origen.');
    }

    const oldInstanceNum = parseInstanceNum(oldPrimary, db.name);

    const agents = getAgentNodes(allNodes);
    const targetAgentInfo = agents.find((a) => a.name === targetNode);
    if (!targetAgentInfo) {
      throw new Error(`El nodo "${targetNode}" no es un agente elegible.`);
    }
    if (!targetAgentInfo.ready) {
      throw new Error(`El agente destino "${targetNode}" no está en estado Ready.`);
    }
    if (targetNode === sourceNode) {
      throw new Error('El agente destino no puede ser el mismo que el agente origen.');
    }

    const oldPrimaryItem = initialStatus.instanceStatus?.items?.find(
      (i) => i.pod?.metadata?.name === oldPrimary,
    );
    const oldTimeline = oldPrimaryItem?.timeLineID;
    const label = freshDb.labelId;

    emit(
      'validate',
      'done',
      10,
      `Primario ${oldPrimary} @ ${sourceNode} · Label ${label.display}`,
      `Validado: ${oldPrimary} en ${sourceNode} (timeline ${oldTimeline ?? '?'}) → destino ${targetNode}.`,
    );

    // ── STEP 2: LABEL TARGET AGENT ─────────────────────────────────────
    activeStepId = 'label_target';
    emit(
      'label_target',
      'running',
      14,
      `Aplicando ${label.key}=${label.value} en ${targetNode}...`,
      `Copiando label ${label.key}=${label.value} al agente destino ${targetNode}...`,
    );
    await labelNode(targetNode, label.key, label.value);
    emit(
      'label_target',
      'done',
      20,
      `${targetNode} etiquetado con ${label.key}=${label.value}`,
      `Agente destino ${targetNode} etiquetado correctamente.`,
    );

    // ── STEP 3: SCALE UP TO 2 INSTANCES ────────────────────────────────
    activeStepId = 'scale_up';
    emit(
      'scale_up',
      'running',
      24,
      'Parcheando spec.instances = 2 (sin tocar affinity)...',
      `Subiendo spec.instances de 1 a 2 en "${db.name}"...`,
    );
    await patchClusterInstances(db.name, db.namespace, 2);
    emit(
      'scale_up',
      'done',
      30,
      'spec.instances actualizado a 2',
      'Cluster escalado a 2 instancias. CNPG iniciará pg_basebackup hacia el destino.',
    );

    // ── STEP 4: WAIT FOR REPLICA SYNC ──────────────────────────────────
    activeStepId = 'wait_sync';
    emit(
      'wait_sync',
      'running',
      32,
      `Esperando pod réplica en ${targetNode}...`,
      `Monitoreando creación y sincronización de la réplica en ${targetNode}...`,
    );

    let newReplicaName = '';
    const syncDeadline = Date.now() + 5 * 60 * 1000; // 5 minutes
    let syncStepPercent = 32;

    while (Date.now() < syncDeadline) {
      await sleep(2500);
      let status: CnpgStatusJson;
      try {
        status = await getCnpgStatusJson(db.name, db.namespace);
      } catch {
        continue;
      }

      const items = status.instanceStatus?.items ?? [];
      const phase = status.cluster?.status?.phase ?? '';
      const readyCount = status.cluster?.status?.readyInstances ?? 0;

      const primaryItem = items.find(
        (i) => i.isPrimary || i.pod?.metadata?.name === oldPrimary,
      );
      const replicaItem = items.find(
        (i) => i.pod?.metadata?.name && i.pod.metadata.name !== oldPrimary,
      );

      if (!replicaItem || !replicaItem.pod?.metadata?.name) {
        syncStepPercent = Math.min(38, syncStepPercent + 1);
        emit(
          'wait_sync',
          'running',
          syncStepPercent,
          `Fase: ${phase || 'creando réplica'} (join/basebackup en progreso)...`,
        );
        continue;
      }

      newReplicaName = replicaItem.pod.metadata.name;
      const replicaNode = replicaItem.node || 'Pending';

      if (!replicaItem.isPodReady || readyCount < 2) {
        syncStepPercent = Math.min(44, Math.max(syncStepPercent, 39) + 1);
        emit(
          'wait_sync',
          'running',
          syncStepPercent,
          `${newReplicaName} @ ${replicaNode} (${replicaItem.pod.status?.phase ?? 'Init'}) · ready ${readyCount}/2`,
        );
        continue;
      }

      // Check streaming replication status from primary's replicationInfo + replica's wal receiver
      const repEntry = primaryItem?.replicationInfo?.find(
        (r) => r.applicationName === newReplicaName,
      );
      const isStreaming =
        repEntry?.state === 'streaming' ||
        Boolean(replicaItem.isWalReceiverActive);
      const lsnsMatch = Boolean(
        (repEntry?.sentLsn &&
          repEntry?.replayLsn &&
          repEntry.sentLsn === repEntry.replayLsn) ||
          (primaryItem?.currentLsn &&
            replicaItem.replayLsn &&
            primaryItem.currentLsn === replicaItem.replayLsn),
      );
      const lagOk =
        isLagZeroOrNegligible(repEntry?.replayLag) &&
        isLagZeroOrNegligible(repEntry?.writeLag) &&
        isLagZeroOrNegligible(repEntry?.flushLag);
      const isHealthy = phase.toLowerCase().includes('healthy');

      if (replicaNode !== targetNode) {
        throw new Error(
          `La réplica ${newReplicaName} cayó en "${replicaNode}" en lugar de "${targetNode}". Se detiene el traslado por seguridad.`,
        );
      }

      if (isHealthy && isStreaming && (lsnsMatch || lagOk)) {
        const lsnInfo = repEntry?.replayLsn || replicaItem.replayLsn || 'OK';
        emit(
          'wait_sync',
          'done',
          55,
          `${newReplicaName} @ ${targetNode} · streaming · LSN ${lsnInfo} · lag 00:00:00`,
          `Réplica ${newReplicaName} en ${targetNode} sincronizada (streaming, LSN ${lsnInfo}).`,
        );
        break;
      }

      syncStepPercent = Math.min(53, Math.max(syncStepPercent, 46) + 1);
      emit(
        'wait_sync',
        'running',
        syncStepPercent,
        `${newReplicaName} @ ${replicaNode} · state=${repEntry?.state ?? 'sync'} · lag=${repEntry?.replayLag ?? '...'}`,
      );
    }

    if (!newReplicaName || steps.find((s) => s.id === 'wait_sync')?.status !== 'done') {
      throw new Error(
        'Tiempo de espera agotado esperando a que la réplica entre en streaming y se sincronice.',
      );
    }

    // ── STEP 5: PROMOTE TARGET REPLICA ─────────────────────────────────
    activeStepId = 'promote';
    emit(
      'promote',
      'running',
      58,
      `Ejecutando kubectl cnpg promote ${db.name} ${newReplicaName}...`,
      `Promoviendo ${newReplicaName} como nuevo primario...`,
    );

    const promoteRes = await runKubectl(
      ['cnpg', 'promote', db.name, newReplicaName, '-n', db.namespace],
      { timeoutMs: 30000 },
    );
    if (promoteRes.code !== 0) {
      throw new Error(
        promoteRes.stderr.trim() ||
          promoteRes.stdout.trim() ||
          `Falló la promoción de ${newReplicaName}.`,
      );
    }

    emit(
      'promote',
      'done',
      65,
      `Orden de switchover enviada hacia ${newReplicaName}`,
      `Promoción iniciada hacia ${newReplicaName}.`,
    );

    // ── STEP 6: WAIT FOR PROMOTION TO COMPLETE ─────────────────────────
    activeStepId = 'wait_promote';
    emit(
      'wait_promote',
      'running',
      67,
      `Esperando switchover hacia ${newReplicaName}...`,
      `Esperando a que ${newReplicaName} asuma como primario y el cluster vuelva a Healthy...`,
    );

    const promoteDeadline = Date.now() + 3 * 60 * 1000; // 3 minutes
    let promotePercent = 67;
    let newTimeline: number | undefined;

    while (Date.now() < promoteDeadline) {
      await sleep(2500);
      let status: CnpgStatusJson;
      try {
        status = await getCnpgStatusJson(db.name, db.namespace);
      } catch {
        continue;
      }

      const phase = status.cluster?.status?.phase ?? '';
      const currentPrimary = status.cluster?.status?.currentPrimary ?? '';
      const readyCount = status.cluster?.status?.readyInstances ?? 0;
      const items = status.instanceStatus?.items ?? [];
      const newPrimaryItem = items.find(
        (i) => i.pod?.metadata?.name === newReplicaName,
      );

      if (
        currentPrimary === newReplicaName &&
        newPrimaryItem?.isPrimary &&
        newPrimaryItem?.isPodReady &&
        phase.toLowerCase().includes('healthy') &&
        readyCount >= 2
      ) {
        newTimeline = newPrimaryItem.timeLineID;
        emit(
          'wait_promote',
          'done',
          78,
          `Nuevo primario: ${newReplicaName} @ ${targetNode} (timeline ${newTimeline ?? '?'})`,
          `Switchover completado: ${newReplicaName} es el primario activo (timeline ${newTimeline ?? '?'}).`,
        );
        break;
      }

      promotePercent = Math.min(76, promotePercent + 1);
      emit(
        'wait_promote',
        'running',
        promotePercent,
        `Fase: ${phase || 'Switchover'} · currentPrimary=${currentPrimary || '?'} · ready=${readyCount}/2`,
      );
    }

    if (steps.find((s) => s.id === 'wait_promote')?.status !== 'done') {
      throw new Error(
        `Tiempo de espera agotado esperando la estabilización del switchover hacia ${newReplicaName}.`,
      );
    }

    // ── STEP 7: CLEANUP OLD INSTANCE, SCALE TO 1, DELETE OLD PVC & LABEL ─
    activeStepId = 'cleanup_old';
    emit(
      'cleanup_old',
      'running',
      80,
      `Verificando primario antes de destruir ${oldPrimary}...`,
      `Verificación de seguridad previa a destruir ${oldPrimary}...`,
    );

    // Strict safety re-check before ANY destructive action
    const preDestroyStatus = await getCnpgStatusJson(db.name, db.namespace);
    const verifiedPrimary = preDestroyStatus.cluster?.status?.currentPrimary;
    if (verifiedPrimary !== newReplicaName || verifiedPrimary === oldPrimary) {
      throw new Error(
        `Bloqueo de seguridad: currentPrimary es "${verifiedPrimary}", esperado "${newReplicaName}". No se destruirá ${oldPrimary}.`,
      );
    }

    // 7a. Destroy old instance keeping PVC first (matching 05-limpieza-completa.md)
    emit(
      'cleanup_old',
      'running',
      82,
      `Destruyendo instancia vieja ${oldPrimary} (--keep-pvc)...`,
      `Ejecutando kubectl cnpg destroy ${db.name} ${oldInstanceNum} --keep-pvc...`,
    );
    await destroyClusterInstance(db.name, db.namespace, oldInstanceNum, true);

    // 7b. Immediately scale instances back to 1
    emit(
      'cleanup_old',
      'running',
      85,
      'Bajando spec.instances a 1 de inmediato...',
      'Reduciendo spec.instances de 2 a 1...',
    );
    await patchClusterInstances(db.name, db.namespace, 1);

    // 7c. Wait for single healthy instance on targetNode before deleting old PVC
    const stabilizeDeadline = Date.now() + 2 * 60 * 1000;
    let stabilized = false;
    while (Date.now() < stabilizeDeadline) {
      await sleep(2500);
      try {
        const st = await getCnpgStatusJson(db.name, db.namespace);
        const ph = st.cluster?.status?.phase ?? '';
        const cp = st.cluster?.status?.currentPrimary ?? '';
        const rc = st.cluster?.status?.readyInstances ?? 0;
        const specInst = st.cluster?.spec?.instances ?? 0;
        if (
          cp === newReplicaName &&
          specInst === 1 &&
          rc === 1 &&
          ph.toLowerCase().includes('healthy')
        ) {
          stabilized = true;
          break;
        }
      } catch {
        // keep polling
      }
    }

    if (!stabilized) {
      throw new Error(
        `El cluster no se estabilizó con 1 instancia tras destruir ${oldPrimary}. El PVC "${oldPrimary}" se conservó por seguridad.`,
      );
    }

    // 7d. Delete old PVC (irreversible — only now that new primary is confirmed healthy alone)
    emit(
      'cleanup_old',
      'running',
      88,
      `Eliminando PVC viejo ${oldPrimary}...`,
      `Primario ${newReplicaName} confirmado sano (1/1). Eliminando PVC viejo ${oldPrimary}...`,
    );
    const delPvcRes = await runKubectl(
      ['delete', 'pvc', oldPrimary, '-n', db.namespace],
      { timeoutMs: 30000 },
    );
    if (delPvcRes.code !== 0 && !delPvcRes.stderr.includes('NotFound')) {
      throw new Error(
        delPvcRes.stderr.trim() || `No se pudo eliminar el PVC viejo ${oldPrimary}.`,
      );
    }

    // 7e. Remove label from source agent (only if no other DB uses that exact label)
    const latestDbs = await listClusterDBs();
    const sharedByOther = latestDbs.some(
      (other) =>
        !(other.name === db.name && other.namespace === db.namespace) &&
        other.nodeSelector[label.key] === label.value,
    );

    let labelRemovedFromSource = false;
    if (sharedByOther) {
      emit(
        'cleanup_old',
        'done',
        92,
        `Instancia y PVC ${oldPrimary} eliminados · label ${label.display} compartido (conservado)`,
        `Aviso: label ${label.display} está en uso por otra BD; no se quitó de ${sourceNode}.`,
      );
    } else {
      emit(
        'cleanup_old',
        'running',
        90,
        `Quitando label ${label.key} del agente origen ${sourceNode}...`,
        `Removiendo label ${label.key} de ${sourceNode}...`,
      );
      await unlabelNode(sourceNode, label.key);
      labelRemovedFromSource = true;
      emit(
        'cleanup_old',
        'done',
        92,
        `Instancia vieja, PVC ${oldPrimary} y label en ${sourceNode} limpiados`,
        `Limpieza completada: PVC ${oldPrimary} borrado y label removido de ${sourceNode}.`,
      );
    }

    // ── STEP 8: FINAL AUTOMATIC VERIFICATION ───────────────────────────
    activeStepId = 'verify_final';
    emit(
      'verify_final',
      'running',
      95,
      'Verificando salud final, PVCs y labels...',
      'Ejecutando comprobación final automática...',
    );

    const finalSnap = await getClusterSnapshot();
    const finalDb = finalSnap.dbs.find(
      (d) => d.name === db.name && d.namespace === db.namespace,
    );
    if (!finalDb) {
      throw new Error('No se encontró la BD en la comprobación final.');
    }
    if (
      !finalDb.healthy ||
      finalDb.instances !== 1 ||
      finalDb.readyInstances !== 1 ||
      finalDb.currentPrimary !== newReplicaName ||
      finalDb.primaryNode !== targetNode
    ) {
      throw new Error(
        `Comprobación final inesperada: phase="${finalDb.phase}", primary="${finalDb.currentPrimary}" @ "${finalDb.primaryNode}", ready=${finalDb.readyInstances}/${finalDb.instances}.`,
      );
    }

    const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    emit(
      'verify_final',
      'done',
      100,
      `✔ Healthy · 1/1 · ${newReplicaName} @ ${targetNode} · ${finalDb.pvcs.length} PVC`,
      `Traslado finalizado y verificado en ${durationSec}s.`,
    );

    return {
      dbName: db.name,
      namespace: db.namespace,
      sourceNode,
      targetNode,
      oldPrimary,
      newPrimary: newReplicaName,
      oldTimeline,
      newTimeline,
      labelDisplay: label.display,
      labelRemovedFromSource,
      pvcsRemaining: finalDb.pvcs,
      durationSec,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(activeStepId, 'error', currentPercent, message, `✖ Error: ${message}`);
    throw err;
  }
}
