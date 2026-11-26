import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getAgentNodes } from '../services/cnpg.js';
import type { ClusterDBInfo, NodeInfo } from '../types/k8s.js';

interface LabelsModalProps {
  nodes: NodeInfo[];
  selectedDb: ClusterDBInfo | null;
  onClose: () => void;
}

export function LabelsModal({ nodes, selectedDb, onClose }: LabelsModalProps) {
  const [showSystemLabels, setShowSystemLabels] = useState(false);
  const [selectedNodeIdx, setSelectedNodeIdx] = useState(0);

  // Only show agent nodes (exclude control-plane/server)
  const sortedNodes = useMemo(() => {
    return [...getAgentNodes(nodes)].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [nodes]);

  useInput((input, key) => {
    const lower = input.toLowerCase();
    if (key.escape || lower === 'q' || lower === 'l') {
      onClose();
      return;
    }
    if (lower === 's') {
      setShowSystemLabels((prev) => !prev);
      return;
    }
    if (key.upArrow || lower === 'k') {
      setSelectedNodeIdx((prev) =>
        prev > 0 ? prev - 1 : Math.max(0, sortedNodes.length - 1),
      );
    } else if (key.downArrow || lower === 'j') {
      setSelectedNodeIdx((prev) =>
        prev < sortedNodes.length - 1 ? prev + 1 : 0,
      );
    }
  });

  const targetLabelKey = selectedDb?.labelId?.key ?? null;
  const targetLabelVal = selectedDb?.labelId?.value ?? null;

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
      {/* Modal Title */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Box gap={1}>
          <Text bold color="cyan">
            ◆ Agentes y Labels
          </Text>
          {selectedDb ? (
            <Text dimColor>
              (BD: <Text color="white">{selectedDb.name}</Text>
              {selectedDb.labelId ? (
                <>
                  {' '}
                  · Label ID:{' '}
                  <Text color="green" bold>
                    {selectedDb.labelId.display}
                  </Text>
                </>
              ) : null}
              )
            </Text>
          ) : null}
        </Box>
        <Text dimColor>[Esc/l/Q] Cerrar</Text>
      </Box>

      {/* Nodes list */}
      {sortedNodes.length === 0 ? (
        <Text dimColor>No se encontraron agentes disponibles en el cluster.</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {sortedNodes.map((node, idx) => {
            const isSelected = idx === selectedNodeIdx;
            const entries = Object.entries(
              showSystemLabels ? node.labels : node.customLabels,
            ).sort(([a], [b]) => a.localeCompare(b));

            const hasDbLabel =
              targetLabelKey !== null &&
              node.labels[targetLabelKey] === targetLabelVal;

            return (
              <Box
                key={node.name}
                flexDirection="column"
                borderStyle={isSelected ? 'round' : 'single'}
                borderColor={
                  isSelected ? 'cyan' : hasDbLabel ? 'green' : 'gray'
                }
                paddingX={1}
              >
                <Box justifyContent="space-between">
                  <Box gap={1}>
                    <Text color={node.ready ? 'green' : 'red'}>
                      {node.ready ? '●' : '○'}
                    </Text>
                    <Text bold color={isSelected ? 'cyan' : 'white'}>
                      {node.name}
                    </Text>
                    <Text dimColor>
                      [{node.isControlPlane ? 'control-plane' : 'agent'}]
                    </Text>
                    {node.internalIp ? (
                      <Text dimColor>{node.internalIp}</Text>
                    ) : null}
                  </Box>
                  {hasDbLabel ? (
                    <Text color="green" bold>
                      ★ Vinculado a {selectedDb?.name}
                    </Text>
                  ) : null}
                </Box>

                <Box flexDirection="column" marginLeft={2}>
                  {entries.length === 0 ? (
                    <Text dimColor italic>
                      Sin labels personalizados
                      {!showSystemLabels ? ' (pulsa "s" para ver labels del sistema)' : ''}
                    </Text>
                  ) : (
                    entries.map(([k, v]) => {
                      const matchesSelectedDb =
                        targetLabelKey === k && targetLabelVal === v;
                      const isKpgLabel = k.startsWith('kpg.db/');
                      return (
                        <Box key={k} gap={1}>
                          <Text
                            color={
                              matchesSelectedDb
                                ? 'green'
                                : isKpgLabel
                                  ? 'yellow'
                                  : 'white'
                            }
                            bold={matchesSelectedDb || isKpgLabel}
                          >
                            {matchesSelectedDb ? '★' : '•'} {k}={v}
                          </Text>
                        </Box>
                      );
                    })
                  )}
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Modal footer */}
      <Box
        marginTop={1}
        justifyContent="space-between"
        borderStyle="single"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor="gray"
        paddingTop={0}
      >
        <Box gap={2}>
          <Text>
            <Text color="cyan" bold>
              (↑/↓)
            </Text>{' '}
            Navegar
          </Text>
          <Text>
            <Text color="cyan" bold>
              (s)
            </Text>{' '}
            {showSystemLabels ? 'Ocultar' : 'Mostrar'} labels del sistema
          </Text>
        </Box>
        <Text>
          <Text color="cyan" bold>
            (Esc/l/Q)
          </Text>{' '}
          Cerrar panel
        </Text>
      </Box>
    </Box>
  );
}
