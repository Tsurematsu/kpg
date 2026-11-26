import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { FooterBar } from './FooterBar.js';
import { ProgressBar } from './ProgressBar.js';
import { Spinner } from './Spinner.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  KPG_NS_USAGE_LABEL,
  getAgentNodes,
  getSelectableNamespaces,
} from '../services/cnpg.js';
import { extractHostFromServerUrl } from '../services/access.js';
import { formatBytes } from '../services/backup.js';
import {
  createInitialMigrationSteps,
  migrateClusterDB,
  type MigrationStep,
  type MigrationSummary,
} from '../services/migration.js';
import {
  createInitialNamespaceMigrationSteps,
  migrateClusterDBNamespace,
  type NamespaceMigrationSummary,
} from '../services/namespaceMigration.js';
import type { ClusterDBInfo, NamespaceInfo, NodeInfo } from '../types/k8s.js';

interface MoveDbScreenProps {
  db: ClusterDBInfo;
  nodes: NodeInfo[];
  namespaces: NamespaceInfo[];
  allDbs: ClusterDBInfo[];
  serverUrl: string;
  onClose: (refresh: boolean) => void;
}

type MoveMode = 'agent' | 'namespace';

type Stage =
  | 'choose_mode'
  | 'select_agent'
  | 'confirm_agent'
  | 'select_ns'
  | 'confirm_ns'
  | 'migrating'
  | 'done'
  | 'error';

