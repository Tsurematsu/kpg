import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from './Spinner.js';
import { listClusterDBs, setClusterPowerState } from '../services/cnpg.js';
import type { ClusterDBInfo } from '../types/k8s.js';

interface PowerDbModalProps {
  db: ClusterDBInfo;
  onDone: (refresh: boolean) => void;
}

type Stage = 'confirm' | 'running' | 'done' | 'error';

export function PowerDbModal({ db, onDone }: PowerDbModalProps) {
  const target: 'on' | 'off' = db.hibernated ? 'on' : 'off';
  const [stage, setStage] = useState<Stage>('confirm');
  const [logs, setLogs] = useState<string[]>([]);
  const [currentPhase, setCurrentPhase] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const cancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const execute = async () => {
    setStage('running');
    setErrorMsg('');
    setLogs([]);

    try {
      await setClusterPowerState(db, target, (msg) => {
        if (!cancelledRef.current) {
          setLogs((prev) => [...prev.slice(-6), msg]);
        }
      });

      if (cancelledRef.current) return;

      setLogs((prev) => [
        ...prev.slice(-6),
        target === 'off'
          ? 'Esperando a que los pods de PostgreSQL se detengan ordenadamente...'
          : 'Esperando a que la base de datos vuelva a estado Healthy...',
      ]);

      // Poll up to 60s (24 * 2.5s)
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        if (cancelledRef.current) return;

        try {
          const dbs = await listClusterDBs();
          if (cancelledRef.current) return;
          const fresh = dbs.find(
            (d) => d.name === db.name && d.namespace === db.namespace,
          );
          if (fresh) {
            setCurrentPhase(fresh.phase);
            if (
              target === 'off' &&
              fresh.powerState === 'hibernated' &&
              fresh.pods.length === 0
            ) {
              setLogs((prev) => [
                ...prev.slice(-6),
                `✔ "${db.name}" apagada (hibernada). PVCs y datos conservados (${fresh.pvcs.length} PVC).`,
              ]);
              setStage('done');
              return;
            }
            if (target === 'on' && fresh.healthy && fresh.readyInstances >= 1) {
              setLogs((prev) => [
                ...prev.slice(-6),
                `✔ "${db.name}" encendida y Healthy (${fresh.currentPrimary} @ ${fresh.primaryNode}).`,
              ]);
              setStage('done');
              return;
            }
          }
        } catch {
          // continue polling
        }
      }

      if (!cancelledRef.current) {
        setLogs((prev) => [
          ...prev.slice(-6),
          'Orden aplicada. Puedes volver al menú principal para seguir viendo su progreso en vivo.',
        ]);
        setStage('done');
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStage('error');
      }
    }
  };

  useInput((input, key) => {
    const lower = input.toLowerCase();

    if (stage === 'confirm') {
      if (key.escape || lower === 'q' || lower === 'n') {
        onDone(false);
        return;
      }
      if (key.return || lower === 'p' || lower === 's' || lower === 'y') {
        void execute();
      }
      return;
    }

    if (stage === 'running') {
      if (key.escape) {
        cancelledRef.current = true;
        onDone(true);
      }
      return;
    }

    if (stage === 'done' || stage === 'error') {
      if (key.return || key.escape || lower === 'q') {
        onDone(true);
      }
    }
  });

  const accentColor =
    stage === 'error'
      ? 'red'
      : stage === 'done'
        ? 'green'
        : target === 'on'
          ? 'green'
          : 'yellow';

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={accentColor}
      backgroundColor="black"
      paddingX={2}
      paddingY={1}
      width={74}
      gap={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={accentColor}>
          {target === 'off'
            ? `⚡ Apagar (hibernar) "${db.name}"`
            : `⚡ Encender "${db.name}"`}
        </Text>
        <Text dimColor>[Esc] {stage === 'running' ? 'Volver' : 'Cancelar'}</Text>
      </Box>

      {stage === 'confirm' && (
        <Box flexDirection="column" gap={1}>
          {target === 'off' ? (
            <>
              <Text>
                Se detendrán los pods de PostgreSQL de{' '}
                <Text bold color="white">
                  {db.name}
                </Text>{' '}
                mediante hibernación declarativa de CloudNativePG (
                <Text color="yellow">cnpg.io/hibernation=on</Text>).
              </Text>
              <Text dimColor>
                • Los datos, {db.pvcs.length} PVC(s), labels de agentes y Service NodePort se conservan intactos.
              </Text>
              <Text dimColor>
                • Las aplicaciones no podrán conectarse hasta que la vuelvas a encender con (p).
              </Text>
            </>
          ) : (
            <>
              <Text>
                Se reactivará{' '}
                <Text bold color="white">
                  {db.name}
                </Text>{' '}
                desactivando la hibernación (
                <Text color="green">cnpg.io/hibernation=off</Text>).
              </Text>
              <Text dimColor>
                • CNPG levantará {db.instances} instancia(s) usando los {db.pvcs.length} PVC(s) existentes y el label{' '}
                {db.labelId?.display ?? 'actual'}.
              </Text>
            </>
          )}

          <Box marginTop={1} gap={2}>
            <Text bold color={target === 'off' ? 'yellow' : 'green'}>
              [Enter / p] {target === 'off' ? 'Sí, apagar BD' : 'Sí, encender BD'}
            </Text>
            <Text dimColor>[Esc] Cancelar</Text>
          </Box>
        </Box>
      )}

      {stage === 'running' && (
        <Box flexDirection="column" gap={1}>
          <Box gap={1}>
            <Spinner color={accentColor} />
            <Text bold color={accentColor}>
              {target === 'off'
                ? 'Apagando base de datos...'
                : 'Encendiendo base de datos...'}
            </Text>
          </Box>
          {currentPhase ? (
            <Text dimColor>Estado actual: {currentPhase}</Text>
          ) : null}
          <Box flexDirection="column">
            {logs.map((line, i) => (
              <Text key={`${i}-${line}`} dimColor>
                › {line}
              </Text>
            ))}
          </Box>
          <Text dimColor>
            Puedes pulsar [Esc] para volver al menú principal mientras termina en segundo plano.
          </Text>
        </Box>
      )}

      {stage === 'done' && (
        <Box flexDirection="column" gap={1}>
          {logs.map((line, i) => (
            <Text key={`${i}-${line}`} color={line.startsWith('✔') ? 'green' : undefined}>
              {line}
            </Text>
          ))}
          <Text color="green" bold>
            Pulsa [Enter / Esc] para volver al menú principal.
          </Text>
        </Box>
      )}

      {stage === 'error' && (
        <Box flexDirection="column" gap={1}>
          <Text color="red" bold>
            ✖ {errorMsg}
          </Text>
          <Text dimColor>Pulsa [Enter / Esc] para cerrar.</Text>
        </Box>
      )}
    </Box>
  );
}
