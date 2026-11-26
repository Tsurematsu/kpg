import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from './Spinner.js';
import { getAgentNodes, scaleClusterReplicas } from '../services/cnpg.js';
import type { ClusterDBInfo, NodeInfo } from '../types/k8s.js';

interface ReplicasModalProps {
  db: ClusterDBInfo;
  nodes: NodeInfo[];
  allDbs: ClusterDBInfo[];
  onDone: (refresh: boolean) => void;
}

type Step = 'choose_count' | 'choose_agents' | 'confirm' | 'applying' | 'done' | 'error';

export function ReplicasModal({
  db,
  nodes,
  allDbs,
  onDone,
}: ReplicasModalProps) {
  const agents = useMemo(
    () =>
      [...getAgentNodes(nodes)].sort((a, b) => a.name.localeCompare(b.name)),
    [nodes],
  );

  const currentReplicas = Math.max(0, db.instances - 1);
  const maxReplicas = Math.max(0, agents.length - 1);

  const [step, setStep] = useState<Step>('choose_count');
  const [targetReplicas, setTargetReplicas] = useState(currentReplicas);
  const [agentCursor, setAgentCursor] = useState(0);
  const [selectedExtraAgents, setSelectedExtraAgents] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState('');

  const label = db.labelId;

  // Agents that already carry this DB's label
  const alreadyLabeledAgents = useMemo(() => {
    if (!label) return new Set<string>();
    return new Set(
      agents
        .filter((a) => a.labels[label.key] === label.value)
        .map((a) => a.name),
    );
  }, [agents, label]);

  // Candidate agents not yet labeled with this DB's label
  const candidateAgents = useMemo(
    () => agents.filter((a) => !alreadyLabeledAgents.has(a.name)),
    [agents, alreadyLabeledAgents],
  );

  const targetInstances = targetReplicas + 1;
  const neededExtraLabels = Math.max(
    0,
    targetInstances - alreadyLabeledAgents.size,
  );

  // When scaling down: pick replicas to destroy (highest instanceNumber first, never primary)
  const replicasToDestroy = useMemo(() => {
    if (targetInstances >= db.instances) return [];
    const removeCount = db.instances - targetInstances;
    const sortedReplicas = [...db.replicas]
      .filter((r) => r.name !== db.currentPrimary)
      .sort((a, b) => (b.instanceNumber ?? 0) - (a.instanceNumber ?? 0));
    return sortedReplicas.slice(0, removeCount);
  }, [db, targetInstances]);

  const executeScale = async () => {
    setStep('applying');
    setLogs([]);
    setErrorMsg('');

    try {
      await scaleClusterReplicas(
        {
          db,
          targetReplicas,
          addLabelToAgents: selectedExtraAgents,
          replicasToDestroy,
          allDbs,
          allNodes: nodes,
        },
        (msg) => setLogs((prev) => [...prev.slice(-8), msg]),
      );
      setStep('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  useInput((input, key) => {
    const lower = input.toLowerCase();

    if (step === 'applying') return;

    if (step === 'done' || step === 'error') {
      if (key.escape || key.return || lower === 'q') {
        onDone(step === 'done');
      }
      return;
    }

    if (step === 'choose_count') {
      if (key.escape || lower === 'q') {
        onDone(false);
        return;
      }
      if (key.leftArrow || input === '-' || key.downArrow) {
        setTargetReplicas((prev) => Math.max(0, prev - 1));
      } else if (key.rightArrow || input === '+' || key.upArrow) {
        setTargetReplicas((prev) => Math.min(maxReplicas, prev + 1));
      } else if (key.return) {
        if (targetReplicas === currentReplicas) {
          onDone(false);
          return;
        }
        // If scaling up and we need more labeled agents, let user pick which ones
        if (targetReplicas > currentReplicas && label && neededExtraLabels > 0) {
          if (candidateAgents.length === neededExtraLabels) {
            // Only exact candidates available: pre-select all of them
            setSelectedExtraAgents(candidateAgents.map((a) => a.name));
            setStep('confirm');
          } else {
            setSelectedExtraAgents([]);
            setAgentCursor(0);
            setStep('choose_agents');
          }
        } else {
          setSelectedExtraAgents([]);
          setStep('confirm');
        }
      }
      return;
    }

    if (step === 'choose_agents') {
      if (key.escape) {
        setStep('choose_count');
        return;
      }
      if (lower === 'q') {
        onDone(false);
        return;
      }
      if (key.upArrow || lower === 'k') {
        setAgentCursor((prev) =>
          prev > 0 ? prev - 1 : Math.max(0, candidateAgents.length - 1),
        );
      } else if (key.downArrow || lower === 'j') {
        setAgentCursor((prev) =>
          prev < candidateAgents.length - 1 ? prev + 1 : 0,
        );
      } else if (input === ' ') {
        const current = candidateAgents[agentCursor];
        if (!current) return;
        setSelectedExtraAgents((prev) => {
          if (prev.includes(current.name)) {
            return prev.filter((n) => n !== current.name);
          }
          if (prev.length >= neededExtraLabels) return prev;
          return [...prev, current.name];
        });
      } else if (key.return) {
        if (selectedExtraAgents.length >= neededExtraLabels) {
          setStep('confirm');
        }
      }
      return;
    }

    if (step === 'confirm') {
      if (key.escape) {
        setStep('choose_count');
        return;
      }
      if (lower === 'q') {
        onDone(false);
        return;
      }
      if (key.return || lower === 'y' || lower === 's') {
        void executeScale();
      }
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      width="82%"
      backgroundColor="black"
      gap={1}
    >
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          ⇄ Ajustar Réplicas · {db.name}
        </Text>
        <Text dimColor>
          Primario: <Text color="green">{db.currentPrimary || '—'}</Text> @ {db.primaryNode}
        </Text>
      </Box>

      {step === 'choose_count' && (
        <Box flexDirection="column" gap={1}>
          <Text>
            Réplicas actuales:{' '}
            <Text bold>{currentReplicas}</Text>{' '}
            <Text dimColor>({db.instances} instancia{db.instances === 1 ? '' : 's'} total)</Text>
          </Text>
          <Text dimColor>
            Agentes disponibles: {agents.length} → máximo {maxReplicas} réplica{maxReplicas === 1 ? '' : 's'} (con podAntiAffinity required).
          </Text>

          <Box
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
            paddingY={0}
            gap={2}
            justifyContent="center"
          >
            <Text color={targetReplicas > 0 ? 'cyan' : 'gray'} bold>
              ◀ (−)
            </Text>
            <Text bold color="yellow">
              {targetReplicas} réplica{targetReplicas === 1 ? '' : 's'} ({targetReplicas + 1} instancia{targetReplicas === 0 ? '' : 's'})
            </Text>
            <Text color={targetReplicas < maxReplicas ? 'cyan' : 'gray'} bold>
              (+) ▶
            </Text>
          </Box>

          {targetReplicas === 0 && currentReplicas > 0 ? (
            <Text color="yellow">
              Al quedar en 0 réplicas podrás trasladar esta BD a otro agente con (m).
            </Text>
          ) : null}

          <Text dimColor>
            [←/→ o +/-] Ajustar · [Enter] Continuar · [Esc/Q] Cancelar
          </Text>
        </Box>
      )}

      {step === 'choose_agents' && (
        <Box flexDirection="column" gap={1}>
          <Text>
            Selecciona <Text bold color="yellow">{neededExtraLabels}</Text> agente
            {neededExtraLabels === 1 ? '' : 's'} para añadir el label{' '}
            <Text color="green" bold>
              {label?.display}
            </Text>
            :
          </Text>
          <Box flexDirection="column">
            {candidateAgents.map((ag, idx) => {
              const isCursor = idx === agentCursor;
              const isChecked = selectedExtraAgents.includes(ag.name);
              return (
                <Box key={ag.name} gap={1}>
                  <Text color={isCursor ? 'cyan' : 'gray'}>
                    {isCursor ? '❯' : ' '}
                  </Text>
                  <Text color={isChecked ? 'green' : 'gray'} bold={isChecked}>
                    {isChecked ? '[✔]' : '[ ]'}
                  </Text>
                  <Text color={isCursor ? 'cyan' : 'white'} bold={isCursor}>
                    {ag.name}
                  </Text>
                  <Text dimColor>
                    ({ag.ready ? 'Ready' : 'NotReady'} · {ag.internalIp || 'sin IP'})
                  </Text>
                </Box>
              );
            })}
          </Box>
          <Text dimColor>
            Seleccionados: {selectedExtraAgents.length}/{neededExtraLabels} · [Espacio] Marcar · [Enter] Continuar · [Esc] Atrás
          </Text>
        </Box>
      )}

      {step === 'confirm' && (
        <Box flexDirection="column" gap={1}>
          <Text bold color="yellow">
            Confirmar ajuste de réplicas:
          </Text>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
          >
            <Text>
              <Text dimColor>Cambio: </Text>
              <Text bold>
                {currentReplicas} → {targetReplicas} réplica{targetReplicas === 1 ? '' : 's'}
              </Text>{' '}
              <Text dimColor>
                (instances: {db.instances} → {targetInstances})
              </Text>
            </Text>
            {selectedExtraAgents.length > 0 && label ? (
              <Text>
                <Text dimColor>Etiquetar con {label.display}: </Text>
                <Text color="green" bold>
                  {selectedExtraAgents.join(', ')}
                </Text>
              </Text>
            ) : null}
            {replicasToDestroy.length > 0 ? (
              <Text>
                <Text dimColor>Réplicas a destruir (y su PVC): </Text>
                <Text color="red" bold>
                  {replicasToDestroy
                    .map((r) => `${r.name} @ ${r.nodeName}`)
                    .join(', ')}
                </Text>
              </Text>
            ) : null}
            <Text>
              <Text dimColor>Primario protegido (sin tocar): </Text>
              <Text color="green">
                {db.currentPrimary} @ {db.primaryNode}
              </Text>
            </Text>
          </Box>
          <Text>
            <Text color="green" bold>
              [Enter] Aplicar cambio
            </Text>
            {' · '}
            <Text dimColor>[Esc] Atrás · [Q] Cancelar</Text>
          </Text>
        </Box>
      )}

      {step === 'applying' && (
        <Box flexDirection="column" gap={1}>
          <Box gap={1}>
            <Spinner />
            <Text bold color="cyan">
              Aplicando cambio de réplicas...
            </Text>
          </Box>
          <Box flexDirection="column">
            {logs.map((line, i) => (
              <Text key={`${i}-${line}`} dimColor={i < logs.length - 1}>
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {step === 'done' && (
        <Box flexDirection="column" gap={1}>
          <Text bold color="green">
            ✔ Réplicas actualizadas correctamente
          </Text>
          <Box flexDirection="column">
            {logs.map((line, i) => (
              <Text key={`${i}-${line}`} dimColor={i < logs.length - 1}>
                {line}
              </Text>
            ))}
          </Box>
          <Text dimColor>[Enter / Esc / Q] Volver al menú principal</Text>
        </Box>
      )}

      {step === 'error' && (
        <Box flexDirection="column" gap={1}>
          <Text bold color="red">
            ✖ Error al ajustar réplicas
          </Text>
          <Text color="red">{errorMsg}</Text>
          <Text dimColor>[Enter / Esc / Q] Cerrar</Text>
        </Box>
      )}
    </Box>
  );
}
