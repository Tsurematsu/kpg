import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { FooterBar } from './FooterBar.js';
import { Spinner } from './Spinner.js';
import { TextInputField } from './TextInputField.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  buildDefaultBackupPath,
  formatBytes,
  runLocalBackup,
  type LocalBackupResult,
} from '../services/backup.js';
import type { ClusterDBInfo } from '../types/k8s.js';

interface BackupScreenProps {
  db: ClusterDBInfo;
  onClose: () => void;
}

interface BackupMenuOption {
  id: 'local_dump';
  title: string;
  description: string;
}

// Extensible menu: add new backup destinations/methods here in the future
const BACKUP_MENU_OPTIONS: BackupMenuOption[] = [
  {
    id: 'local_dump',
    title: 'Backup local en esta máquina (pg_dump → .sql)',
    description:
      'Descarga el respaldo de la BD directamente al equipo con la conexión kubectl actual (sin port-forward).',
  },
];

type Stage = 'menu' | 'local_path' | 'running' | 'done' | 'error';

export function BackupScreen({ db, onClose }: BackupScreenProps) {
  const { rows: termHeight } = useTerminalSize();

  const [stage, setStage] = useState<Stage>('menu');
  const [menuIdx, setMenuIdx] = useState(0);
  const [destPath, setDestPath] = useState(() => buildDefaultBackupPath(db.name));
  const [bytesWritten, setBytesWritten] = useState(0);
  const [result, setResult] = useState<LocalBackupResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const startLocalBackup = async () => {
    const trimmed = destPath.trim();
    if (!trimmed) return;

    setStage('running');
    setBytesWritten(0);
    setErrorMsg('');
    setResult(null);

    try {
      const res = await runLocalBackup(db, trimmed, (bytes) => {
        setBytesWritten(bytes);
      });
      setResult(res);
      setStage('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  };

  useInput(
    (input, key) => {
      const lower = input.toLowerCase();

      if (stage === 'running') return;

      if (stage === 'menu') {
        if (key.escape || lower === 'q') {
          onClose();
          return;
        }
        if (key.upArrow || lower === 'k') {
          setMenuIdx((prev) =>
            prev > 0 ? prev - 1 : BACKUP_MENU_OPTIONS.length - 1,
          );
        } else if (key.downArrow || lower === 'j') {
          setMenuIdx((prev) =>
            prev < BACKUP_MENU_OPTIONS.length - 1 ? prev + 1 : 0,
          );
        } else if (key.return) {
          const chosen = BACKUP_MENU_OPTIONS[menuIdx];
          if (chosen?.id === 'local_dump') {
            setDestPath(buildDefaultBackupPath(db.name));
            setStage('local_path');
          }
        }
        return;
      }

      if (stage === 'done' || stage === 'error') {
        if (key.escape) {
          setStage('menu');
          return;
        }
        if (key.return || lower === 'q') {
          onClose();
        }
      }
    },
    { isActive: stage !== 'local_path' },
  );

  return (
    <Box
      flexDirection="column"
      height={Math.max(20, termHeight)}
      justifyContent="space-between"
    >
      {/* Top Banner */}
      <Box
        borderStyle="round"
        borderColor="magenta"
        paddingX={2}
        justifyContent="space-between"
      >
        <Box gap={1}>
          <Text bold color="magenta">
            💾 Backup
          </Text>
          <Text dimColor>·</Text>
          <Text bold color="white">
            {db.name}
          </Text>
          <Text dimColor>
            (primario: {db.currentPrimary || '—'} @ {db.primaryNode})
          </Text>
        </Box>
        <Text dimColor>Namespace: {db.namespace}</Text>
      </Box>

      {/* Content */}
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="single"
        borderColor="gray"
        paddingX={2}
        paddingY={1}
        gap={1}
      >
        {stage === 'menu' && (
          <Box flexDirection="column" gap={1}>
            <Text bold>Opciones de backup para &quot;{db.name}&quot;:</Text>
            <Box flexDirection="column" gap={0}>
              {BACKUP_MENU_OPTIONS.map((opt, idx) => {
                const selected = idx === menuIdx;
                return (
                  <Box
                    key={opt.id}
                    flexDirection="column"
                    borderStyle={selected ? 'round' : 'single'}
                    borderColor={selected ? 'magenta' : 'gray'}
                    paddingX={1}
                  >
                    <Box gap={1}>
                      <Text color={selected ? 'magenta' : 'gray'} bold={selected}>
                        {selected ? '❯' : ' '}
                      </Text>
                      <Text bold color={selected ? 'magenta' : 'white'}>
                        {opt.title}
                      </Text>
                    </Box>
                    <Box marginLeft={2}>
                      <Text dimColor>{opt.description}</Text>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {stage === 'local_path' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="magenta">
              Backup local en esta máquina
            </Text>
            <Text dimColor>
              Se ejecutará <Text color="white">pg_dump -U postgres -d app --clean --if-exists</Text> desde{' '}
              <Text color="green">{db.currentPrimary}</Text> y se guardará en:
            </Text>
            <TextInputField
              value={destPath}
              onChange={setDestPath}
              onSubmit={() => void startLocalBackup()}
              onCancel={() => setStage('menu')}
              maxLength={240}
              isActive
            />
            <Text dimColor>
              [Enter] Iniciar descarga del backup · [Esc] Volver al menú de backup
            </Text>
          </Box>
        )}

        {stage === 'running' && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="magenta"
            paddingX={2}
            paddingY={1}
            gap={1}
          >
            <Box gap={1}>
              <Spinner color="magenta" />
              <Text bold color="magenta">
                Generando y descargando backup de &quot;{db.name}&quot;...
              </Text>
            </Box>
            <Text>
              <Text dimColor>Destino: </Text>
              <Text>{destPath}</Text>
            </Text>
            <Text>
              <Text dimColor>Copiado: </Text>
              <Text bold color="cyan">
                {formatBytes(bytesWritten)}
              </Text>
            </Text>
          </Box>
        )}

        {stage === 'done' && result && (
          <Box
            flexDirection="column"
            borderStyle="double"
            borderColor="green"
            paddingX={2}
            paddingY={1}
            gap={0}
          >
            <Text bold color="green">
              ✔ Backup local completado en {result.durationSec}s
            </Text>
            <Text>
              <Text dimColor>Archivo: </Text>
              <Text bold color="cyan">
                {result.filePath}
              </Text>
            </Text>
            <Text>
              <Text dimColor>Tamaño: </Text>
              <Text bold>{formatBytes(result.bytesWritten)}</Text>
            </Text>
          </Box>
        )}

        {stage === 'error' && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="red"
            paddingX={2}
            paddingY={1}
            gap={1}
          >
            <Text bold color="red">
              ✖ Error al generar el backup
            </Text>
            <Text color="red">{errorMsg}</Text>
          </Box>
        )}
      </Box>

      {/* Bottom Bar */}
      <FooterBar
        items={
          stage === 'menu'
            ? [
                { key: '↑/↓', label: 'Elegir' },
                { key: 'Enter', label: 'Seleccionar', accent: 'green' },
                { key: 'Esc/Q', label: 'Volver al menú principal', accent: 'red' },
              ]
            : stage === 'local_path'
              ? [
                  { key: 'Enter', label: 'Guardar backup aquí', accent: 'green' },
                  { key: 'Esc', label: 'Volver' },
                ]
              : stage === 'running'
                ? [{ key: '...', label: 'Descargando backup...', accent: 'magenta' }]
                : [
                    { key: 'Enter/Q', label: 'Volver al menú principal', accent: 'green' },
                    { key: 'Esc', label: 'Menú de backup' },
                  ]
        }
      />
    </Box>
  );
}
