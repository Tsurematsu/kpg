import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from './Spinner.js';
import { FooterBar } from './FooterBar.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  CNPG_DEFAULT_VERSION,
  checkCnpgOperator,
  checkCnpgPlugin,
  checkKubectlConnection,
  getAgentNodes,
  getNodes,
  installCnpgOperator,
} from '../services/cnpg.js';
import type {
  CnpgPluginStatus,
  KubectlConnectionStatus,
  NodeInfo,
  OperatorStatus,
} from '../types/k8s.js';

export interface PreFlightResult {
  kubectl: KubectlConnectionStatus;
  plugin: CnpgPluginStatus;
  operator: OperatorStatus;
}

interface PreFlightScreenProps {
  onReady: (result: PreFlightResult) => void;
  onExit: () => void;
}

type Stage =
  | 'checking'
  | 'kubectl_error'
  | 'operator_missing'
  | 'installing'
  | 'install_error';

interface AgentOption {
  label: string;
  nodeName: string | null;
  detail: string;
  ready: boolean;
}

export function PreFlightScreen({ onReady, onExit }: PreFlightScreenProps) {
  const { rows: termHeight } = useTerminalSize();
  const [stage, setStage] = useState<Stage>('checking');
  const [statusMessage, setStatusMessage] = useState('Verificando conexión con kubectl...');
  const [kubectl, setKubectl] = useState<KubectlConnectionStatus | null>(null);
  const [plugin, setPlugin] = useState<CnpgPluginStatus | null>(null);
  const [operator, setOperator] = useState<OperatorStatus | null>(null);
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [installLogs, setInstallLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>('');

  const runChecks = useCallback(async () => {
    setStage('checking');
    setErrorMsg('');
    setStatusMessage('Verificando conexión con kubectl...');

    const kStatus = await checkKubectlConnection();
    setKubectl(kStatus);

    if (!kStatus.installed || !kStatus.connected) {
      setErrorMsg(kStatus.error || 'No se pudo conectar con Kubernetes.');
      setStage('kubectl_error');
      return;
    }

    setStatusMessage('Verificando plugin kubectl-cnpg y operador CNPG...');
    const [pStatus, opStatus] = await Promise.all([
      checkCnpgPlugin(),
      checkCnpgOperator(),
    ]);
    setPlugin(pStatus);
    setOperator(opStatus);

    if (opStatus.installed) {
      onReady({ kubectl: kStatus, plugin: pStatus, operator: opStatus });
      return;
    }

    // Operator not installed -> load nodes to let user pick an agent
    setStatusMessage('Cargando agentes disponibles para instalar el operador...');
    try {
      const nodes: NodeInfo[] = await getNodes();
      const agents = getAgentNodes(nodes).sort((a, b) =>
        a.name.localeCompare(b.name),
      );

      const options: AgentOption[] = agents.map((n) => ({
        label: n.name,
        nodeName: n.name,
        detail: `${n.ready ? 'Ready' : 'NotReady'} · ${n.internalIp || 'sin IP'} · agent`,
        ready: n.ready,
      }));

      options.push({
        label: 'Automático (scheduler de Kubernetes)',
        nodeName: null,
        detail: 'Sin nodeSelector fijo',
        ready: true,
      });

      setAgentOptions(options);
      setSelectedIndex(0);
      setStage('operator_missing');
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Error al consultar los nodos del cluster.',
      );
      setStage('kubectl_error');
    }
  }, [onReady]);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  const startInstall = useCallback(
    async (agentNodeName: string | null) => {
      setStage('installing');
      setInstallLogs([]);
      setErrorMsg('');

      try {
        const installedOp = await installCnpgOperator(agentNodeName, (line) => {
          setInstallLogs((prev) => [...prev.slice(-11), line]);
        });
        setOperator(installedOp);

        if (kubectl && plugin) {
          onReady({ kubectl, plugin, operator: installedOp });
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStage('install_error');
      }
    },
    [kubectl, plugin, onReady],
  );

  useInput((input, key) => {
    const lower = input.toLowerCase();

    if (stage === 'installing') {
      // Avoid accidental exit mid-apply; allow only Ctrl+C handled globally
      return;
    }

    if (key.escape || lower === 'q') {
      onExit();
      return;
    }

    if (stage === 'kubectl_error' || stage === 'install_error') {
      if (lower === 'r') {
        void runChecks();
      }
      if (stage === 'install_error' && lower === 's' && kubectl && plugin && operator) {
        onReady({ kubectl, plugin, operator });
      }
      return;
    }

    if (stage === 'operator_missing') {
      if (key.upArrow || lower === 'k') {
        setSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : Math.max(0, agentOptions.length - 1),
        );
      } else if (key.downArrow || lower === 'j') {
        setSelectedIndex((prev) =>
          prev < agentOptions.length - 1 ? prev + 1 : 0,
        );
      } else if (key.return) {
        const chosen = agentOptions[selectedIndex];
        if (chosen) {
          void startInstall(chosen.nodeName);
        }
      } else if (lower === 's' && kubectl && plugin && operator) {
        onReady({ kubectl, plugin, operator });
      } else if (lower === 'r') {
        void runChecks();
      }
    }
  });

  return (
    <Box
      flexDirection="column"
      height={Math.max(18, termHeight)}
      justifyContent="space-between"
    >
      <Box flexDirection="column" gap={1}>
        <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={0}>
          <Text bold color="cyan">
            kpg
          </Text>
          <Text> · Verificación inicial del entorno Kubernetes / CloudNativePG</Text>
        </Box>

        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={2}
          paddingY={1}
          gap={1}
        >
          {/* Check 1: kubectl */}
          <Box gap={1}>
            {kubectl === null ? (
              <Spinner />
            ) : kubectl.connected ? (
              <Text color="green">✔</Text>
            ) : (
              <Text color="red">✖</Text>
            )}
            <Text bold>kubectl:</Text>
            {kubectl === null ? (
              <Text dimColor>Comprobando...</Text>
            ) : kubectl.connected ? (
              <Text color="green">
                Conectado a {kubectl.context} ({kubectl.serverVersion})
              </Text>
            ) : (
              <Text color="red">Sin conexión</Text>
            )}
          </Box>

          {/* Check 2: kubectl-cnpg plugin */}
          <Box gap={1}>
            {plugin === null ? (
              stage === 'checking' && kubectl?.connected ? (
                <Spinner />
              ) : (
                <Text dimColor>○</Text>
              )
            ) : plugin.installed ? (
              <Text color="green">✔</Text>
            ) : (
              <Text color="yellow">!</Text>
            )}
            <Text bold>Plugin kubectl-cnpg:</Text>
            {plugin === null ? (
              <Text dimColor>Pendiente</Text>
            ) : plugin.installed ? (
              <Text color="green">Instalado{plugin.path ? ` (${plugin.path})` : ''}</Text>
            ) : (
              <Text color="yellow">
                No detectado (necesario para promote, destroy y psql)
              </Text>
            )}
          </Box>

          {/* Check 3: CNPG Operator */}
          <Box gap={1}>
            {operator === null ? (
              stage === 'checking' && kubectl?.connected ? (
                <Spinner />
              ) : (
                <Text dimColor>○</Text>
              )
            ) : operator.installed ? (
              <Text color="green">✔</Text>
            ) : (
              <Text color="yellow">!</Text>
            )}
            <Text bold>Operador CNPG (cnpg-system):</Text>
            {operator === null ? (
              <Text dimColor>Pendiente</Text>
            ) : operator.installed ? (
              <Text color="green">
                Instalado ({operator.readyReplicas}/{operator.replicas} Ready)
              </Text>
            ) : (
              <Text color="yellow">No instalado</Text>
            )}
          </Box>
        </Box>

        {stage === 'checking' && (
          <Box paddingX={2} gap={1}>
            <Spinner />
            <Text>{statusMessage}</Text>
          </Box>
        )}

        {stage === 'kubectl_error' && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="red"
            paddingX={2}
            paddingY={1}
            gap={1}
          >
            <Text bold color="red">
              No se pudo establecer conexión con Kubernetes
            </Text>
            <Text>{errorMsg}</Text>
            {kubectl?.serverUrl ? (
              <Text dimColor>Servidor configurado: {kubectl.serverUrl}</Text>
            ) : null}
            <Text dimColor>
              Verifica tu ~/.kube/config, que el cluster k3s esté encendido o el túnel SSH.
            </Text>
          </Box>
        )}

        {stage === 'operator_missing' && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="yellow"
            paddingX={2}
            paddingY={1}
            gap={1}
          >
            <Text bold color="yellow">
              El operador CloudNativePG no está instalado
            </Text>
            <Text>
              Se instalará CNPG <Text bold>{CNPG_DEFAULT_VERSION}</Text> con{' '}
              <Text bold>replicas: 1</Text> (sin réplicas extra) mediante{' '}
              <Text dimColor>kubectl apply --server-side</Text>.
            </Text>
            <Text bold>Selecciona en qué agente instalar el operador:</Text>

            <Box flexDirection="column" marginTop={0}>
              {agentOptions.map((opt, idx) => {
                const isSelected = idx === selectedIndex;
                return (
                  <Box key={opt.label} gap={1}>
                    <Text color={isSelected ? 'cyan' : 'gray'} bold={isSelected}>
                      {isSelected ? '❯' : ' '}
                    </Text>
                    <Text
                      color={isSelected ? 'cyan' : opt.ready ? 'white' : 'red'}
                      bold={isSelected}
                    >
                      {opt.label}
                    </Text>
                    <Text dimColor>— {opt.detail}</Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {stage === 'installing' && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
            paddingY={1}
            gap={1}
          >
            <Box gap={1}>
              <Spinner color="cyan" />
              <Text bold color="cyan">
                Instalando operador CloudNativePG...
              </Text>
            </Box>
            <Box flexDirection="column">
              {installLogs.map((line, i) => (
                <Text key={`${i}-${line}`} dimColor={i < installLogs.length - 1}>
                  {line}
                </Text>
              ))}
            </Box>
          </Box>
        )}

        {stage === 'install_error' && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="red"
            paddingX={2}
            paddingY={1}
            gap={1}
          >
            <Text bold color="red">
              Error durante la instalación del operador CNPG
            </Text>
            <Text>{errorMsg}</Text>
          </Box>
        )}
      </Box>

      <FooterBar
        items={
          stage === 'operator_missing'
            ? [
                { key: '↑/↓', label: 'Elegir agente' },
                { key: 'Enter', label: 'Instalar operador', accent: 'green' },
                { key: 's', label: 'Omitir y entrar' },
                { key: 'r', label: 'Reintentar' },
                { key: 'Q/Esc', label: 'Salir', accent: 'red' },
              ]
            : stage === 'kubectl_error'
              ? [
                  { key: 'r', label: 'Reintentar conexión', accent: 'green' },
                  { key: 'Q/Esc', label: 'Salir', accent: 'red' },
                ]
              : stage === 'install_error'
                ? [
                    { key: 'r', label: 'Reintentar', accent: 'green' },
                    { key: 's', label: 'Entrar sin operador' },
                    { key: 'Q/Esc', label: 'Salir', accent: 'red' },
                  ]
                : [{ key: 'Q/Esc', label: 'Salir', accent: 'red' }]
        }
      />
    </Box>
  );
}
