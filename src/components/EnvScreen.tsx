import path from 'node:path';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { FooterBar } from './FooterBar.js';
import { Spinner } from './Spinner.js';
import { TextInputField } from './TextInputField.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  createOrGetNodePortAccess,
  extractHostFromServerUrl,
  getNetworkAccess,
  getNodePortAccess,
  getTlsPolicy,
  listNodePortUserCredentials,
  type NetworkAccessInfo,
  type NodePortInfo,
  type NodePortUserCredential,
  type TlsPolicyMode,
} from '../services/access.js';
import {
  buildDefaultEnvFilename,
  fileExists,
  generateEnvContent,
  getHomeDir,
  getLaunchDir,
  listSubdirectories,
  writeEnvFile,
  type DirectoryEntry,
  type EnvConnectionMode,
  type EnvWriteMode,
} from '../services/env.js';
import type { ClusterDBInfo, NodeInfo } from '../types/k8s.js';

interface EnvScreenProps {
  db: ClusterDBInfo;
  nodes: NodeInfo[];
  serverUrl: string;
  onClose: () => void;
}

type Stage =
  | 'menu'
  | 'select_users'
  | 'select_dir'
  | 'edit_filename'
  | 'edit_custom_path'
  | 'preview_save'
  | 'preview_only'
  | 'done';

const ENV_MENU_OPTIONS: Array<{
  id: 'generate_file' | 'preview_only';
  title: string;
  description: string;
}> = [
  {
    id: 'generate_file',
    title: 'Generar y guardar archivo .env',
    description:
      'Elige uno o más usuarios de esta BD y guarda el .env en el directorio actual o mediante el selector de carpetas.',
  },
  {
    id: 'preview_only',
    title: 'Previsualizar variables .env en pantalla',
    description:
      'Genera y muestra el bloque .env para uno o más usuarios (con opción rápida de guardarlo a disco).',
  },
];

function padCell(value: string, width: number): string {
  if (value.length >= width) {
    return width > 1 ? `${value.slice(0, width - 1)}…` : value.slice(0, width);
  }
  return value.padEnd(width, ' ');
}

