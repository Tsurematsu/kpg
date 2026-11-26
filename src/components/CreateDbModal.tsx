import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInputField } from './TextInputField.js';
import { Spinner } from './Spinner.js';
import {
  KPG_NS_USAGE_LABEL,
  createClusterDB,
  generateUniqueLabelId,
  getAgentNodes,
  getDefaultStorageClass,
  getSelectableNamespaces,
  listClusterDBs,
} from '../services/cnpg.js';
import type { ClusterDBInfo, NamespaceInfo, NodeInfo } from '../types/k8s.js';

interface CreateDbModalProps {
  nodes: NodeInfo[];
  namespaces: NamespaceInfo[];
  existingDbs: ClusterDBInfo[];
  onDone: (refresh: boolean) => void;
}

type Step =
  | 'namespace'
  | 'name'
  | 'agent'
  | 'storage'
  | 'version'
  | 'confirm'
  | 'creating'
  | 'done'
  | 'error';

const POSTGRES_VERSIONS = [
  { label: 'PostgreSQL 16.8 (probado)', image: 'ghcr.io/cloudnative-pg/postgresql:16.8' },
  { label: 'PostgreSQL 17.2', image: 'ghcr.io/cloudnative-pg/postgresql:17.2' },
  { label: 'PostgreSQL 15.10', image: 'ghcr.io/cloudnative-pg/postgresql:15.10' },
];

const DNS_NAME_REGEX = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const STORAGE_REGEX = /^\d+(Mi|Gi|Ti)$/;

