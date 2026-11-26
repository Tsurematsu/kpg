import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from './Spinner.js';
import {
  KPG_NS_USAGE_LABEL,
  syncAllNamespaceUsageLabels,
} from '../services/cnpg.js';
import type { ClusterDBInfo, NamespaceInfo } from '../types/k8s.js';

interface NamespacesModalProps {
  namespaces: NamespaceInfo[];
  dbs: ClusterDBInfo[];
  onClose: (refresh: boolean) => void;
}

export function NamespacesModal({
  namespaces,
  dbs,
  onClose,
}: NamespacesModalProps) {
  const [showSystemAndDefault, setShowSystemAndDefault] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [didSync, setDidSync] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const visibleNamespaces = useMemo(() => {
    const filtered = showSystemAndDefault
      ? [...namespaces]
      : namespaces.filter((ns) => !ns.isSystem && !ns.isDefault);
    return filtered.sort((a, b) => {
      if (a.isSystem !== b.isSystem) return a.isSystem ? 1 : -1;
      if (a.isDefault !== b.isDefault) return a.isDefault ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }, [namespaces, showSystemAndDefault]);

  const dbCountByNs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const db of dbs) {
      counts.set(db.namespace, (counts.get(db.namespace) ?? 0) + 1);
    }
    return counts;
  }, [dbs]);

  const handleSync = async () => {
    setSyncing(true);
    setErrorMsg(null);
    setStatusNote(null);
    try {
      const res = await syncAllNamespaceUsageLabels();
      setDidSync(true);
      const parts: string[] = [];
      if (res.labeled.length > 0) {
        parts.push(`marcados: ${res.labeled.join(', ')}`);
      }
      if (res.unlabeled.length > 0) {
        parts.push(`liberados: ${res.unlabeled.join(', ')}`);
      }
      setStatusNote(
        parts.length > 0
          ? `✔ Labels ${KPG_NS_USAGE_LABEL} sincronizados (${parts.join(' · ')}).`
          : `✔ Todos los namespaces ya están sincronizados con ${KPG_NS_USAGE_LABEL}.`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  useInput((input, key) => {
    if (syncing) return;
    const lower = input.toLowerCase();

    if (key.escape || lower === 'q' || lower === 's') {
      onClose(didSync);
      return;
    }
    if (lower === 'y') {
      setShowSystemAndDefault((prev) => !prev);
      setSelectedIdx(0);
      return;
    }
    if (lower === 'r') {
      void handleSync();
      return;
    }
    if (key.upArrow || lower === 'k') {
      setSelectedIdx((prev) =>
        visibleNamespaces.length === 0
          ? 0
          : prev > 0
            ? prev - 1
            : visibleNamespaces.length - 1,
      );
      return;
    }
    if (key.downArrow || lower === 'j') {
      setSelectedIdx((prev) =>
        visibleNamespaces.length === 0
          ? 0
          : prev < visibleNamespaces.length - 1
            ? prev + 1
            : 0,
      );
    }
  });

  const maxVisible = 6;
  const clampedIdx = Math.min(
    selectedIdx,
    Math.max(0, visibleNamespaces.length - 1),
  );
  const windowStart = Math.max(
    0,
    Math.min(
      clampedIdx - Math.floor(maxVisible / 2),
      Math.max(0, visibleNamespaces.length - maxVisible),
    ),
  );
  const sliced = visibleNamespaces.slice(windowStart, windowStart + maxVisible);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      width="88%"
      backgroundColor="black"
    >
      {/* Title */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Box gap={1}>
          <Text bold color="cyan">
            ◆ Namespaces del cluster
          </Text>
          <Text dimColor>
            (solo lectura · label propio:{' '}
            <Text color="green" bold>
              {KPG_NS_USAGE_LABEL}=true
            </Text>
            )
          </Text>
        </Box>
        <Text dimColor>[Esc/s/Q] Cerrar</Text>
      </Box>

      {statusNote ? (
        <Box marginBottom={1}>
          <Text color="green">{statusNote}</Text>
        </Box>
      ) : null}

      {errorMsg ? (
        <Box borderStyle="round" borderColor="red" paddingX={1} marginBottom={1}>
          <Text color="red">✖ {errorMsg}</Text>
        </Box>
      ) : null}

      {syncing ? (
        <Box gap={1} paddingY={1}>
          <Spinner color="cyan" />
          <Text>Sincronizando labels {KPG_NS_USAGE_LABEL} en namespaces elegibles...</Text>
        </Box>
      ) : visibleNamespaces.length === 0 ? (
        <Box flexDirection="column" gap={1} paddingY={1}>
          <Text color="yellow" bold>
            No hay namespaces personalizados registrados en el cluster.
          </Text>
          <Text dimColor>
            kpg no crea ni elimina namespaces; usa tu herramienta externa (o kubectl create namespace &lt;nombre&gt;).
          </Text>
          <Text dimColor>
            Pulsa <Text color="cyan">(y)</Text> para ver default y namespaces de sistema.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" gap={0}>
          {sliced.map((ns, idx) => {
            const realIdx = windowStart + idx;
            const isSelected = realIdx === clampedIdx;
            const dbCount = dbCountByNs.get(ns.name) ?? 0;
            const otherEntries = Object.entries(ns.otherToolLabels).sort(
              ([a], [b]) => a.localeCompare(b),
            );
            const missingKpgLabel =
              !ns.isSystem && !ns.isDefault && dbCount > 0 && !ns.usedByKpg;
            const staleKpgLabel =
              !ns.isSystem && !ns.isDefault && dbCount === 0 && ns.usedByKpg;

            return (
              <Box
                key={ns.name}
                flexDirection="column"
                borderStyle={isSelected ? 'round' : 'single'}
                borderColor={
                  isSelected
                    ? 'cyan'
                    : ns.usedByKpg
                      ? 'green'
                      : otherEntries.length > 0
                        ? 'yellow'
                        : 'gray'
                }
                paddingX={1}
              >
                <Box justifyContent="space-between">
                  <Box gap={1}>
                    <Text color={ns.status === 'Active' ? 'green' : 'yellow'}>
                      {ns.status === 'Active' ? '●' : '○'}
                    </Text>
                    <Text bold color={isSelected ? 'cyan' : 'white'}>
                      {ns.name}
                    </Text>
                    <Text dimColor>
                      [{ns.status}] · {dbCount} BD{dbCount === 1 ? '' : 's'} CNPG
                    </Text>
                  </Box>

                  {ns.isDefault ? (
                    <Text color="yellow">reservado (ignorado)</Text>
                  ) : ns.isSystem ? (
                    <Text dimColor>[sistema]</Text>
                  ) : missingKpgLabel ? (
                    <Text color="yellow" bold>
                      ⚠ sin label {KPG_NS_USAGE_LABEL}
                    </Text>
                  ) : staleKpgLabel ? (
                    <Text color="yellow">
                      ⚠ label sin BDs (pulsa r)
                    </Text>
                  ) : ns.usedByKpg ? (
                    <Text color="green" bold>
                      ★ En uso por kpg
                    </Text>
                  ) : (
                    <Text dimColor>Libre (kpg)</Text>
                  )}
                </Box>

                <Box flexDirection="column" marginLeft={2}>
                  {ns.usedByKpg ? (
                    <Text color="green" bold>
                      ★ {KPG_NS_USAGE_LABEL}=true
                    </Text>
                  ) : null}
                  {otherEntries.map(([k, v]) => (
                    <Text key={k} color="yellow">
                      • {k}={v} <Text dimColor>(otra herramienta)</Text>
                    </Text>
                  ))}
                  {!ns.usedByKpg && otherEntries.length === 0 ? (
                    <Text dimColor italic>
                      Sin labels de herramientas
                    </Text>
                  ) : null}
                </Box>
              </Box>
            );
          })}

          {visibleNamespaces.length > maxVisible ? (
            <Text dimColor>
              ... mostrando {windowStart + 1}–
              {Math.min(visibleNamespaces.length, windowStart + maxVisible)} de{' '}
              {visibleNamespaces.length} namespaces
            </Text>
          ) : null}
        </Box>
      )}

      {/* Footer */}
      <Box
        marginTop={1}
        justifyContent="space-between"
        borderStyle="single"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor="gray"
      >
        <Box gap={2}>
          <Text>
            <Text color="cyan" bold>
              (↑/↓)
            </Text>{' '}
            Navegar
          </Text>
          <Text>
            <Text color="green" bold>
              (r)
            </Text>{' '}
            Sincronizar {KPG_NS_USAGE_LABEL}
          </Text>
          <Text>
            <Text color="yellow" bold>
              (y)
            </Text>{' '}
            {showSystemAndDefault ? 'Ocultar' : 'Ver'} sistema/default
          </Text>
        </Box>
        <Text>
          <Text color="cyan" bold>
            (Esc/s/Q)
          </Text>{' '}
          Cerrar
        </Text>
      </Box>
    </Box>
  );
}
