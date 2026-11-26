import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { FooterBar } from './FooterBar.js';
import { ProgressBar } from './ProgressBar.js';
import { Spinner } from './Spinner.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { getAgentNodes } from '../services/cnpg.js';
import {
  createInitialMigrationSteps,
  migrateClusterDB,
  type MigrationStep,
  type MigrationSummary,
} from '../services/migration.js';
import type { ClusterDBInfo, NodeInfo } from '../types/k8s.js';

interface MoveDbScreenProps {
  db: ClusterDBInfo;
  nodes: NodeInfo[];
  onClose: (refresh: boolean) => void;
}

type Stage = 'select_target' | 'confirm' | 'migrating' | 'done' | 'error';

function formatElapsed(sec: number): string {
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function MoveDbScreen({ db, nodes, onClose }: MoveDbScreenProps) {
  const { rows: termHeight, columns: termWidth } = useTerminalSize();

  const agents = useMemo(
    () =>
      [...getAgentNodes(nodes)].sort((a, b) => a.name.localeCompare(b.name)),
    [nodes],
  );

  const sourceAgent = useMemo(
    () => agents.find((a) => a.name === db.primaryNode) ?? null,
    [agents, db.primaryNode],
  );

  const targetCandidates = useMemo(
    () => agents.filter((a) => a.name !== db.primaryNode),
    [agents, db.primaryNode],
  );

  const [stage, setStage] = useState<Stage>('select_target');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [percent, setPercent] = useState(0);
  const [steps, setSteps] = useState<MigrationStep[]>(() =>
    createInitialMigrationSteps(),
  );
  const [logs, setLogs] = useState<string[]>([]);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [summary, setSummary] = useState<MigrationSummary | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const selectedTarget = targetCandidates[selectedIdx] ?? null;

  useEffect(() => {
    if (stage !== 'migrating') return;
    const timer = setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [stage]);

  const startMigration = async () => {
    if (!selectedTarget) return;
    setStage('migrating');
    setPercent(0);
    setElapsedSec(0);
    setSteps(createInitialMigrationSteps());
    setLogs([]);
    setErrorMsg('');
    setSummary(null);

    try {
      const result = await migrateClusterDB(db, selectedTarget.name, (ev) => {
        setPercent(ev.percent);
        setSteps(ev.steps);
        if (ev.log) {
          setLogs((prev) => [...prev.slice(-5), ev.log!]);
        }
      });
      setSummary(result);
      setStage('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  };

  useInput((input, key) => {
    const lower = input.toLowerCase();

    if (stage === 'migrating') {
      // Do not allow accidental abort mid-switchover/destroy
      return;
    }

    if (stage === 'done' || stage === 'error') {
      if (key.escape || key.return || lower === 'q') {
        onClose(true);
      }
      return;
    }

    if (stage === 'select_target') {
      if (key.escape || lower === 'q') {
        onClose(false);
        return;
      }
      if (targetCandidates.length === 0) return;

      if (key.upArrow || lower === 'k') {
        setSelectedIdx((prev) =>
          prev > 0 ? prev - 1 : targetCandidates.length - 1,
        );
      } else if (key.downArrow || lower === 'j') {
        setSelectedIdx((prev) =>
          prev < targetCandidates.length - 1 ? prev + 1 : 0,
        );
      } else if (key.return) {
        if (selectedTarget && selectedTarget.ready) {
          setStage('confirm');
        }
      }
      return;
    }

    if (stage === 'confirm') {
      if (key.escape) {
        setStage('select_target');
        return;
      }
      if (lower === 'q') {
        onClose(false);
        return;
      }
      if (key.return || lower === 'y' || lower === 's') {
        void startMigration();
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
          <Text dimColor>({db.namespace})</Text>
        </Box>
        <Text dimColor>
          Label ID:{' '}
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
        {stage === 'select_target' && (
          <Box flexDirection="column" gap={1}>
            {/* Origin Card */}
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

            {/* Target Agent Single-Select List */}
            <Box flexDirection="column" gap={0}>
              <Text bold color="white">
                Selecciona el agente de destino (selección única):
              </Text>
              {targetCandidates.length === 0 ? (
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
                  marginTop={0}
                >
                  {targetCandidates.map((ag, idx) => {
                    const isSelected = idx === selectedIdx;
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

            <Box flexDirection="column" marginTop={0}>
              <Text dimColor>
                Flujo automático: copiar label → escalar a 2 → esperar sincronización (streaming) → promover → destruir instancia vieja + bajar a 1 → borrar PVC y label origen → verificación final.
              </Text>
            </Box>
          </Box>
        )}

        {stage === 'confirm' && selectedTarget && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="yellow">
              Confirmar traslado automático de &quot;{db.name}&quot;
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
                  {selectedTarget.name}
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
                <Text>{db.currentPrimary} (se destruirá su pod y PVC solo tras confirmar el nuevo primario)</Text>
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

        {(stage === 'migrating' || stage === 'done' || stage === 'error') && (
          <Box flexDirection="column" gap={1}>
            {/* Route + Progress bar */}
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
                    {db.primaryNode}
                  </Text>
                  <Text color="yellow" bold>
                    {' '}
                    ━━▶{' '}
                  </Text>
                  <Text bold color="green">
                    {selectedTarget?.name}
                  </Text>
                  <Text dimColor> · {db.name}</Text>
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

            {/* Final summary or error */}
            {stage === 'done' && summary && (
              <Box
                flexDirection="column"
                borderStyle="double"
                borderColor="green"
                paddingX={2}
                paddingY={0}
              >
                <Text bold color="green">
                  ✔ Traslado completado y verificado en {summary.durationSec}s
                </Text>
                <Text>
                  Primario: <Text dimColor>{summary.oldPrimary} ({summary.sourceNode})</Text> →{' '}
                  <Text color="green" bold>
                    {summary.newPrimary} ({summary.targetNode})
                  </Text>
                  {summary.oldTimeline && summary.newTimeline
                    ? ` · Timeline ${summary.oldTimeline} → ${summary.newTimeline}`
                    : ''}
                </Text>
                <Text dimColor>
                  PVC activo: {summary.pvcsRemaining.join(', ') || '—'} · Label {summary.labelDisplay}{' '}
                  {summary.labelRemovedFromSource
                    ? `removido de ${summary.sourceNode}`
                    : 'conservado (compartido)'}
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
          stage === 'select_target'
            ? [
                { key: '↑/↓', label: 'Elegir agente destino' },
                {
                  key: 'Enter',
                  label: 'Seleccionar',
                  accent: 'green',
                  disabled: !selectedTarget || !selectedTarget.ready,
                },
                { key: 'Esc/Q', label: 'Volver', accent: 'red' },
              ]
            : stage === 'confirm'
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