export function CreateDbModal({
  nodes,
  namespaces,
  existingDbs,
  onDone,
}: CreateDbModalProps) {
  const agents = useMemo(
    () =>
      [...getAgentNodes(nodes)].sort((a, b) => a.name.localeCompare(b.name)),
    [nodes],
  );

  const selectableNamespaces = useMemo(
    () => getSelectableNamespaces(namespaces),
    [namespaces],
  );

  const dbCountByNs = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of existingDbs) {
      map.set(d.namespace, (map.get(d.namespace) ?? 0) + 1);
    }
    return map;
  }, [existingDbs]);

  const labelId = useMemo(() => generateUniqueLabelId(nodes), [nodes]);

  const [step, setStep] = useState<Step>('namespace');
  const [nsIdx, setNsIdx] = useState(0);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [agentIdx, setAgentIdx] = useState(0);
  const [storageSize, setStorageSize] = useState('5Gi');
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageClass, setStorageClass] = useState('local-path');
  const [versionIdx, setVersionIdx] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [clusterPhase, setClusterPhase] = useState('');
  const cancelledRef = useRef(false);

  useEffect(() => {
    void getDefaultStorageClass().then(setStorageClass);
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const selectedNamespace = selectableNamespaces[nsIdx] ?? null;
  const selectedAgent = agents[agentIdx] ?? null;
  const selectedVersion = POSTGRES_VERSIONS[versionIdx] ?? POSTGRES_VERSIONS[0];

  const validateAndNextFromName = () => {
    if (!selectedNamespace) {
      setStep('namespace');
      return;
    }
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) {
      setNameError('Ingresa un nombre para la base de datos.');
      return;
    }
    if (trimmed.length > 48 || !DNS_NAME_REGEX.test(trimmed)) {
      setNameError('Solo minúsculas, números y guiones (ej: ventas-db).');
      return;
    }
    if (
      existingDbs.some(
        (d) => d.name === trimmed && d.namespace === selectedNamespace.name,
      )
    ) {
      setNameError(
        `Ya existe una BD llamada "${trimmed}" en el namespace "${selectedNamespace.name}".`,
      );
      return;
    }
    setName(trimmed);
    setNameError(null);
    if (agents.length === 0) {
      setErrorMsg('No hay agentes disponibles (el server control-plane está excluido).');
      setStep('error');
      return;
    }
    setStep('agent');
  };

  const validateAndNextFromStorage = () => {
    const trimmed = storageSize.trim();
    if (!STORAGE_REGEX.test(trimmed)) {
      setStorageError('Usa formato Kubernetes válido: 1Gi, 5Gi, 20Gi, 500Mi...');
      return;
    }
    setStorageSize(trimmed);
    setStorageError(null);
    setStep('version');
  };

  const runCreate = async () => {
    if (!selectedAgent || !selectedNamespace) return;
    setStep('creating');
    setLogs([]);
    setErrorMsg('');

    try {
      await createClusterDB(
        {
          name,
          namespace: selectedNamespace.name,
          agentNode: selectedAgent.name,
          storageSize,
          storageClass,
          imageName: selectedVersion.image,
          labelId,
        },
        (msg) => setLogs((prev) => [...prev.slice(-8), msg]),
      );

      setLogs((prev) => [
        ...prev.slice(-8),
        'Esperando inicialización del pod primario (puedes pulsar Esc para seguir en segundo plano)...',
      ]);

      // Wait up to 90s for initial pod healthy, checking every 3s
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        if (cancelledRef.current) return;
        try {
          const dbs = await listClusterDBs();
          if (cancelledRef.current) return;
          const created = dbs.find(
            (d) => d.name === name && d.namespace === selectedNamespace.name,
          );
          if (created) {
            setClusterPhase(created.phase);
            if (created.healthy && created.readyInstances >= 1) {
              setLogs((prev) => [
                ...prev.slice(-8),
                `✔ ${created.currentPrimary} Running en ${created.primaryNode} (ns: ${created.namespace})`,
              ]);
              setStep('done');
              return;
            }
          }
        } catch {
          // continue polling
        }
      }

      if (!cancelledRef.current) setStep('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  useInput(
    (input, key) => {
      const lower = input.toLowerCase();

      if (step === 'creating') {
        if (key.escape) {
          onDone(true);
        }
        return;
      }

      if (step === 'done' || step === 'error') {
        if (key.escape || key.return || lower === 'q') {
          onDone(step === 'done');
        }
        return;
      }

      if (step === 'namespace') {
        if (key.escape || lower === 'q') {
          onDone(false);
          return;
        }
        if (selectableNamespaces.length === 0) return;
        if (key.upArrow || lower === 'k') {
          setNsIdx((prev) =>
            prev > 0 ? prev - 1 : selectableNamespaces.length - 1,
          );
        } else if (key.downArrow || lower === 'j') {
          setNsIdx((prev) =>
            prev < selectableNamespaces.length - 1 ? prev + 1 : 0,
          );
        } else if (key.return && selectedNamespace) {
          setNameError(null);
          setStep('name');
        }
        return;
      }

      if (step === 'agent') {
        if (key.escape) {
          setStep('name');
          return;
        }
        if (lower === 'q') {
          onDone(false);
          return;
        }
        if (key.upArrow || lower === 'k') {
          setAgentIdx((prev) => (prev > 0 ? prev - 1 : agents.length - 1));
        } else if (key.downArrow || lower === 'j') {
          setAgentIdx((prev) => (prev < agents.length - 1 ? prev + 1 : 0));
        } else if (key.return) {
          setStep('storage');
        }
        return;
      }

      if (step === 'version') {
        if (key.escape) {
          setStep('storage');
          return;
        }
        if (lower === 'q') {
          onDone(false);
          return;
        }
        if (key.upArrow || lower === 'k') {
          setVersionIdx((prev) =>
            prev > 0 ? prev - 1 : POSTGRES_VERSIONS.length - 1,
          );
        } else if (key.downArrow || lower === 'j') {
          setVersionIdx((prev) =>
            prev < POSTGRES_VERSIONS.length - 1 ? prev + 1 : 0,
          );
        } else if (key.return) {
          setStep('confirm');
        }
        return;
      }

      if (step === 'confirm') {
        if (key.escape) {
          setStep('version');
          return;
        }
        if (lower === 'q') {
          onDone(false);
          return;
        }
        if (key.return || lower === 'y' || lower === 's') {
          void runCreate();
        }
      }
    },
    { isActive: step !== 'name' && step !== 'storage' },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="green"
      paddingX={2}
      paddingY={1}
      width="82%"
      backgroundColor="black"
      gap={1}
    >
      <Box justifyContent="space-between">
        <Text bold color="green">
          + Nueva Base de Datos CNPG (0 réplicas)
        </Text>
        <Text dimColor>
          Label ID:{' '}
          <Text color="yellow" bold>
            {labelId.display}
          </Text>
        </Text>
      </Box>

      {step === 'namespace' && (
        <Box flexDirection="column" gap={1}>
          <Text>
            1/5 · Selecciona el <Text bold>namespace</Text> existente donde vivirá la BD (excluye{' '}
            <Text dimColor>default</Text> y sistema):
          </Text>
          {selectableNamespaces.length === 0 ? (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor="yellow"
              paddingX={1}
              gap={0}
            >
              <Text color="yellow" bold>
                No hay namespaces personalizados disponibles en el cluster.
              </Text>
              <Text dimColor>
                kpg ignora &quot;default&quot; para nuevos despliegues y no crea namespaces. Crea uno primero con tu herramienta de namespaces o ejecuta: kubectl create namespace &lt;nombre&gt;
              </Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              {selectableNamespaces.map((ns, idx) => {
                const selected = idx === nsIdx;
                const count = dbCountByNs.get(ns.name) ?? 0;
                const otherKeys = Object.keys(ns.otherToolLabels);
                return (
                  <Box key={ns.name} justifyContent="space-between">
                    <Box gap={1}>
                      <Text color={selected ? 'cyan' : 'gray'} bold={selected}>
                        {selected ? '❯' : ' '}
                      </Text>
                      <Text color={ns.usedByKpg ? 'green' : 'gray'}>
                        {ns.usedByKpg ? '★' : '●'}
                      </Text>
                      <Text color={selected ? 'cyan' : 'white'} bold={selected}>
                        {ns.name}
                      </Text>
                      <Text dimColor>
                        ({count} BD{count === 1 ? '' : 's'})
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
          <Text dimColor>
            {selectableNamespaces.length > 0
              ? '[↑/↓] Elegir · [Enter] Siguiente · [Esc/Q] Cancelar'
              : '[Esc/Q] Volver al menú principal'}
          </Text>
        </Box>
      )}

      {step === 'name' && (
        <Box flexDirection="column" gap={1}>
          <Text>
            2/5 · Nombre de la base de datos en{' '}
            <Text color="cyan" bold>
              {selectedNamespace?.name}
            </Text>{' '}
            (ej. <Text dimColor>ventas-db</Text>):
          </Text>
          <TextInputField
            value={name}
            onChange={(val) => {
              setName(val.toLowerCase());
              setNameError(null);
            }}
            onSubmit={validateAndNextFromName}
            onCancel={() => setStep('namespace')}
            placeholder="mi-nueva-db"
            isActive
          />
          {nameError ? <Text color="red">{nameError}</Text> : null}
          <Text dimColor>[Enter] Siguiente · [Esc] Atrás</Text>
        </Box>
      )}

      {step === 'agent' && (
        <Box flexDirection="column" gap={1}>
          <Text>
            3/5 · Selecciona el <Text bold>agente</Text> donde nacerá{' '}
            <Text color="cyan" bold>
              {name}
            </Text>
            :
          </Text>
          <Box flexDirection="column">
            {agents.map((ag, idx) => {
              const selected = idx === agentIdx;
              return (
                <Box key={ag.name} gap={1}>
                  <Text color={selected ? 'cyan' : 'gray'} bold={selected}>
                    {selected ? '❯' : ' '}
                  </Text>
                  <Text color={ag.ready ? 'green' : 'red'}>
                    {ag.ready ? '●' : '○'}
                  </Text>
                  <Text color={selected ? 'cyan' : 'white'} bold={selected}>
                    {ag.name}
                  </Text>
                  <Text dimColor>
                    ({ag.internalIp || 'sin IP'})
                  </Text>
                </Box>
              );
            })}
          </Box>
          <Text dimColor>[↑/↓] Elegir · [Enter] Siguiente · [Esc] Atrás · [Q] Cancelar</Text>
        </Box>
      )}

      {step === 'storage' && (
        <Box flexDirection="column" gap={1}>
          <Text>
            4/5 · Tamaño de volumen persistente (StorageClass:{' '}
            <Text color="cyan">{storageClass}</Text>):
          </Text>
          <TextInputField
            value={storageSize}
            onChange={(val) => {
              setStorageSize(val);
              setStorageError(null);
            }}
            onSubmit={validateAndNextFromStorage}
            onCancel={() => setStep('agent')}
            placeholder="5Gi"
            isActive
          />
          {storageError ? <Text color="red">{storageError}</Text> : null}
          <Text dimColor>[Enter] Siguiente · [Esc] Atrás</Text>
        </Box>
      )}

      {step === 'version' && (
        <Box flexDirection="column" gap={1}>
          <Text>5/5 · Selecciona la versión de PostgreSQL:</Text>
          <Box flexDirection="column">
            {POSTGRES_VERSIONS.map((v, idx) => {
              const selected = idx === versionIdx;
              return (
                <Box key={v.image} gap={1}>
                  <Text color={selected ? 'cyan' : 'gray'} bold={selected}>
                    {selected ? '❯' : ' '}
                  </Text>
                  <Text color={selected ? 'cyan' : 'white'} bold={selected}>
                    {v.label}
                  </Text>
                </Box>
              );
            })}
          </Box>
          <Text dimColor>[↑/↓] Elegir · [Enter] Revisar · [Esc] Atrás</Text>
        </Box>
      )}

      {step === 'confirm' && (
        <Box flexDirection="column" gap={1}>
          <Text bold color="yellow">
            Confirmar creación de base de datos:
          </Text>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
          >
            <Text>
              <Text dimColor>Nombre: </Text>
              <Text bold>{name}</Text>
            </Text>
            <Text>
              <Text dimColor>Namespace: </Text>
              <Text color="cyan" bold>
                {selectedNamespace?.name}
              </Text>{' '}
              <Text dimColor>(se marcará {KPG_NS_USAGE_LABEL}=true)</Text>
            </Text>
            <Text>
              <Text dimColor>Agente destino: </Text>
              <Text color="green" bold>
                {selectedAgent?.name}
              </Text>
            </Text>
            <Text>
              <Text dimColor>Label único: </Text>
              <Text color="yellow" bold>
                {labelId.key}={labelId.value}
              </Text>
            </Text>
            <Text>
              <Text dimColor>Instancias: </Text>
              <Text>1 (0 réplicas · podAntiAffinityType: required)</Text>
            </Text>
            <Text>
              <Text dimColor>Disco: </Text>
              <Text>
                {storageSize} ({storageClass})
              </Text>
            </Text>
            <Text>
              <Text dimColor>Imagen: </Text>
              <Text>{selectedVersion.image}</Text>
            </Text>
          </Box>
          <Text>
            <Text color="green" bold>
              [Enter] Crear ahora
            </Text>
            {' · '}
            <Text dimColor>[Esc] Volver atrás · [Q] Cancelar</Text>
          </Text>
        </Box>
      )}

      {step === 'creating' && (
        <Box flexDirection="column" gap={1}>
          <Box gap={1}>
            <Spinner color="green" />
            <Text bold color="green">
              Creando &quot;{name}&quot; en {selectedAgent?.name}...
            </Text>
            {clusterPhase ? <Text dimColor>({clusterPhase})</Text> : null}
          </Box>
          <Box flexDirection="column">
            {logs.map((line, i) => (
              <Text key={`${i}-${line}`} dimColor={i < logs.length - 1}>
                {line}
              </Text>
            ))}
          </Box>
          <Text dimColor>[Esc] Volver al menú mientras termina de inicializar</Text>
        </Box>
      )}

      {step === 'done' && (
        <Box flexDirection="column" gap={1}>
          <Text bold color="green">
            ✔ Base de datos &quot;{name}&quot; creada correctamente
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
            ✖ Error al crear la base de datos
          </Text>
          <Text color="red">{errorMsg}</Text>
          <Text dimColor>[Enter / Esc / Q] Cerrar</Text>
        </Box>
      )}
    </Box>
  );
}
