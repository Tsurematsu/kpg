import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInputField } from './TextInputField.js';
import { Spinner } from './Spinner.js';
import { deleteClusterDB } from '../services/cnpg.js';
import type { ClusterDBInfo, NodeInfo } from '../types/k8s.js';

interface DeleteDbModalProps {
  db: ClusterDBInfo;
  allDbs: ClusterDBInfo[];
  nodes: NodeInfo[];
  onDone: (refresh: boolean) => void;
}

type Step = 'confirm' | 'deleting' | 'done' | 'error';

export function DeleteDbModal({
  db,
  allDbs,
  nodes,
  onDone,
}: DeleteDbModalProps) {
  const [step, setStep] = useState<Step>('confirm');
  const [typedName, setTypedName] = useState('');
  const [mismatchError, setMismatchError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState('');

  const handleConfirm = async () => {
    if (typedName.trim() !== db.name) {
      setMismatchError(`Debes escribir exactamente "${db.name}" para confirmar.`);
      return;
    }

    setStep('deleting');
    setLogs([]);
    setErrorMsg('');

    try {
      await deleteClusterDB(db, allDbs, nodes, (msg) =>
        setLogs((prev) => [...prev.slice(-8), msg]),
      );
      setStep('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  useInput(
    (input, key) => {
      if (step === 'done' || step === 'error') {
        if (key.escape || key.return || input.toLowerCase() === 'q') {
          onDone(step === 'done');
        }
      }
    },
    { isActive: step === 'done' || step === 'error' },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="red"
      paddingX={2}
      paddingY={1}
      width="82%"
      backgroundColor="black"
      gap={1}
    >
      <Text bold color="red">
        ⚠ Eliminar Base de Datos · {db.name}
      </Text>

      {step === 'confirm' && (
        <Box flexDirection="column" gap={1}>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="red"
            paddingX={1}
          >
            <Text color="red" bold>
              Acción destructiva e irreversible (con local-path los datos se borran permanentemente).
            </Text>
            <Text>
              <Text dimColor>Cluster: </Text>
              <Text bold>{db.name}</Text> <Text dimColor>(ns: {db.namespace})</Text>
            </Text>
            <Text>
              <Text dimColor>Primario: </Text>
              <Text>
                {db.currentPrimary || '—'} @ {db.primaryNode}
              </Text>
            </Text>
            <Text>
              <Text dimColor>PVCs a eliminar: </Text>
              <Text color="yellow">{db.pvcs.join(', ') || 'ninguno'}</Text>
            </Text>
            <Text>
              <Text dimColor>Label a limpiar: </Text>
              <Text>{db.labelId?.display ?? 'ninguno'}</Text>
            </Text>
          </Box>

          <Text>
            Escribe <Text bold color="red">{db.name}</Text> y pulsa{' '}
            <Text bold>Enter</Text> para eliminar:
          </Text>

          <TextInputField
            value={typedName}
            onChange={(val) => {
              setTypedName(val);
              setMismatchError(null);
            }}
            onSubmit={() => void handleConfirm()}
            onCancel={() => onDone(false)}
            placeholder={db.name}
            isActive
          />

          {mismatchError ? <Text color="red">{mismatchError}</Text> : null}
          <Text dimColor>[Enter] Confirmar eliminación · [Esc] Cancelar</Text>
        </Box>
      )}

      {step === 'deleting' && (
        <Box flexDirection="column" gap={1}>
          <Box gap={1}>
            <Spinner color="red" />
            <Text bold color="red">
              Eliminando &quot;{db.name}&quot; y limpiando recursos...
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
            ✔ Base de datos &quot;{db.name}&quot; eliminada y recursos limpiados
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
            ✖ Error al eliminar la base de datos
          </Text>
          <Text color="red">{errorMsg}</Text>
          <Text dimColor>[Enter / Esc / Q] Cerrar</Text>
        </Box>
      )}
    </Box>
  );
}