function formatElapsed(sec: number): string {
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function MoveDbScreen({
  db,
  nodes,
  namespaces,
  allDbs,
  serverUrl,
  onClose,
}: MoveDbScreenProps) {
  const { rows: termHeight, columns: termWidth } = useTerminalSize();

  const hostIp = useMemo(() => {
    const fallbackNode =
      nodes.find((n) => n.name === db.primaryNode) ??
      nodes.find((n) => n.isControlPlane) ??
      nodes[0];
    return extractHostFromServerUrl(
      serverUrl,
      fallbackNode?.internalIp ?? '127.0.0.1',
    );
  }, [serverUrl, nodes, db.primaryNode]);

  const agents = useMemo(
    () =>
      [...getAgentNodes(nodes)].sort((a, b) => a.name.localeCompare(b.name)),
    [nodes],
  );

  const sourceAgent = useMemo(
    () => agents.find((a) => a.name === db.primaryNode) ?? null,
    [agents, db.primaryNode],
  );

  const targetAgentCandidates = useMemo(
    () => agents.filter((a) => a.name !== db.primaryNode),
    [agents, db.primaryNode],
  );

  const targetNsCandidates = useMemo(() => {
    return getSelectableNamespaces(namespaces)
      .filter((ns) => ns.name !== db.namespace)
      .map((ns) => {
        const hasNameCollision = allDbs.some(
          (other) => other.name === db.name && other.namespace === ns.name,
        );
        const dbCount = allDbs.filter((d) => d.namespace === ns.name).length;
        return { ns, hasNameCollision, dbCount };
      });
  }, [namespaces, db.namespace, db.name, allDbs]);

  const [stage, setStage] = useState<Stage>('choose_mode');
  const [modeIdx, setModeIdx] = useState(0);
  const [activeMode, setActiveMode] = useState<MoveMode>('agent');
  const [agentIdx, setAgentIdx] = useState(0);
  const [nsIdx, setNsIdx] = useState(0);
  const [modeNotice, setModeNotice] = useState<string | null>(null);

  const [percent, setPercent] = useState(0);
  const [steps, setSteps] = useState<MigrationStep[]>(() =>
    createInitialMigrationSteps(),
  );
  const [logs, setLogs] = useState<string[]>([]);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [agentSummary, setAgentSummary] = useState<MigrationSummary | null>(
    null,
  );
  const [nsSummary, setNsSummary] = useState<NamespaceMigrationSummary | null>(
    null,
  );
  const [errorMsg, setErrorMsg] = useState('');

  const selectedAgent = targetAgentCandidates[agentIdx] ?? null;
  const selectedNsItem = targetNsCandidates[nsIdx] ?? null;

  useEffect(() => {
    if (stage !== 'migrating') return;
    const timer = setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [stage]);

  const openMode = (mode: MoveMode) => {
    setModeNotice(null);
    if (mode === 'agent') {
      if (!db.labelId) {
        setModeNotice(
          `La BD "${db.name}" no tiene nodeSelector/Label ID configurado para trasladar entre agentes.`,
        );
        return;
      }
      setActiveMode('agent');
      setAgentIdx(0);
      setStage('select_agent');
      return;
    }
    setActiveMode('namespace');
    setNsIdx(0);
    setStage('select_ns');
  };

  const startAgentMigration = async () => {
    if (!selectedAgent) return;
    setActiveMode('agent');
    setStage('migrating');
    setPercent(0);
    setElapsedSec(0);
    setSteps(createInitialMigrationSteps());
    setLogs([]);
    setErrorMsg('');
    setAgentSummary(null);
    setNsSummary(null);

    try {
      const result = await migrateClusterDB(db, selectedAgent.name, (ev) => {
        setPercent(ev.percent);
        setSteps(ev.steps);
        if (ev.log) {
          setLogs((prev) => [...prev.slice(-5), ev.log!]);
        }
      });
      setAgentSummary(result);
      setStage('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  };

  const startNamespaceMigration = async () => {
    if (!selectedNsItem || selectedNsItem.hasNameCollision) return;
    setActiveMode('namespace');
    setStage('migrating');
    setPercent(0);
    setElapsedSec(0);
    setSteps(createInitialNamespaceMigrationSteps());
    setLogs([]);
    setErrorMsg('');
    setAgentSummary(null);
    setNsSummary(null);

    try {
      const result = await migrateClusterDBNamespace(
        db,
        selectedNsItem.ns.name,
        hostIp,
        (ev) => {
          setPercent(ev.percent);
          setSteps(ev.steps);
          if (ev.log) {
            setLogs((prev) => [...prev.slice(-5), ev.log!]);
          }
        },
      );
      setNsSummary(result);
      setStage('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  };

  useInput((input, key) => {
    const lower = input.toLowerCase();

    if (stage === 'migrating') {
      // Do not allow accidental abort mid-migration
      return;
    }

    if (stage === 'done' || stage === 'error') {
      if (key.escape || key.return || lower === 'q') {
        onClose(true);
      }
      return;
    }

    if (stage === 'choose_mode') {
      if (key.escape || lower === 'q') {
        onClose(false);
        return;
      }
      if (input === '1') {
        openMode('agent');
        return;
      }
      if (input === '2') {
        openMode('namespace');
        return;
      }
      if (key.upArrow || lower === 'k') {
        setModeIdx((prev) => (prev === 0 ? 1 : 0));
        setModeNotice(null);
        return;
      }
      if (key.downArrow || lower === 'j') {
        setModeIdx((prev) => (prev === 1 ? 0 : 1));
        setModeNotice(null);
        return;
      }
      if (key.return) {
        openMode(modeIdx === 0 ? 'agent' : 'namespace');
      }
      return;
    }

    if (stage === 'select_agent') {
      if (key.escape) {
        setStage('choose_mode');
        return;
      }
      if (lower === 'q') {
        onClose(false);
        return;
      }
      if (targetAgentCandidates.length === 0) return;

      if (key.upArrow || lower === 'k') {
        setAgentIdx((prev) =>
          prev > 0 ? prev - 1 : targetAgentCandidates.length - 1,
        );
      } else if (key.downArrow || lower === 'j') {
        setAgentIdx((prev) =>
          prev < targetAgentCandidates.length - 1 ? prev + 1 : 0,
        );
      } else if (key.return) {
        if (selectedAgent && selectedAgent.ready) {
          setStage('confirm_agent');
        }
      }
      return;
    }

    if (stage === 'confirm_agent') {
      if (key.escape) {
        setStage('select_agent');
        return;
      }
      if (lower === 'q') {
        onClose(false);
        return;
      }
      if (key.return || lower === 'y' || lower === 's') {
        void startAgentMigration();
      }
      return;
    }

    if (stage === 'select_ns') {
      if (key.escape) {
        setStage('choose_mode');
        return;
      }
      if (lower === 'q') {
        onClose(false);
        return;
      }
      if (targetNsCandidates.length === 0) return;

      if (key.upArrow || lower === 'k') {
        setNsIdx((prev) =>
          prev > 0 ? prev - 1 : targetNsCandidates.length - 1,
        );
      } else if (key.downArrow || lower === 'j') {
        setNsIdx((prev) =>
          prev < targetNsCandidates.length - 1 ? prev + 1 : 0,
        );
      } else if (key.return) {
        if (selectedNsItem && !selectedNsItem.hasNameCollision) {
          setStage('confirm_ns');
        }
      }
      return;
    }

    if (stage === 'confirm_ns') {
      if (key.escape) {
        setStage('select_ns');
        return;
      }
      if (lower === 'q') {
        onClose(false);
        return;
      }
      if (key.return || lower === 'y' || lower === 's') {
        void startNamespaceMigration();
      }
    }
  });

  const barWidth = Math.max(24, Math.min(48, termWidth - 34));

  return (
    <Box
      flexDirection="column"
      height={Math.max(20, termHeight)}
      justifyContent="space-between"
    >
      {/* Top Banner */}
      <Box
        borderStyle="round"
        borderColor="yellow"
        paddingX={2}
        justifyContent="space-between"
      >
        <Box gap={1}>
          <Text bold color="yellow">
            ⇄ Trasladar Base de Datos
          </Text>
          <Text dimColor>·</Text>
          <Text bold color="white">
            {db.name}
          </Text>
          <Text dimColor>(ns: {db.namespace})</Text>
        </Box>
        <Text dimColor>
          Agente:{' '}
          <Text color="cyan" bold>
            {db.primaryNode}
          </Text>
          {' · '}
          Label:{' '}
          <Text color="green" bold>
            {db.labelId?.display ?? '—'}
          </Text>
        </Text>
      </Box>

      {/* Main Panel */}
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="single"
        borderColor="gray"
        paddingX={2}
        paddingY={1}
        gap={1}
      >
        {/* ── CHOOSE MODE ── */}
        {stage === 'choose_mode' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="white">
              Elige el tipo de traslado para &quot;{db.name}&quot;:
            </Text>

            {modeNotice ? (
              <Box borderStyle="round" borderColor="red" paddingX={1}>
                <Text color="red">✖ {modeNotice}</Text>
              </Box>
            ) : null}

            <Box flexDirection="column" gap={0}>
              <Box
                flexDirection="column"
                borderStyle={modeIdx === 0 ? 'round' : 'single'}
                borderColor={modeIdx === 0 ? 'yellow' : 'gray'}
                paddingX={1}
              >
                <Box gap={1}>
                  <Text color={modeIdx === 0 ? 'yellow' : 'gray'} bold={modeIdx === 0}>
                    {modeIdx === 0 ? '❯' : ' '}
                  </Text>
                  <Text bold color={modeIdx === 0 ? 'yellow' : 'white'}>
                    1) Mover de agente (nodo)
                  </Text>
                </Box>
                <Box marginLeft={2}>
                  <Text dimColor>
                    Traslado en caliente hacia otro agente dentro del mismo namespace ({db.namespace}) · 0 pérdida vía streaming.
                  </Text>
                </Box>
              </Box>

              <Box
                flexDirection="column"
                borderStyle={modeIdx === 1 ? 'round' : 'single'}
                borderColor={modeIdx === 1 ? 'cyan' : 'gray'}
                paddingX={1}
              >
                <Box gap={1}>
                  <Text color={modeIdx === 1 ? 'cyan' : 'gray'} bold={modeIdx === 1}>
                    {modeIdx === 1 ? '❯' : ' '}
                  </Text>
                  <Text bold color={modeIdx === 1 ? 'cyan' : 'white'}>
                    2) Mover de namespace
                  </Text>
                </Box>
                <Box marginLeft={2}>
                  <Text dimColor>
                    Migrar a otro namespace existente (⚠ requiere reinicio/corte temporal · conserva datos, roles, TLS y acceso).
                  </Text>
                </Box>
              </Box>
            </Box>

            {db.namespace === 'default' ? (
              <Box borderStyle="round" borderColor="yellow" paddingX={1}>
                <Text color="yellow">
                  ℹ Esta BD está en &quot;default&quot;. Puedes usar la opción (2) para migrarla a un namespace personalizado.
                </Text>
              </Box>
            ) : null}
          </Box>
        )}

        {/* ── SELECT TARGET AGENT ── */}
        {stage === 'select_agent' && (
          <Box flexDirection="column" gap={1}>
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor="cyan"
              paddingX={1}
            >
              <Text bold color="cyan">
                Agente de Origen (actual)
              </Text>
              <Box gap={2}>
                <Text>
                  <Text color="green">●</Text>{' '}
                  <Text bold>{db.primaryNode}</Text>
                </Text>
                <Text dimColor>
                  Primario: {db.currentPrimary} · 0 réplicas (1 instancia)
                </Text>
                {sourceAgent?.internalIp ? (
                  <Text dimColor>IP: {sourceAgent.internalIp}</Text>
                ) : null}
              </Box>
            </Box>

            <Box flexDirection="column" gap={0}>
              <Text bold color="white">
                Selecciona el agente de destino (selección única):
              </Text>
              {targetAgentCandidates.length === 0 ? (
                <Box
                  borderStyle="round"
                  borderColor="red"
                  paddingX={1}
                  marginTop={1}
                >
                  <Text color="red">
                    No hay otros agentes disponibles en el cluster para realizar el traslado.
                  </Text>
                </Box>
              ) : (
                <Box
                  flexDirection="column"
                  borderStyle="single"
                  borderColor="gray"
                  paddingX={1}
                >
                  {targetAgentCandidates.map((ag, idx) => {
                    const isSelected = idx === agentIdx;
                    return (
                      <Box key={ag.name} justifyContent="space-between">
                        <Box gap={1}>
                          <Text
                            color={isSelected ? 'yellow' : 'gray'}
                            bold={isSelected}
                          >
                            {isSelected ? '❯ (●)' : '  ( )'}
                          </Text>
                          <Text color={ag.ready ? 'green' : 'red'}>
                            {ag.ready ? '●' : '○'}
                          </Text>
                          <Text
                            color={
                              isSelected
                                ? 'yellow'
                                : ag.ready
                                  ? 'white'
                                  : 'red'
                            }
                            bold={isSelected}
                          >
                            {ag.name}
                          </Text>
                          <Text dimColor>
                            {ag.ready ? 'Ready' : 'NotReady (no elegible)'} ·{' '}
                            {ag.internalIp || 'sin IP'}
                          </Text>
                        </Box>
                        <Text dimColor>
                          {Object.keys(ag.customLabels).length > 0
                            ? `labels: ${Object.keys(ag.customLabels).join(', ')}`
                            : 'sin labels de BD'}
                        </Text>
                      </Box>
                    );
                  })}
                </Box>
              )}
            </Box>

            <Text dimColor>
              Flujo automático: copiar label → escalar a 2 → esperar sincronización (streaming) → promover → destruir instancia vieja + bajar a 1 → borrar PVC y label origen → verificación final.
            </Text>
          </Box>
        )}

        {/* ── CONFIRM AGENT MIGRATION ── */}
        {stage === 'confirm_agent' && selectedAgent && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="yellow">
              Confirmar traslado de agente para &quot;{db.name}&quot;
            </Text>
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor="yellow"
              paddingX={2}
              paddingY={1}
              gap={0}
            >
              <Text>
                <Text dimColor>Ruta de traslado: </Text>
                <Text color="cyan" bold>
                  {db.primaryNode}
                </Text>
                <Text bold color="yellow">
                  {' '}
                  ━━▶{' '}
                </Text>
                <Text color="green" bold>
                  {selectedAgent.name}
                </Text>
              </Text>
              <Text>
                <Text dimColor>Label vinculado: </Text>
                <Text color="green" bold>
                  {db.labelId?.key}={db.labelId?.value}
                </Text>
              </Text>
              <Text>
                <Text dimColor>Primario actual: </Text>
                <Text>
                  {db.currentPrimary} (se destruirá su pod y PVC solo tras confirmar el nuevo primario)
                </Text>
              </Text>
              <Text dimColor>
                Nota: durante la promoción habrá un breve corte (~segundos) mientras el Service {db.name}-rw apunta al nuevo primario.
              </Text>
            </Box>

            <Text>
              <Text bold color="green">
                [Enter] Iniciar traslado automático
              </Text>
              {' · '}
              <Text dimColor>[Esc] Cambiar destino · [Q] Cancelar</Text>
            </Text>
          </Box>
        )}

        {/* ── SELECT TARGET NAMESPACE ── */}
        {stage === 'select_ns' && (
          <Box flexDirection="column" gap={1}>
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor="cyan"
              paddingX={1}
            >
              <Text bold color="cyan">
                Namespace de Origen (actual)
              </Text>
              <Text>
                <Text color="green">●</Text>{' '}
                <Text bold>{db.namespace}</Text>
                <Text dimColor>
                  {' '}
                  · BD: {db.name} · Primario: {db.currentPrimary} @ {db.primaryNode}
                </Text>
              </Text>
            </Box>

            <Box flexDirection="column" gap={0}>
              <Text bold color="white">
                Selecciona el namespace destino existente (excluye default y sistema):
              </Text>
              {targetNsCandidates.length === 0 ? (
                <Box
                  borderStyle="round"
                  borderColor="yellow"
                  paddingX={1}
                  marginTop={1}
                >
                  <Text color="yellow">
                    No hay otros namespaces personalizados disponibles. Crea uno primero desde tu herramienta de namespaces (o kubectl create namespace &lt;nombre&gt;).
                  </Text>
                </Box>
              ) : (
                <Box
                  flexDirection="column"
                  borderStyle="single"
                  borderColor="gray"
                  paddingX={1}
                >
                  {targetNsCandidates.map(({ ns, hasNameCollision, dbCount }, idx) => {
                    const isSelected = idx === nsIdx;
                    const otherKeys = Object.keys(ns.otherToolLabels);
                    return (
                      <Box key={ns.name} justifyContent="space-between">
                        <Box gap={1}>
                          <Text
                            color={isSelected ? 'cyan' : 'gray'}
                            bold={isSelected}
                          >
                            {isSelected ? '❯ (●)' : '  ( )'}
                          </Text>
                          <Text color={hasNameCollision ? 'red' : ns.usedByKpg ? 'green' : 'gray'}>
                            {hasNameCollision ? '✖' : ns.usedByKpg ? '★' : '●'}
                          </Text>
                          <Text
                            color={
                              isSelected
                                ? 'cyan'
                                : hasNameCollision
                                  ? 'red'
                                  : 'white'
                            }
                            bold={isSelected}
                          >
                            {ns.name}
                          </Text>
                          <Text dimColor>
                            ({dbCount} BD{dbCount === 1 ? '' : 's'})
                            {hasNameCollision
                              ? ` · ya existe "${db.name}" (no elegible)`
                              : ''}
                          </Text>
                        </Box>
                        <Text dimColor>
                          {ns.usedByKpg ? 'kpg' : ''}
                          {ns.usedByKpg && otherKeys.length > 0 ? ' · ' : ''}
                          {otherKeys.length > 0
                            ? `otras: ${otherKeys.join(', ')}`
                            : !ns.usedByKpg
                              ? 'libre'
                              : ''}
                        </Text>
                      </Box>
                    );
                  })}
                </Box>
              )}
            </Box>

            <Text dimColor>
              Flujo seguro: pg_dump + roles → marcar destino ({KPG_NS_USAGE_LABEL}=true) → crear Cluster → restaurar → sincronizar credenciales → limpiar origen y recrear acceso.
            </Text>
          </Box>
        )}

        {/* ── CONFIRM NAMESPACE MIGRATION (WITH RESTART/DOWNTIME WARNING) ── */}
        {stage === 'confirm_ns' && selectedNsItem && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="yellow">
              ⚠ Advertencia de reinicio y corte temporal — Mover de namespace
            </Text>
            <Box
              flexDirection="column"
              borderStyle="double"
              borderColor="yellow"
              paddingX={2}
              paddingY={1}
              gap={0}
            >
              <Text>
                <Text dimColor>Ruta de traslado: </Text>
                <Text color="cyan" bold>
                  {db.namespace}
                </Text>
                <Text bold color="yellow">
                  {' '}
                  ━━▶{' '}
                </Text>
                <Text color="green" bold>
                  {selectedNsItem.ns.name}
                </Text>
                <Text dimColor> (mismo agente: {db.primaryNode})</Text>
              </Text>
              <Text color="yellow" bold>
                • La base de datos se reiniciará/recreará en &quot;{selectedNsItem.ns.name}&quot; con un corte breve durante el volcado y restauración.
              </Text>
              <Text dimColor>
                • El DNS interno cambiará a: {db.name}-rw.{selectedNsItem.ns.name}.svc.cluster.local
              </Text>
              <Text dimColor>
                • Se conservarán: datos (base app), roles/usuarios, contraseñas (Secrets), política TLS (pg_hba) y modo de acceso (NodePort / ClusterIP).
              </Text>
              <Text dimColor>
                • Seguridad: el origen en &quot;{db.namespace}&quot; NO se elimina hasta confirmar que el destino esté 1/1 Healthy y restaurado.
              </Text>
              <Text dimColor>
                • Labels: se marcará {KPG_NS_USAGE_LABEL}=true en &quot;{selectedNsItem.ns.name}&quot;
                {db.namespace === 'default'
                  ? ' (default no se etiqueta).'
                  : ` y se liberará en "${db.namespace}" si queda sin BDs.`}
              </Text>
            </Box>

            <Text>
              <Text bold color="green">
                [Enter] Entiendo el reinicio, iniciar traslado de namespace
              </Text>
              {' · '}
              <Text dimColor>[Esc] Cambiar destino · [Q] Cancelar</Text>
            </Text>
          </Box>
        )}

        {/* ── MIGRATING / DONE / ERROR ── */}
        {(stage === 'migrating' || stage === 'done' || stage === 'error') && (
          <Box flexDirection="column" gap={1}>
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={
                stage === 'done'
                  ? 'green'
                  : stage === 'error'
                    ? 'red'
                    : 'cyan'
              }
              paddingX={2}
              paddingY={0}
              gap={0}
            >
              <Box justifyContent="space-between">
                <Text>
                  <Text bold color="cyan">
                    {activeMode === 'agent' ? db.primaryNode : db.namespace}
                  </Text>
                  <Text color="yellow" bold>
                    {' '}
                    ━━▶{' '}
                  </Text>
                  <Text bold color="green">
                    {activeMode === 'agent'
                      ? selectedAgent?.name
                      : selectedNsItem?.ns.name}
                  </Text>
                  <Text dimColor>
                    {' '}
                    · {db.name} ({activeMode === 'agent' ? 'agente' : 'namespace'})
                  </Text>
                </Text>
                <Text dimColor>Tiempo: {formatElapsed(elapsedSec)}</Text>
              </Box>
              <ProgressBar
                percent={percent}
                width={barWidth}
                color={stage === 'error' ? 'red' : 'cyan'}
              />
            </Box>

            {/* Step Checklist */}
            <Box flexDirection="column">
              {steps.map((s) => (
                <Box key={s.id} flexDirection="column">
                  <Box gap={1}>
                    {s.status === 'done' ? (
                      <Text color="green">✔</Text>
                    ) : s.status === 'running' ? (
                      <Spinner color="cyan" />
                    ) : s.status === 'error' ? (
                      <Text color="red">✖</Text>
                    ) : (
                      <Text dimColor>○</Text>
                    )}
                    <Text
                      bold={s.status === 'running'}
                      color={
                        s.status === 'done'
                          ? 'green'
                          : s.status === 'running'
                            ? 'cyan'
                            : s.status === 'error'
                              ? 'red'
                              : undefined
                      }
                      dimColor={s.status === 'pending'}
                    >
                      {s.label}
                    </Text>
                  </Box>
                  {s.detail ? (
                    <Box marginLeft={3}>
                      <Text
                        color={s.status === 'error' ? 'red' : undefined}
                        dimColor={s.status !== 'error'}
                      >
                        {s.detail}
                      </Text>
                    </Box>
                  ) : null}
                </Box>
              ))}
            </Box>

            {/* Final summary: Agent */}
            {stage === 'done' && agentSummary && (
              <Box
                flexDirection="column"
                borderStyle="double"
                borderColor="green"
                paddingX={2}
                paddingY={0}
              >
                <Text bold color="green">
                  ✔ Traslado de agente completado y verificado en {agentSummary.durationSec}s
                </Text>
                <Text>
                  Primario:{' '}
                  <Text dimColor>
                    {agentSummary.oldPrimary} ({agentSummary.sourceNode})
                  </Text>{' '}
                  →{' '}
                  <Text color="green" bold>
                    {agentSummary.newPrimary} ({agentSummary.targetNode})
                  </Text>
                  {agentSummary.oldTimeline && agentSummary.newTimeline
                    ? ` · Timeline ${agentSummary.oldTimeline} → ${agentSummary.newTimeline}`
                    : ''}
                </Text>
                <Text dimColor>
                  PVC activo: {agentSummary.pvcsRemaining.join(', ') || '—'} · Label{' '}
                  {agentSummary.labelDisplay}{' '}
                  {agentSummary.labelRemovedFromSource
                    ? `removido de ${agentSummary.sourceNode}`
                    : 'conservado (compartido)'}
                </Text>
              </Box>
            )}

            {/* Final summary: Namespace */}
            {stage === 'done' && nsSummary && (
              <Box
                flexDirection="column"
                borderStyle="double"
                borderColor="green"
                paddingX={2}
                paddingY={0}
              >
                <Text bold color="green">
                  ✔ Traslado de namespace completado y verificado en {nsSummary.durationSec}s
                </Text>
                <Text>
                  Namespace:{' '}
                  <Text dimColor>{nsSummary.sourceNamespace}</Text> →{' '}
                  <Text color="green" bold>
                    {nsSummary.targetNamespace}
                  </Text>
                  {' · '}
                  Primario: {nsSummary.newPrimary} @ {nsSummary.agentNode}
                </Text>
                <Text dimColor>
                  Restaurado: {formatBytes(nsSummary.bytesDumped)} · Credenciales kpg:{' '}
                  {nsSummary.credentialsCopied} · Acceso: {nsSummary.accessDetail}
                  {nsSummary.sourceNamespace !== 'default'
                    ? nsSummary.sourceLabelRemoved
                      ? ` · ${KPG_NS_USAGE_LABEL} retirado de ${nsSummary.sourceNamespace}`
                      : ` · ${KPG_NS_USAGE_LABEL} conservado en ${nsSummary.sourceNamespace}`
                    : ''}
                </Text>
              </Box>
            )}

            {stage === 'error' && (
              <Box
                flexDirection="column"
                borderStyle="double"
                borderColor="red"
                paddingX={2}
                paddingY={0}
              >
                <Text bold color="red">
                  ✖ El traslado se detuvo por seguridad
                </Text>
                <Text color="red">{errorMsg}</Text>
                <Text dimColor>
                  Revisa el estado en el panel principal antes de reintentar. No se borró ningún PVC del primario activo.
                </Text>
              </Box>
            )}

            {stage === 'migrating' && logs.length > 0 && (
              <Box flexDirection="column">
                <Text dimColor bold>
                  Último evento: {logs[logs.length - 1]}
                </Text>
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* Bottom Bar */}
      <FooterBar
        items={
          stage === 'choose_mode'
            ? [
                { key: '↑/↓', label: 'Elegir tipo' },
                { key: '1', label: 'Agente', accent: 'yellow' },
                { key: '2', label: 'Namespace', accent: 'cyan' },
                { key: 'Enter', label: 'Continuar', accent: 'green' },
                { key: 'Esc/Q', label: 'Volver', accent: 'red' },
              ]
            : stage === 'select_agent'
              ? [
                  { key: '↑/↓', label: 'Elegir agente destino' },
                  {
                    key: 'Enter',
                    label: 'Seleccionar',
                    accent: 'green',
                    disabled: !selectedAgent || !selectedAgent.ready,
                  },
                  { key: 'Esc', label: 'Atrás' },
                  { key: 'Q', label: 'Salir', accent: 'red' },
                ]
              : stage === 'select_ns'
                ? [
                    { key: '↑/↓', label: 'Elegir namespace destino' },
                    {
                      key: 'Enter',
                      label: 'Seleccionar',
                      accent: 'green',
                      disabled: !selectedNsItem || selectedNsItem.hasNameCollision,
                    },
                    { key: 'Esc', label: 'Atrás' },
                    { key: 'Q', label: 'Salir', accent: 'red' },
                  ]
                : stage === 'confirm_agent' || stage === 'confirm_ns'
                  ? [
                      { key: 'Enter', label: 'Iniciar traslado', accent: 'green' },
                      { key: 'Esc', label: 'Cambiar destino' },
                      { key: 'Q', label: 'Cancelar', accent: 'red' },
                    ]
                  : stage === 'migrating'
                    ? [
                        {
                          key: '...',
                          label: 'Traslado en progreso — no cierres la terminal hasta finalizar',
                          accent: 'yellow',
                        },
                      ]
                    : [
                        {
                          key: 'Enter/Esc/Q',
                          label: 'Volver al menú principal',
                          accent: 'green',
                        },
                      ]
        }
      />
    </Box>
  );
}
