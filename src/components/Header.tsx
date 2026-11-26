import React from 'react';
import { Box, Text } from 'ink';
import { Spinner } from './Spinner.js';
import type {
  CnpgPluginStatus,
  KubectlConnectionStatus,
  OperatorStatus,
} from '../types/k8s.js';

interface HeaderProps {
  kubectl: KubectlConnectionStatus | null;
  plugin: CnpgPluginStatus | null;
  operator: OperatorStatus | null;
  refreshing?: boolean;
  lastUpdated?: Date | null;
}

export function Header({
  kubectl,
  plugin,
  operator,
  refreshing = false,
  lastUpdated = null,
}: HeaderProps) {
  const timeStr = lastUpdated
    ? lastUpdated.toLocaleTimeString('es-ES', { hour12: false })
    : '--:--:--';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold color="cyan">
            kpg
          </Text>
          <Text dimColor>·</Text>
          <Text>CloudNativePG TUI Manager</Text>
        </Box>
        <Box gap={2}>
          {refreshing ? (
            <Box gap={1}>
              <Spinner color="cyan" />
              <Text dimColor>Actualizando...</Text>
            </Box>
          ) : (
            <Text dimColor>Sync: {timeStr}</Text>
          )}
        </Box>
      </Box>

      <Box justifyContent="space-between" marginTop={0}>
        <Box gap={2}>
          <Text>
            <Text dimColor>Contexto: </Text>
            <Text color={kubectl?.connected ? 'green' : 'red'} bold>
              {kubectl?.context || 'desconectado'}
            </Text>
            {kubectl?.serverVersion ? (
              <Text dimColor> ({kubectl.serverVersion})</Text>
            ) : null}
          </Text>

          <Text>
            <Text dimColor>Operador: </Text>
            {operator?.installed ? (
              <Text color={operator.ready ? 'green' : 'yellow'}>
                {operator.ready ? '● Ready' : '◐ Iniciando'}
                {operator.nodeName ? ` @ ${operator.nodeName}` : ''}
              </Text>
            ) : (
              <Text color="red">○ No instalado</Text>
            )}
          </Text>
        </Box>

        <Box>
          <Text>
            <Text dimColor>cnpg-plugin: </Text>
            {plugin?.installed ? (
              <Text color="green">OK</Text>
            ) : (
              <Text color="yellow">No detectado</Text>
            )}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
