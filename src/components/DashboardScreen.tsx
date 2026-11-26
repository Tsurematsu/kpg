import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Header } from './Header.js';
import { FooterBar } from './FooterBar.js';
import { LabelsModal } from './LabelsModal.js';
import { CreateDbModal } from './CreateDbModal.js';
import { ReplicasModal } from './ReplicasModal.js';
import { DeleteDbModal } from './DeleteDbModal.js';
import { PowerDbModal } from './PowerDbModal.js';
import { MoveDbScreen } from './MoveDbScreen.js';
import { AccessScreen } from './AccessScreen.js';
import { BackupScreen } from './BackupScreen.js';
import { EnvScreen } from './EnvScreen.js';
import { PlaceholderModal } from './PlaceholderModal.js';
import { Spinner } from './Spinner.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { getAgentNodes, getClusterSnapshot } from '../services/cnpg.js';
import type {
  ClusterDBInfo,
  ClusterSnapshot,
  CnpgPluginStatus,
  KubectlConnectionStatus,
  OperatorStatus,
} from '../types/k8s.js';

interface DashboardScreenProps {
  kubectl: KubectlConnectionStatus;
  plugin: CnpgPluginStatus;
  initialOperator: OperatorStatus;
  onExit: () => void;
}

type ActiveModal =
  | null
  | { type: 'labels' }
  | { type: 'create' }
  | { type: 'replicas'; db: ClusterDBInfo }
  | { type: 'power'; db: ClusterDBInfo }
  | { type: 'delete'; db: ClusterDBInfo }
  | { type: 'notice'; title: string; message: string; accent?: string };

type ActiveScreen =
  | null
  | { type: 'move'; db: ClusterDBInfo }
  | { type: 'access'; db: ClusterDBInfo }
  | { type: 'env'; db: ClusterDBInfo }
  | { type: 'backup'; db: ClusterDBInfo };

const REFRESH_INTERVAL_MS = 5000;

function padCell(value: string, width: number): string {
  if (value.length >= width) {
    return width > 1 ? `${value.slice(0, width - 1)}…` : value.slice(0, width);
  }
  return value.padEnd(width, ' ');
}

function formatReplicasSummary(db: ClusterDBInfo): string {
  const desiredReplicas = Math.max(0, db.instances - 1);
  if (desiredReplicas === 0 && db.replicas.length === 0) {
    return '0 (sin réplicas)';
  }
  if (db.replicas.length === 0) {
    return `${desiredReplicas} (creando...)`;
  }
  const agents = db.replicas.map((r) => r.nodeName).join(', ');
  return `${db.replicas.length}/${desiredReplicas}: ${agents}`;
}