export function EnvScreen({
  db,
  nodes,
  serverUrl,
  onClose,
}: EnvScreenProps) {
  const { rows: termHeight } = useTerminalSize();

  const hostIp = useMemo(() => {
    const fallbackNode =
      nodes.find((n) => n.name === db.primaryNode) ??
      nodes.find((n) => n.isControlPlane) ??
      nodes[0];
    return extractHostFromServerUrl(
      serverUrl,
      fallbackNode?.internalIp ?? '127.0.0.1',
    );
  }, [serverUrl, nodes, db.primaryNode]);

  const [stage, setStage] = useState<Stage>('menu');
  const [menuIdx, setMenuIdx] = useState(0);
  const [flowTarget, setFlowTarget] = useState<'file' | 'preview'>('file');

  // Loaded DB credentials + NodePort + TLS
  const [loading, setLoading] = useState(false);
  const [creatingNp, setCreatingNp] = useState(false);
  const [credentials, setCredentials] = useState<NodePortUserCredential[]>([]);
  const [nodePortInfo, setNodePortInfo] = useState<NodePortInfo | null>(null);
  const [networkAccess, setNetworkAccess] = useState<NetworkAccessInfo | null>(
    null,
  );
  const [tlsMode, setTlsMode] = useState<TlsPolicyMode>('optional');
  const [connectionMode, setConnectionMode] =
    useState<EnvConnectionMode>('nodeport');

  // User multi-select
  const [selectedUsernames, setSelectedUsernames] = useState<string[]>([]);
  const [userCursor, setUserCursor] = useState(0);

  // Directory browser & path
  const [currentDir, setCurrentDir] = useState(() => getLaunchDir());
  const [filename, setFilename] = useState(() =>
    buildDefaultEnvFilename(db.name),
  );
  const [customPathInput, setCustomPathInput] = useState('');
  const [showHiddenDirs, setShowHiddenDirs] = useState(false);
  const [dirEntries, setDirEntries] = useState<DirectoryEntry[]>([]);
  const [dirCursor, setDirCursor] = useState(0); // 0 = "Use current directory", 1..n = dirEntries
  const [dirError, setDirError] = useState<string | null>(null);

  // Preview & save
  const [showPasswords, setShowPasswords] = useState(false);
  const [writeMode, setWriteMode] = useState<EnvWriteMode>('overwrite');
  const [savedResult, setSavedResult] = useState<{
    filePath: string;
    bytesWritten: number;
    userCount: number;
    mode: EnvWriteMode;
  } | null>(null);

  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadEnvContext = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [creds, np, netAccess, tls] = await Promise.all([
        listNodePortUserCredentials(db),
        getNodePortAccess(db, hostIp),
        getNetworkAccess(db, hostIp),
        getTlsPolicy(db).catch(() => 'optional' as TlsPolicyMode),
      ]);
      setCredentials(creds);
      setNodePortInfo(np);
      setNetworkAccess(netAccess);
      setTlsMode(tls);
      setConnectionMode(np ? 'nodeport' : 'internal');
      setSelectedUsernames((prev) => {
        const validPrev = prev.filter((name) =>
          creds.some((c) => c.username === name),
        );
        if (validPrev.length > 0) return validPrev;
        return creds.length > 0 ? [creds[0].username] : [];
      });
      setUserCursor((prev) =>
        creds.length === 0 ? 0 : Math.min(prev, creds.length - 1),
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [db, hostIp]);

  const refreshDirectory = useCallback(
    (dir: string, includeHidden: boolean) => {
      const res = listSubdirectories(dir, includeHidden);
      setCurrentDir(res.currentDir);
      setDirEntries(res.entries);
      setDirCursor(0);
      setDirError(res.error ?? null);
    },
    [],
  );

  useEffect(() => {
    if (stage === 'select_dir') {
      refreshDirectory(currentDir, showHiddenDirs);
    }
  }, [stage, currentDir, showHiddenDirs, refreshDirectory]);

  const selectedUsers = useMemo(
    () => credentials.filter((c) => selectedUsernames.includes(c.username)),
    [credentials, selectedUsernames],
  );

  const targetFilePath = useMemo(() => {
    const cleanName = filename.trim() || buildDefaultEnvFilename(db.name);
    return path.resolve(currentDir, cleanName);
  }, [currentDir, filename, db.name]);

  const targetAlreadyExists = useMemo(
    () => (stage === 'preview_save' ? fileExists(targetFilePath) : false),
    [stage, targetFilePath],
  );

  const generatedEnv = useMemo(() => {
    if (selectedUsers.length === 0) return null;
    return generateEnvContent({
      db,
      users: selectedUsers,
      connectionMode,
      nodePortInfo,
      networkAccess,
      tlsMode,
    });
  }, [db, selectedUsers, connectionMode, nodePortInfo, networkAccess, tlsMode]);

  const isTyping = stage === 'edit_filename' || stage === 'edit_custom_path';

  const enterUsersStep = (target: 'file' | 'preview') => {
    setFlowTarget(target);
    setStatusNote(null);
    setErrorMsg(null);
    setStage('select_users');
    if (credentials.length === 0) {
      void loadEnvContext();
    }
  };

  useInput(
    (input, key) => {
      if (creatingNp) return;
      const lower = input.toLowerCase();

      // ── MENU ─────────────────────────────────────────────────────────
      if (stage === 'menu') {
        if (key.escape || lower === 'q') {
          onClose();
          return;
        }
        if (key.upArrow || lower === 'k') {
          setMenuIdx((prev) =>
            prev > 0 ? prev - 1 : ENV_MENU_OPTIONS.length - 1,
          );
          return;
        }
        if (key.downArrow || lower === 'j') {
          setMenuIdx((prev) =>
            prev < ENV_MENU_OPTIONS.length - 1 ? prev + 1 : 0,
          );
          return;
        }
        if (key.return) {
          const chosen = ENV_MENU_OPTIONS[menuIdx];
          if (!chosen) return;
          enterUsersStep(chosen.id === 'generate_file' ? 'file' : 'preview');
        }
        return;
      }

      // ── SELECT USERS (MULTI-SELECT) ──────────────────────────────────
      if (stage === 'select_users') {
        if (key.escape) {
          setStage('menu');
          return;
        }
        if (lower === 'q') {
          onClose();
          return;
        }
        if (lower === 'u') {
          void loadEnvContext();
          return;
        }
        if (key.upArrow || lower === 'k') {
          setUserCursor((prev) =>
            credentials.length === 0
              ? 0
              : prev > 0
                ? prev - 1
                : credentials.length - 1,
          );
          return;
        }
        if (key.downArrow || lower === 'j') {
          setUserCursor((prev) =>
            credentials.length === 0
              ? 0
              : prev < credentials.length - 1
                ? prev + 1
                : 0,
          );
          return;
        }
        if (input === ' ') {
          const target = credentials[userCursor];
          if (!target) return;
          setSelectedUsernames((prev) =>
            prev.includes(target.username)
              ? prev.filter((u) => u !== target.username)
              : [...prev, target.username],
          );
          return;
        }
        if (lower === 'a') {
          setSelectedUsernames(credentials.map((c) => c.username));
          return;
        }
        if (lower === 'n') {
          setSelectedUsernames([]);
          return;
        }
        if (lower === 't') {
          if (connectionMode === 'internal' && !nodePortInfo) {
            setErrorMsg(
              'Esta BD aún no tiene Service NodePort. Pulsa (c) para crearlo ahora o usa el Service interno k8s.',
            );
            return;
          }
          setErrorMsg(null);
          setConnectionMode((prev) =>
            prev === 'nodeport' ? 'internal' : 'nodeport',
          );
          return;
        }
        if (lower === 'c' && !nodePortInfo) {
          setCreatingNp(true);
          setErrorMsg(null);
          setStatusNote(null);
          void createOrGetNodePortAccess(db, hostIp)
            .then(({ info }) => {
              setNodePortInfo(info);
              setConnectionMode('nodeport');
              setStatusNote(
                `✔ NodePort creado (${info.serviceName} → ${info.hostIp}:${info.nodePort}).`,
              );
            })
            .catch((err) => {
              setErrorMsg(err instanceof Error ? err.message : String(err));
            })
            .finally(() => setCreatingNp(false));
          return;
        }
        if (key.return) {
          if (selectedUsers.length === 0) {
            setErrorMsg('Selecciona al menos un usuario con [Espacio].');
            return;
          }
          setErrorMsg(null);
          setStatusNote(null);
          if (flowTarget === 'preview') {
            setStage('preview_only');
          } else {
            setStage('select_dir');
          }
        }
        return;
      }

      // ── SELECT DESTINATION DIRECTORY ─────────────────────────────────
      if (stage === 'select_dir') {
        const totalRows = 1 + dirEntries.length; // 0 = use current dir
        if (key.escape) {
          setStage('select_users');
          return;
        }
        if (lower === 'q') {
          onClose();
          return;
        }
        if (key.upArrow || lower === 'k') {
          setDirCursor((prev) => (prev > 0 ? prev - 1 : totalRows - 1));
          return;
        }
        if (key.downArrow || lower === 'j') {
          setDirCursor((prev) => (prev < totalRows - 1 ? prev + 1 : 0));
          return;
        }
        if (lower === 'h') {
          setShowHiddenDirs((prev) => !prev);
          return;
        }
        if (input === '~') {
          setCurrentDir(getHomeDir());
          return;
        }
        if (input === '.') {
          setCurrentDir(getLaunchDir());
          return;
        }
        if (lower === 'f') {
          setErrorMsg(null);
          setStage('edit_filename');
          return;
        }
        if (lower === 'e') {
          setErrorMsg(null);
          setCustomPathInput(targetFilePath);
          setStage('edit_custom_path');
          return;
        }
        if (lower === 's') {
          setErrorMsg(null);
          setWriteMode('overwrite');
          setStage('preview_save');
          return;
        }
        if (key.return) {
          if (dirCursor === 0) {
            setErrorMsg(null);
            setWriteMode('overwrite');
            setStage('preview_save');
            return;
          }
          const entry = dirEntries[dirCursor - 1];
          if (entry) {
            setCurrentDir(entry.fullPath);
          }
        }
        return;
      }

      // ── PREVIEW & SAVE TO DISK ───────────────────────────────────────
      if (stage === 'preview_save') {
        if (key.escape) {
          setStage('select_dir');
          return;
        }
        if (lower === 'q') {
          onClose();
          return;
        }
        if (lower === 'p') {
          setShowPasswords((prev) => !prev);
          return;
        }
        if (lower === 'm' && targetAlreadyExists) {
          setWriteMode((prev) =>
            prev === 'overwrite' ? 'append' : 'overwrite',
          );
          return;
        }
        if (key.return && generatedEnv) {
          try {
            const res = writeEnvFile(
              targetFilePath,
              generatedEnv.contentFull,
              writeMode,
            );
            setSavedResult({
              filePath: res.filePath,
              bytesWritten: res.bytesWritten,
              userCount: selectedUsers.length,
              mode: writeMode,
            });
            setErrorMsg(null);
            setStage('done');
          } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : String(err));
          }
        }
        return;
      }

      // ── PREVIEW ONLY ─────────────────────────────────────────────────
      if (stage === 'preview_only') {
        if (key.escape) {
          setStage('select_users');
          return;
        }
        if (lower === 'q') {
          onClose();
          return;
        }
        if (lower === 'p') {
          setShowPasswords((prev) => !prev);
          return;
        }
        if (lower === 'g') {
          setFlowTarget('file');
          setStage('select_dir');
        }
        return;
      }

      // ── DONE ─────────────────────────────────────────────────────────
      if (stage === 'done') {
        if (key.escape || key.return) {
          setStage('menu');
          return;
        }
        if (lower === 'q') {
          onClose();
        }
      }
    },
    { isActive: !isTyping },
  );

  const footerItems = useMemo(() => {
    if (stage === 'menu') {
      return [
        { key: '↑/↓', label: 'Elegir opción' },
        { key: 'Enter', label: 'Abrir', accent: 'green' },
        { key: 'Esc/Q', label: 'Volver al menú principal', accent: 'red' },
      ];
    }
    if (stage === 'select_users') {
      return [
        { key: 'Espacio', label: 'Marcar/Desmarcar', accent: 'yellow' },
        { key: 'a/n', label: 'Todos/Ninguno' },
        { key: 't', label: 'NodePort/Interno', accent: 'cyan' },
        ...(nodePortInfo
          ? []
          : [{ key: 'c', label: 'Crear NodePort', accent: 'green' }]),
        {
          key: 'Enter',
          label: 'Continuar',
          accent: 'green',
          disabled: selectedUsers.length === 0,
        },
        { key: 'Esc', label: 'Atrás' },
      ];
    }
    if (stage === 'select_dir') {
      return [
        { key: '↑/↓', label: 'Navegar' },
        { key: 'Enter', label: 'Entrar / Elegir', accent: 'green' },
        { key: 's', label: 'Guardar aquí', accent: 'cyan' },
        { key: 'f', label: 'Nombre archivo', accent: 'yellow' },
        { key: 'e', label: 'Ruta manual' },
        { key: './~', label: 'Inicio/Home' },
        { key: 'h', label: showHiddenDirs ? 'Ocultar .' : 'Ver .' },
        { key: 'Esc', label: 'Atrás' },
      ];
    }
    if (stage === 'edit_filename' || stage === 'edit_custom_path') {
      return [
        { key: 'Enter', label: 'Confirmar', accent: 'green' },
        { key: 'Esc', label: 'Cancelar' },
      ];
    }
    if (stage === 'preview_save') {
      return [
        { key: 'Enter', label: 'Guardar archivo .env', accent: 'green' },
        {
          key: 'p',
          label: showPasswords ? 'Ocultar claves' : 'Ver claves',
          accent: 'yellow',
        },
        ...(targetAlreadyExists
          ? [
              {
                key: 'm',
                label:
                  writeMode === 'overwrite'
                    ? 'Modo: Sobrescribir'
                    : 'Modo: Añadir (append)',
                accent: 'magenta',
              },
            ]
          : []),
        { key: 'Esc', label: 'Cambiar ruta' },
      ];
    }
    if (stage === 'preview_only') {
      return [
        {
          key: 'p',
          label: showPasswords ? 'Ocultar claves' : 'Ver claves',
          accent: 'yellow',
        },
        { key: 'g', label: 'Guardar a archivo .env', accent: 'green' },
        { key: 'Esc', label: 'Atrás' },
        { key: 'Q', label: 'Salir', accent: 'red' },
      ];
    }
    return [
      { key: 'Enter/Esc', label: 'Volver a Variables de entorno', accent: 'green' },
      { key: 'Q', label: 'Menú principal', accent: 'red' },
    ];
  }, [
    stage,
    nodePortInfo,
    selectedUsers.length,
    showHiddenDirs,
    showPasswords,
    targetAlreadyExists,
    writeMode,
  ]);

  // Compute scrollable window for directory picker
  const maxDirVisible = Math.max(6, termHeight - 16);
  const allDirRows = useMemo(
    () => [
      {
        key: '__current__',
        label: `✔ Usar esta carpeta actual (${path.basename(currentDir) || currentDir})`,
        isAction: true,
      },
      ...dirEntries.map((e) => ({
        key: e.fullPath,
        label: e.isParent ? `⬆ ${e.name}` : `📁 ${e.name}/`,
        isAction: false,
      })),
    ],
    [currentDir, dirEntries],
  );

  const dirWindowStart = Math.max(
    0,
    Math.min(
      dirCursor - Math.floor(maxDirVisible / 2),
      Math.max(0, allDirRows.length - maxDirVisible),
    ),
  );
  const visibleDirRows = allDirRows.slice(
    dirWindowStart,
    dirWindowStart + maxDirVisible,
  );

  const previewLines = useMemo(() => {
    if (!generatedEnv) return [];
    const text = showPasswords
      ? generatedEnv.contentFull
      : generatedEnv.contentMasked;
    return text.split('\n');
  }, [generatedEnv, showPasswords]);

  return (
    <Box
      flexDirection="column"
      height={Math.max(20, termHeight)}
      justifyContent="space-between"
    >
      {/* Banner */}
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        justifyContent="space-between"
      >
        <Box gap={1}>
          <Text bold color="cyan">
            ⚙ Variables de entorno (.env)
          </Text>
          <Text dimColor>·</Text>
          <Text bold color="white">
            {db.name}
          </Text>
          <Text dimColor>
            ({db.primaryNode} · {db.labelId?.display ?? 'sin label'})
          </Text>
        </Box>
        <Text dimColor>
          Paso:{' '}
          <Text color="cyan" bold>
            {stage === 'menu'
              ? 'Menú'
              : stage === 'select_users'
                ? '1. Usuarios'
                : stage === 'select_dir' ||
                    stage === 'edit_filename' ||
                    stage === 'edit_custom_path'
                  ? '2. Ruta destino'
                  : stage === 'preview_save'
                    ? '3. Confirmar'
                    : stage === 'preview_only'
                      ? 'Vista previa'
                      : 'Completado'}
          </Text>
        </Text>
      </Box>

      {/* Main Content */}
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="single"
        borderColor="gray"
        paddingX={2}
        paddingY={1}
        gap={1}
      >
        {statusNote ? <Text color="green">{statusNote}</Text> : null}
        {errorMsg ? (
          <Box borderStyle="round" borderColor="red" paddingX={1}>
            <Text color="red">✖ {errorMsg}</Text>
          </Box>
        ) : null}

        {/* ── ROOT MENU ── */}
        {stage === 'menu' && (
          <Box flexDirection="column" gap={1}>
            <Text bold>
              Generación de variables de entorno (.env) para &quot;{db.name}&quot;:
            </Text>
            <Box flexDirection="column">
              {ENV_MENU_OPTIONS.map((opt, idx) => {
                const sel = idx === menuIdx;
                return (
                  <Box
                    key={opt.id}
                    flexDirection="column"
                    borderStyle={sel ? 'round' : 'single'}
                    borderColor={sel ? 'cyan' : 'gray'}
                    paddingX={1}
                  >
                    <Box gap={1}>
                      <Text color={sel ? 'cyan' : 'gray'} bold={sel}>
                        {sel ? '❯' : ' '}
                      </Text>
                      <Text bold color={sel ? 'cyan' : 'white'}>
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
            <Text dimColor>
              Por defecto el archivo se guarda en el directorio actual ({getLaunchDir()}), o puedes elegir otra carpeta con el selector.
            </Text>
          </Box>
        )}

        {/* ── STEP 1: SELECT USERS (MULTI-SELECT) ── */}
        {stage === 'select_users' && (
          <Box flexDirection="column" gap={1}>
            <Box justifyContent="space-between">
              <Text bold>
                Selecciona uno o más usuarios a incluir en el .env ({selectedUsers.length} seleccionado{selectedUsers.length === 1 ? '' : 's'}):
              </Text>
              <Text dimColor>
                Conexión:{' '}
                <Text
                  color={connectionMode === 'nodeport' ? 'green' : 'yellow'}
                  bold
                >
                  {connectionMode === 'nodeport' && nodePortInfo
                    ? `NodePort (${nodePortInfo.hostIp}:${nodePortInfo.nodePort})`
                    : networkAccess?.mode === 'clusterip'
                      ? `ClusterIP privado (${networkAccess.shortDns}:${networkAccess.port})`
                      : `Interno k8s (${db.name}-rw:5432)`}
                </Text>
              </Text>
            </Box>

            {!nodePortInfo ? (
              <Box borderStyle="round" borderColor="yellow" paddingX={1}>
                <Text color="yellow">
                  ℹ Esta BD aún no tiene NodePort (se usará el Service interno k8s). Pulsa{' '}
                  <Text bold>(c)</Text> si deseas crear un acceso NodePort externo ahora.
                </Text>
              </Box>
            ) : null}

            {loading || creatingNp ? (
              <Box gap={1}>
                <Spinner />
                <Text>
                  {creatingNp
                    ? 'Creando Service NodePort...'
                    : 'Cargando usuarios y credenciales guardadas...'}
                </Text>
              </Box>
            ) : credentials.length === 0 ? (
              <Text dimColor>
                No se encontraron usuarios con acceso LOGIN en esta BD.
              </Text>
            ) : (
              <Box flexDirection="column">
                <Text bold dimColor>
                  {'      '}
                  {padCell('USUARIO', 20)}
                  {padCell('CONTRASEÑA', 20)}
                  {'PERMISOS'}
                </Text>
                <Text dimColor>{'─'.repeat(80)}</Text>
                {credentials.map((cred, idx) => {
                  const isCur = idx === userCursor;
                  const checked = selectedUsernames.includes(cred.username);
                  return (
                    <Box key={cred.username} gap={1}>
                      <Text color={isCur ? 'cyan' : 'gray'}>
                        {isCur ? '❯' : ' '}
                      </Text>
                      <Text color={checked ? 'green' : 'gray'} bold={checked}>
                        {checked ? '[✔]' : '[ ]'}
                      </Text>
                      <Text color={isCur ? 'cyan' : 'white'} bold={isCur}>
                        {padCell(cred.username, 20)}
                      </Text>
                      <Text color={cred.password ? 'green' : 'yellow'}>
                        {padCell(
                          cred.password
                            ? `🔑 ${cred.source === 'cnpg' ? 'CNPG Secret' : 'kpg Secret'}`
                            : '⚠ sin guardar',
                          20,
                        )}
                      </Text>
                      <Text dimColor>
                        {cred.permissions.join(', ') || 'LOGIN'}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
            )}

            <Text dimColor>
              • 1 usuario → genera PGUSER, PGPASSWORD y DATABASE_URL. Varios usuarios → genera DB_USER_&lt;USER&gt;, DB_PASSWORD_&lt;USER&gt; y DATABASE_URL_&lt;USER&gt;.
            </Text>
          </Box>
        )}

        {/* ── STEP 2: DIRECTORY PICKER ── */}
        {stage === 'select_dir' && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Text bold>
                Selector de ruta destino (por defecto: carpeta donde ejecutaste kpg)
              </Text>
              <Text>
                <Text dimColor>Carpeta actual: </Text>
                <Text color="cyan" bold>
                  {currentDir}
                </Text>
              </Text>
              <Text>
                <Text dimColor>Archivo destino: </Text>
                <Text color="green" bold>
                  {targetFilePath}
                </Text>
              </Text>
            </Box>

            {dirError ? (
              <Text color="red">⚠ No se pudo leer esta carpeta: {dirError}</Text>
            ) : null}

            <Box flexDirection="column">
              {visibleDirRows.map((row, idx) => {
                const realIdx = dirWindowStart + idx;
                const sel = realIdx === dirCursor;
                return (
                  <Box key={row.key}>
                    <Text
                      color={sel ? 'cyan' : row.isAction ? 'green' : undefined}
                      bold={sel || row.isAction}
                      inverse={sel}
                    >
                      {sel ? '❯ ' : '  '}
                      {row.label}
                    </Text>
                  </Box>
                );
              })}
              {allDirRows.length > maxDirVisible ? (
                <Text dimColor>
                  ... mostrando {dirWindowStart + 1}–
                  {Math.min(allDirRows.length, dirWindowStart + maxDirVisible)} de{' '}
                  {allDirRows.length} elementos
                </Text>
              ) : null}
            </Box>
          </Box>
        )}

        {/* ── EDIT FILENAME ── */}
        {stage === 'edit_filename' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="yellow">
              Nombre del archivo .env (dentro de {currentDir}):
            </Text>
            <Text dimColor>Ejemplos: .env, .env.local, .env.{db.name}</Text>
            <TextInputField
              value={filename}
              onChange={setFilename}
              onSubmit={() => {
                const clean = filename.trim();
                if (!clean || clean.includes('/') || clean.includes('\\')) {
                  setErrorMsg(
                    'Escribe solo el nombre del archivo (sin barras "/"). Para ruta completa usa (e).',
                  );
                  return;
                }
                setErrorMsg(null);
                setFilename(clean);
                setStage('select_dir');
              }}
              onCancel={() => {
                setErrorMsg(null);
                setStage('select_dir');
              }}
              placeholder={`.env.${db.name}`}
              isActive
            />
          </Box>
        )}

        {/* ── EDIT CUSTOM FULL PATH ── */}
        {stage === 'edit_custom_path' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="cyan">
              Ruta completa del archivo .env:
            </Text>
            <Text dimColor>
              Puedes escribir una ruta absoluta o relativa a {getLaunchDir()}:
            </Text>
            <TextInputField
              value={customPathInput}
              onChange={setCustomPathInput}
              onSubmit={() => {
                const trimmed = customPathInput.trim();
                if (!trimmed) {
                  setErrorMsg('La ruta no puede estar vacía.');
                  return;
                }
                const expanded = trimmed.startsWith('~/')
                  ? path.join(getHomeDir(), trimmed.slice(2))
                  : trimmed;
                const resolved = path.resolve(getLaunchDir(), expanded);
                setCurrentDir(path.dirname(resolved));
                setFilename(path.basename(resolved));
                setErrorMsg(null);
                setWriteMode('overwrite');
                setStage('preview_save');
              }}
              onCancel={() => {
                setErrorMsg(null);
                setStage('select_dir');
              }}
              placeholder={targetFilePath}
              isActive
            />
          </Box>
        )}

        {/* ── STEP 3: PREVIEW & CONFIRM SAVE ── */}
        {(stage === 'preview_save' || stage === 'preview_only') &&
          generatedEnv && (
            <Box flexDirection="column" gap={1}>
              {stage === 'preview_save' ? (
                <Box flexDirection="column">
                  <Text bold color="green">
                    Confirmar generación de archivo .env
                  </Text>
                  <Text>
                    <Text dimColor>Destino: </Text>
                    <Text bold color="cyan">
                      {targetFilePath}
                    </Text>{' '}
                    <Text dimColor>(permisos 600)</Text>
                  </Text>
                </Box>
              ) : (
                <Text bold color="cyan">
                  Vista previa de variables de entorno ({selectedUsers.length}{' '}
                  usuario{selectedUsers.length === 1 ? '' : 's'})
                </Text>
              )}

              {stage === 'preview_save' && targetAlreadyExists ? (
                <Box borderStyle="round" borderColor="yellow" paddingX={1}>
                  <Text color="yellow">
                    ⚠ El archivo ya existe. Modo actual:{' '}
                    <Text bold>
                      {writeMode === 'overwrite'
                        ? 'Sobrescribir'
                        : 'Añadir al final (append)'}
                    </Text>{' '}
                    · Pulsa <Text bold>(m)</Text> para cambiar.
                  </Text>
                </Box>
              ) : null}

              {generatedEnv.missingPasswordUsers.length > 0 ? (
                <Box borderStyle="round" borderColor="yellow" paddingX={1}>
                  <Text color="yellow">
                    ⚠ Sin contraseña guardada para:{' '}
                    {generatedEnv.missingPasswordUsers.join(', ')}. Aparecerán como &lt;SIN_GUARDAR&gt; (puedes guardarla en Acceso → NodePort → c).
                  </Text>
                </Box>
              ) : null}

              <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="gray"
                paddingX={2}
                paddingY={0}
              >
                {previewLines.slice(0, Math.max(8, termHeight - 16)).map((line, i) => (
                  <Text
                    key={`${i}-${line.slice(0, 12)}`}
                    color={
                      line.startsWith('#')
                        ? 'gray'
                        : line.includes('PASSWORD') || line.includes('DATABASE_URL')
                          ? showPasswords
                            ? 'yellow'
                            : 'cyan'
                          : 'white'
                    }
                  >
                    {line || ' '}
                  </Text>
                ))}
                {previewLines.length > Math.max(8, termHeight - 16) ? (
                  <Text dimColor>
                    ... ({previewLines.length - Math.max(8, termHeight - 16)}{' '}
                    líneas adicionales se escribirán completas en el archivo)
                  </Text>
                ) : null}
              </Box>
            </Box>
          )}

        {/* ── DONE ── */}
        {stage === 'done' && savedResult && (
          <Box
            flexDirection="column"
            borderStyle="double"
            borderColor="green"
            paddingX={2}
            paddingY={1}
            gap={1}
          >
            <Text bold color="green">
              ✔ Archivo .env generado correctamente
            </Text>
            <Box flexDirection="column">
              <Text>
                <Text dimColor>Ruta: </Text>
                <Text bold color="cyan">
                  {savedResult.filePath}
                </Text>
              </Text>
              <Text>
                <Text dimColor>Usuarios incluidos: </Text>
                <Text bold>{savedResult.userCount}</Text>
                <Text dimColor> · Tamaño: </Text>
                <Text bold>{savedResult.bytesWritten} B</Text>
                <Text dimColor> · Modo: </Text>
                <Text bold>
                  {savedResult.mode === 'overwrite'
                    ? 'Sobrescrito'
                    : 'Añadido (append)'}
                </Text>
                <Text dimColor> · Permisos: </Text>
                <Text color="green">0600</Text>
              </Text>
            </Box>
            <Text dimColor>
              Pulsa [Enter / Esc] para volver a Variables de entorno o [Q] para regresar al menú principal.
            </Text>
          </Box>
        )}
      </Box>

      {/* Bottom Bar */}
      <FooterBar items={footerItems} />
    </Box>
  );
}