export function DashboardScreen({
  kubectl,
  plugin,
  initialOperator,
  onExit,
}: DashboardScreenProps) {
  const { rows: termHeight, columns: termWidth } = useTerminalSize();

  const [snapshot, setSnapshot] = useState<ClusterSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [activeScreen, setActiveScreen] = useState<ActiveScreen>(null);

  const fetchData = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    setRefreshing(true);
    try {
      const data = await getClusterSnapshot();
      setSnapshot(data);
      setError(null);
      setSelectedIndex((prev) =>
        data.dbs.length === 0 ? 0 : Math.min(prev, data.dbs.length - 1),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchData(true);
  }, [fetchData]);

  useEffect(() => {
    if (activeModal !== null || activeScreen !== null) return;
    const timer = setInterval(() => {
      void fetchData(false);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchData, activeModal, activeScreen]);

  const dbs = snapshot?.dbs ?? [];
  const nodes = snapshot?.nodes ?? [];
  const agents = getAgentNodes(nodes);
  const operator = snapshot?.operator ?? initialOperator;
  const selectedDb = dbs[selectedIndex] ?? null;

  useInput(
    (input, key) => {
      if (activeModal !== null || activeScreen !== null) return;

      const lower = input.toLowerCase();

      if (key.escape || lower === 'q') {
        onExit();
        return;
      }

      if (key.upArrow || lower === 'k') {
        setSelectedIndex((prev) =>
          dbs.length === 0 ? 0 : prev > 0 ? prev - 1 : dbs.length - 1,
        );
        return;
      }

      if (key.downArrow || lower === 'j') {
        setSelectedIndex((prev) =>
          dbs.length === 0 ? 0 : prev < dbs.length - 1 ? prev + 1 : 0,
        );
        return;
      }

      if (lower === 'u') {
        void fetchData(false);
        return;
      }

      if (lower === 'l') {
        setActiveModal({ type: 'labels' });
        return;
      }

      if (lower === 'n') {
        setActiveModal({ type: 'create' });
        return;
      }

      if (!selectedDb) return;

      if (lower === 'p') {
        setActiveModal({ type: 'power', db: selectedDb });
        return;
      }

      if (lower === 'm') {
        if (selectedDb.hibernated) {
          setActiveModal({
            type: 'notice',
            title: 'Traslado bloqueado — La BD está apagada',
            message: `La BD "${selectedDb.name}" está apagada (hibernada). Enciéndela primero con la tecla (p) y espera a que esté Healthy antes de trasladarla.`,
            accent: 'yellow',
          });
          return;
        }
        if (selectedDb.instances > 1 || selectedDb.replicas.length > 0) {
          setActiveModal({
            type: 'notice',
            title: 'Traslado bloqueado — La BD tiene réplicas activas',
            message: `La BD "${selectedDb.name}" tiene actualmente ${selectedDb.instances} instancias (${Math.max(0, selectedDb.instances - 1)} réplicas). Para poder trasladarla, primero debes reducir sus réplicas a 0 usando la tecla (r).`,
            accent: 'red',
          });
          return;
        }
        if (!selectedDb.healthy || selectedDb.readyInstances !== 1) {
          setActiveModal({
            type: 'notice',
            title: 'Traslado bloqueado — La BD no está en estado sano',
            message: `Estado actual de "${selectedDb.name}": ${selectedDb.phase} (${selectedDb.readyInstances}/${selectedDb.instances} listas). Espera a que esté Healthy antes de trasladar.`,
            accent: 'yellow',
          });
          return;
        }
        if (!selectedDb.labelId) {
          setActiveModal({
            type: 'notice',
            title: 'Traslado bloqueado — Sin nodeSelector / Label ID',
            message: `La BD "${selectedDb.name}" no tiene un nodeSelector configurado para controlar en qué agente corre.`,
            accent: 'red',
          });
          return;
        }
        setActiveScreen({ type: 'move', db: selectedDb });
        return;
      }

      if (lower === 'r') {
        if (selectedDb.hibernated) {
          setActiveModal({
            type: 'notice',
            title: 'Ajuste de réplicas bloqueado — La BD está apagada',
            message: `La BD "${selectedDb.name}" está apagada (hibernada). Enciéndela primero con la tecla (p) antes de ajustar sus réplicas.`,
            accent: 'yellow',
          });
          return;
        }
        setActiveModal({ type: 'replicas', db: selectedDb });
        return;
      }

      if (lower === 'x') {
        setActiveModal({ type: 'delete', db: selectedDb });
        return;
      }

      if (lower === 'a') {
        setActiveScreen({ type: 'access', db: selectedDb });
        return;
      }

      if (lower === 'v') {
        setActiveScreen({ type: 'env', db: selectedDb });
        return;
      }

      if (lower === 'b') {
        if (selectedDb.hibernated) {
          setActiveModal({
            type: 'notice',
            title: 'Backup bloqueado — La BD está apagada',
            message: `La BD "${selectedDb.name}" está apagada (hibernada). Enciéndela primero con la tecla (p) para poder ejecutar pg_dump.`,
            accent: 'yellow',
          });
          return;
        }
        setActiveScreen({ type: 'backup', db: selectedDb });
      }
    },
    { isActive: activeModal === null && activeScreen === null },
  );

  if (activeScreen?.type === 'move') {
    return (
      <MoveDbScreen
        db={activeScreen.db}
        nodes={nodes}
        onClose={(shouldRefresh) => {
          setActiveScreen(null);
          if (shouldRefresh) void fetchData(false);
        }}
      />
    );
  }

  if (activeScreen?.type === 'access') {
    return (
      <AccessScreen
        db={activeScreen.db}
        nodes={nodes}
        serverUrl={kubectl.serverUrl}
        onClose={(shouldRefresh) => {
          setActiveScreen(null);
          if (shouldRefresh) void fetchData(false);
        }}
      />
    );
  }

  if (activeScreen?.type === 'env') {
    return (
      <EnvScreen
        db={activeScreen.db}
        nodes={nodes}
        serverUrl={kubectl.serverUrl}
        onClose={() => setActiveScreen(null)}
      />
    );
  }

  if (activeScreen?.type === 'backup') {
    return (
      <BackupScreen
        db={activeScreen.db}
        onClose={() => setActiveScreen(null)}
      />
    );
  }

  const hasDbs = dbs.length > 0;

  return (
    <Box
      flexDirection="column"
      height={Math.max(18, termHeight)}
      justifyContent="space-between"
      position="relative"
    >
      {/* Top Header */}
      <Header
        kubectl={kubectl}
        plugin={plugin}
        operator={operator}
        refreshing={refreshing}
        lastUpdated={snapshot?.fetchedAt ?? null}
      />

      {/* Main Content Area */}
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        paddingY={0}
        marginY={0}
      >
        {/* Summary strip */}
        <Box justifyContent="space-between" marginBottom={1}>
          <Text bold color="white">
            Bases de Datos ({dbs.length})
          </Text>
          <Box gap={2}>
            <Text dimColor>
              Agentes Ready:{' '}
              <Text color="green">
                {agents.filter((a) => a.ready).length}/{agents.length}
              </Text>
            </Text>
            {agents.length > 0 ? (
              <Text dimColor>[{agents.map((a) => a.name).join(', ')}]</Text>
            ) : null}
          </Box>
        </Box>

        {error ? (
          <Box
            borderStyle="round"
            borderColor="red"
            paddingX={1}
            marginBottom={1}
          >
            <Text color="red">Error consultando cluster: {error}</Text>
          </Box>
        ) : null}

        {loading ? (
          <Box gap={1} paddingY={2} justifyContent="center">
            <Spinner />
            <Text>Cargando bases de datos y nodos...</Text>
          </Box>
        ) : dbs.length === 0 ? (
          <Box
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            flexGrow={1}
            gap={1}
          >
            <Text bold color="yellow">
              No hay bases de datos CloudNativePG en el cluster
            </Text>
            <Text dimColor>
              Presiona <Text color="cyan" bold>(n)</Text> para crear una nueva BD o{' '}
              <Text color="cyan" bold>(l)</Text> para inspeccionar los agentes y sus labels.
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column" flexGrow={1}>
            {/* Table Header */}
            <Box>
              <Text bold dimColor>
                {'  '}
                {padCell('BASE DE DATOS', 20)}
                {padCell('LABEL ID', 18)}
                {padCell('ESTADO', 16)}
                {padCell('PRIMARIO (AGENTE)', 26)}
                {'RÉPLICAS (AGENTES)'}
              </Text>
            </Box>

            <Box marginBottom={0}>
              <Text dimColor>{'─'.repeat(Math.max(40, termWidth - 6))}</Text>
            </Box>

            {/* Table Rows */}
            {dbs.map((db, idx) => {
              const isSelected = idx === selectedIndex;
              const dbDisplay =
                db.namespace === 'default'
                  ? db.name
                  : `${db.namespace}/${db.name}`;
              const labelDisplay = db.labelId?.display ?? '—';
              const statusShort =
                db.powerState === 'hibernated'
                  ? '○ Apagada'
                  : db.powerState === 'hibernating'
                    ? '◐ Apagando...'
                    : db.powerState === 'waking'
                      ? '◐ Encendiendo'
                      : db.healthy
                        ? '● Healthy'
                        : `◐ ${db.phase.slice(0, 12)}`;
              const statusColor = isSelected
                ? 'cyan'
                : db.powerState === 'hibernated'
                  ? 'magenta'
                  : db.healthy
                    ? 'green'
                    : 'yellow';
              const primaryDisplay =
                db.powerState === 'hibernated'
                  ? '(apagada)'
                  : db.currentPrimary
                    ? `${db.currentPrimary} @ ${db.primaryNode}`
                    : db.primaryNode;
              const replicasDisplay =
                db.powerState === 'hibernated'
                  ? `0 (${db.pvcs.length} PVC guardado${db.pvcs.length === 1 ? '' : 's'})`
                  : formatReplicasSummary(db);

              return (
                <Box key={`${db.namespace}/${db.name}`}>
                  <Text
                    color={isSelected ? 'cyan' : undefined}
                    bold={isSelected}
                    inverse={isSelected}
                  >
                    {isSelected ? '❯ ' : '  '}
                    {padCell(dbDisplay, 20)}
                    {padCell(labelDisplay, 18)}
                  </Text>
                  <Text
                    color={statusColor}
                    bold={isSelected}
                    inverse={isSelected}
                  >
                    {padCell(statusShort, 16)}
                  </Text>
                  <Text
                    color={isSelected ? 'cyan' : undefined}
                    bold={isSelected}
                    inverse={isSelected}
                  >
                    {padCell(primaryDisplay, 26)}
                    {replicasDisplay}
                  </Text>
                </Box>
              );
            })}

            {/* Selected DB detail bar */}
            {selectedDb ? (
              <Box
                marginTop={1}
                borderStyle="round"
                borderColor="gray"
                paddingX={1}
                justifyContent="space-between"
              >
                <Text dimColor>
                  <Text color="white" bold>
                    {selectedDb.name}
                  </Text>
                  {' · '}ns: {selectedDb.namespace}
                  {' · '}Instancias: {selectedDb.readyInstances}/{selectedDb.instances}
                  {' · '}Storage: {selectedDb.storageSize || '?'} ({selectedDb.storageClass || 'default'})
                  {' · '}PVCs: {selectedDb.pvcs.length}
                </Text>
                <Text dimColor>
                  {selectedDb.imageName.split('/').pop() || ''}
                </Text>
              </Box>
            ) : null}
          </Box>
        )}
      </Box>

      {/* Bottom Shortcut Bar */}
      <FooterBar
        items={[
          { key: 'n', label: 'Nueva BD', accent: 'green' },
          {
            key: 'p',
            label: selectedDb?.hibernated ? 'Encender' : 'Apagar',
            disabled: !hasDbs,
            accent: selectedDb?.hibernated ? 'green' : 'yellow',
          },
          { key: 'm', label: 'Mover', disabled: !hasDbs, accent: 'yellow' },
          { key: 'r', label: 'Réplicas', disabled: !hasDbs },
          { key: 'a', label: 'Acceso', disabled: !hasDbs },
          { key: 'v', label: 'Env', disabled: !hasDbs, accent: 'cyan' },
          { key: 'b', label: 'Backup', disabled: !hasDbs },
          { key: 'l', label: 'Labels', accent: 'magenta' },
          { key: 'x', label: 'Eliminar', disabled: !hasDbs, accent: 'red' },
          { key: 'u', label: 'Refrescar' },
          { key: 'Q/Esc', label: 'Salir', accent: 'red' },
        ]}
      />

      {/* Floating Modal Layer */}
      {activeModal !== null && (
        <Box
          position="absolute"
          width="100%"
          height="100%"
          alignItems="center"
          justifyContent="center"
        >
          {activeModal.type === 'labels' && (
            <LabelsModal
              nodes={nodes}
              selectedDb={selectedDb}
              onClose={() => setActiveModal(null)}
            />
          )}
          {activeModal.type === 'create' && (
            <CreateDbModal
              nodes={nodes}
              existingDbs={dbs}
              onDone={(shouldRefresh) => {
                setActiveModal(null);
                if (shouldRefresh) void fetchData(false);
              }}
            />
          )}
          {activeModal.type === 'replicas' && (
            <ReplicasModal
              db={activeModal.db}
              nodes={nodes}
              allDbs={dbs}
              onDone={(shouldRefresh) => {
                setActiveModal(null);
                if (shouldRefresh) void fetchData(false);
              }}
            />
          )}
          {activeModal.type === 'power' && (
            <PowerDbModal
              db={activeModal.db}
              onDone={(shouldRefresh) => {
                setActiveModal(null);
                if (shouldRefresh) void fetchData(false);
              }}
            />
          )}
          {activeModal.type === 'delete' && (
            <DeleteDbModal
              db={activeModal.db}
              allDbs={dbs}
              nodes={nodes}
              onDone={(shouldRefresh) => {
                setActiveModal(null);
                if (shouldRefresh) void fetchData(false);
              }}
            />
          )}
          {activeModal.type === 'notice' && (
            <PlaceholderModal
              title={activeModal.title}
              message={activeModal.message}
              accent={activeModal.accent}
              onClose={() => setActiveModal(null)}
            />
          )}
        </Box>
      )}
    </Box>
  );
}
