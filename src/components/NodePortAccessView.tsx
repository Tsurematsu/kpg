import path from 'node:path';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { FooterBar } from './FooterBar.js';
import { Spinner } from './Spinner.js';
import { TextInputField } from './TextInputField.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  buildConnectionUrlsForUser,
  generateRandomPassword,
  getKpgCredentialsSecretName,
  getNetworkAccess,
  getTlsPolicy,
  listNodePortUserCredentials,
  setNetworkAccessMode,
  updateDbUserPassword,
  type NetworkAccessInfo,
  type NetworkAccessMode,
  type NodePortUserCredential,
  type TlsPolicyMode,
} from '../services/access.js';
import { copyToClipboard } from '../services/clipboard.js';
import {
  buildDefaultEnvFilename,
  generateEnvContent,
  getLaunchDir,
  writeEnvFile,
} from '../services/env.js';
import type { ClusterDBInfo } from '../types/k8s.js';

interface NodePortAccessViewProps {
  db: ClusterDBInfo;
  hostIp: string;
  onBack: () => void;
  onExit: () => void;
}

const ACCESS_MODES: Array<{
  id: NetworkAccessMode;
  label: string;
  color: string;
}> = [
  { id: 'close', label: 'close -> sin acceso fijo', color: 'gray' },
  { id: 'nodeport', label: 'nodeport -> local', color: 'green' },
  { id: 'clusterip', label: 'service-ip -> privado', color: 'cyan' },
];

function padCell(value: string, width: number): string {
  if (value.length >= width) {
    return width > 1 ? `${value.slice(0, width - 1)}…` : value.slice(0, width);
  }
  return value.padEnd(width, ' ');
}

function tlsLabel(mode: TlsPolicyMode): string {
  if (mode === 'disabled') return 'Sin TLS';
  if (mode === 'required') return 'Solo TLS';
  return 'Opcional';
}

export function NodePortAccessView({
  db,
  hostIp,
  onBack,
  onExit,
}: NodePortAccessViewProps) {
  const { rows: termHeight } = useTerminalSize();

  const [networkAccess, setNetworkAccess] = useState<NetworkAccessInfo | null>(
    null,
  );
  const [tlsMode, setTlsMode] = useState<TlsPolicyMode>('optional');
  const [credentials, setCredentials] = useState<NodePortUserCredential[]>([]);

  // Unified cursor across both blocks:
  // 0 = Bloque 1 (Acceso selector)
  // 1 = Bloque 2 item 0 (Generar archivo .env en cwd)
  // 2..N+1 = Bloque 2 user URLs (credentials[cursor - 2])
  const [cursor, setCursor] = useState(0);
  const [selectedMode, setSelectedMode] = useState<NetworkAccessMode>('close');

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingPasswordFor, setEditingPasswordFor] = useState<{
    username: string;
    value: string;
  } | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [access, creds, tls] = await Promise.all([
        getNetworkAccess(db, hostIp),
        listNodePortUserCredentials(db),
        getTlsPolicy(db).catch(() => 'optional' as TlsPolicyMode),
      ]);
      setNetworkAccess(access);
      setCredentials(creds);
      setTlsMode(access?.tlsMode ?? tls);
      setSelectedMode(access?.mode ?? 'close');
      setCursor((prev) => Math.min(prev, 1 + creds.length));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [db, hostIp]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const activeMode: NetworkAccessMode = networkAccess?.mode ?? 'close';
  const hasPendingModeChange = selectedMode !== activeMode;
  const totalItems = 2 + credentials.length;
  const focusedCred = cursor >= 2 ? (credentials[cursor - 2] ?? null) : null;

  const launchDir = useMemo(() => getLaunchDir(), []);
  const quickEnvPath = useMemo(
    () => path.resolve(launchDir, buildDefaultEnvFilename(db.name)),
    [launchDir, db.name],
  );

  const getUrlForCredential = useCallback(
    (cred: NodePortUserCredential): { urlMasked: string; urlFull: string } | null => {
      if (!networkAccess) return null;
      return buildConnectionUrlsForUser(
        networkAccess.connectHost,
        networkAccess.port,
        cred.username,
        cred.password,
        networkAccess.tlsMode,
      );
    },
    [networkAccess],
  );

  const handleApplyMode = async () => {
    if (!hasPendingModeChange) return;
    setBusy(true);
    setErrorMsg(null);
    setStatusNote(null);
    try {
      const updated = await setNetworkAccessMode(db, hostIp, selectedMode);
      setNetworkAccess(updated);
      setSelectedMode(updated?.mode ?? 'close');
      if (!updated) {
        setStatusNote('✔ Acceso fijo cerrado (Service de kpg eliminado).');
      } else if (updated.mode === 'nodeport') {
        setStatusNote(
          `✔ Acceso NodePort activo: ${updated.hostIp}:${updated.port} (${updated.serviceName}).`,
        );
      } else {
        setStatusNote(
          `✔ Acceso privado ClusterIP activo: ${updated.shortDns}:${updated.port} (FQDN: ${updated.fqdnDns}).`,
        );
      }
      const creds = await listNodePortUserCredentials(db);
      setCredentials(creds);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleQuickGenerateEnv = () => {
    setErrorMsg(null);
    setStatusNote(null);
    if (credentials.length === 0) {
      setErrorMsg('No hay usuarios con permiso LOGIN para incluir en el archivo .env.');
      return;
    }

    const withPass = credentials.filter((c) => Boolean(c.password));
    const targetUsers = withPass.length > 0 ? withPass : credentials;

    const npInfo =
      networkAccess && networkAccess.mode === 'nodeport' && networkAccess.nodePort
        ? {
            serviceName: networkAccess.serviceName,
            namespace: networkAccess.namespace,
            nodePort: networkAccess.nodePort,
            targetPort: networkAccess.targetPort,
            hostIp: networkAccess.hostIp,
            labelId: networkAccess.labelId,
            appPassword: networkAccess.appPassword,
            tlsMode: networkAccess.tlsMode,
            urlMasked: networkAccess.urlMasked,
            urlFull: networkAccess.urlFull,
          }
        : null;

    try {
      const generated = generateEnvContent({
        db,
        users: targetUsers,
        connectionMode: npInfo ? 'nodeport' : 'internal',
        nodePortInfo: npInfo,
        networkAccess,
        internalHostStyle: 'short',
        tlsMode: networkAccess?.tlsMode ?? tlsMode,
      });
      const res = writeEnvFile(quickEnvPath, generated.contentFull, 'overwrite');
      setStatusNote(
        `✔ Archivo .env guardado en ${res.filePath} (${targetUsers.length} usuario${targetUsers.length === 1 ? '' : 's'}, ${res.bytesWritten} B).`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyFocusedUrl = async () => {
    if (!focusedCred) return;
    setErrorMsg(null);
    setStatusNote(null);

    if (!networkAccess) {
      setErrorMsg(
        'Sin acceso fijo activo. Cambia el selector de Acceso arriba a [nodeport -> local] o [service-ip -> privado] y pulsa Enter.',
      );
      return;
    }

    const urls = getUrlForCredential(focusedCred);
    if (!urls) return;

    const copyRes = await copyToClipboard(urls.urlFull);
    if (copyRes.ok) {
      setStatusNote(
        `✔ URL completa de "${focusedCred.username}" copiada al portapapeles (${copyRes.method}).`,
      );
    } else {
      setErrorMsg(
        copyRes.error ||
          'No se pudo copiar al portapapeles automáticamente en este entorno.',
      );
    }
  };

  const isTypingPassword = editingPasswordFor !== null;

  useInput(
    (input, key) => {
      if (busy) return;
      const lower = input.toLowerCase();

      if (key.escape) {
        onBack();
        return;
      }
      if (lower === 'q') {
        onExit();
        return;
      }
      if (lower === 'u') {
        void loadAll();
        return;
      }

      if (key.upArrow || lower === 'k') {
        setCursor((prev) => (prev > 0 ? prev - 1 : totalItems - 1));
        return;
      }
      if (key.downArrow || lower === 'j') {
        setCursor((prev) => (prev < totalItems - 1 ? prev + 1 : 0));
        return;
      }

      // Block 1: scrollable horizontal selector
      if (cursor === 0) {
        if (key.leftArrow || lower === 'h') {
          setSelectedMode((prev) => {
            const idx = ACCESS_MODES.findIndex((m) => m.id === prev);
            const nextIdx = idx > 0 ? idx - 1 : ACCESS_MODES.length - 1;
            return ACCESS_MODES[nextIdx].id;
          });
          return;
        }
        if (key.rightArrow || lower === 'l') {
          setSelectedMode((prev) => {
            const idx = ACCESS_MODES.findIndex((m) => m.id === prev);
            const nextIdx = idx < ACCESS_MODES.length - 1 ? idx + 1 : 0;
            return ACCESS_MODES[nextIdx].id;
          });
          return;
        }
        if (key.return) {
          void handleApplyMode();
        }
        return;
      }

      // Block 2, item 0: Generate .env in cwd
      if (cursor === 1) {
        if (key.return) {
          handleQuickGenerateEnv();
        }
        return;
      }

      // Block 2, user URL rows
      if (focusedCred) {
        if (key.return) {
          void handleCopyFocusedUrl();
          return;
        }
        if (lower === 'c') {
          if (db.hibernated) {
            setErrorMsg(
              `La BD "${db.name}" está apagada. Enciéndela con (p) para cambiar contraseñas en PostgreSQL.`,
            );
            return;
          }
          if (focusedCred.isSystem) {
            setErrorMsg(
              `El rol de sistema "${focusedCred.username}" está protegido y no se puede rotar desde aquí.`,
            );
            return;
          }
          setErrorMsg(null);
          setStatusNote(null);
          setEditingPasswordFor({ username: focusedCred.username, value: '' });
        }
      }
    },
    { isActive: !isTypingPassword },
  );

  const footerItems = useMemo(() => {
    if (editingPasswordFor) {
      return [
        { key: 'Enter', label: 'Guardar contraseña', accent: 'green' },
        { key: 'Esc', label: 'Cancelar' },
      ];
    }
    if (cursor === 0) {
      return [
        { key: '↑/↓', label: 'Navegar' },
        { key: '←/→', label: 'Cambiar modo', accent: 'yellow' },
        {
          key: 'Enter',
          label: 'Aplicar acceso',
          accent: 'green',
          disabled: !hasPendingModeChange,
        },
        { key: 'u', label: 'Refrescar' },
        { key: 'Esc', label: 'Atrás' },
        { key: 'Q', label: 'Salir', accent: 'red' },
      ];
    }
    if (cursor === 1) {
      return [
        { key: '↑/↓', label: 'Navegar' },
        { key: 'Enter', label: 'Guardar .env aquí', accent: 'green' },
        { key: 'u', label: 'Refrescar' },
        { key: 'Esc', label: 'Atrás' },
        { key: 'Q', label: 'Salir', accent: 'red' },
      ];
    }
    return [
      { key: '↑/↓', label: 'Navegar' },
      {
        key: 'Enter',
        label: 'Copiar URL',
        accent: 'green',
        disabled: !networkAccess,
      },
      {
        key: 'c',
        label: 'Clave',
        accent: 'cyan',
        disabled: !focusedCred || focusedCred.isSystem || db.hibernated,
      },
      { key: 'u', label: 'Refrescar' },
      { key: 'Esc', label: 'Atrás' },
      { key: 'Q', label: 'Salir', accent: 'red' },
    ];
  }, [
    editingPasswordFor,
    cursor,
    hasPendingModeChange,
    networkAccess,
    focusedCred,
    db.hibernated,
  ]);

  const currentModeMeta =
    ACCESS_MODES.find((m) => m.id === selectedMode) ?? ACCESS_MODES[0];
  const kpgSecretName = getKpgCredentialsSecretName(db.name);

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
            🔑 Acceso
          </Text>
          <Text dimColor>·</Text>
          <Text bold color="white">
            {db.name}
          </Text>
          <Text dimColor>
            ({db.primaryNode} · TLS: {tlsLabel(networkAccess?.tlsMode ?? tlsMode)})
          </Text>
        </Box>
        <Text dimColor>
          Grupo:{' '}
          <Text color="cyan" bold>
            {db.namespace}
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

        {loading || busy ? (
          <Box gap={1}>
            <Spinner />
            <Text>
              {busy
                ? 'Aplicando configuración de acceso...'
                : 'Consultando acceso de red y credenciales...'}
            </Text>
          </Box>
        ) : (
          <>
            {/* ── BLOQUE 1: ACCESO (SELECTOR DESPLAZABLE + GRUPO/NAMESPACE) ── */}
            <Box
              flexDirection="column"
              borderStyle={cursor === 0 ? 'double' : 'round'}
              borderColor={
                cursor === 0
                  ? 'cyan'
                  : networkAccess?.mode === 'nodeport'
                    ? 'green'
                    : networkAccess?.mode === 'clusterip'
                      ? 'cyan'
                      : 'gray'
              }
              paddingX={2}
              paddingY={0}
            >
              <Box justifyContent="space-between">
                <Box gap={1}>
                  <Text color={cursor === 0 ? 'cyan' : 'gray'} bold={cursor === 0}>
                    {cursor === 0 ? '❯' : ' '}
                  </Text>
                  <Text bold color={cursor === 0 ? 'cyan' : 'white'}>
                    Acceso
                  </Text>
                  <Text dimColor>|</Text>
                  <Text color={cursor === 0 ? 'yellow' : 'gray'} bold={cursor === 0}>
                    ◀
                  </Text>
                  <Text
                    color={hasPendingModeChange ? 'yellow' : currentModeMeta.color}
                    bold
                  >
                    [{currentModeMeta.label}]
                  </Text>
                  <Text color={cursor === 0 ? 'yellow' : 'gray'} bold={cursor === 0}>
                    ▶
                  </Text>
                  <Text dimColor>|</Text>
                  <Text>
                    <Text dimColor>Grupo:</Text>
                    <Text color="cyan" bold>
                      {db.namespace}
                    </Text>
                  </Text>
                </Box>

                {hasPendingModeChange ? (
                  <Text color="yellow" bold>
                    [Enter] Aplicar
                  </Text>
                ) : networkAccess ? (
                  <Text color={networkAccess.mode === 'nodeport' ? 'green' : 'cyan'}>
                    ● Activo
                  </Text>
                ) : (
                  <Text dimColor>○ Cerrado</Text>
                )}
              </Box>

              {/* Active endpoint info line */}
              <Box marginLeft={2}>
                {networkAccess?.mode === 'nodeport' ? (
                  <Text dimColor>
                    Endpoint:{' '}
                    <Text color="green" bold>
                      {networkAccess.hostIp}:{networkAccess.port}
                    </Text>{' '}
                    ({networkAccess.serviceName} → primario automático)
                  </Text>
                ) : networkAccess?.mode === 'clusterip' ? (
                  <Text dimColor>
                    DNS namespace:{' '}
                    <Text color="cyan" bold>
                      {networkAccess.shortDns}:{networkAccess.port}
                    </Text>{' '}
                    · FQDN: {networkAccess.fqdnDns}
                  </Text>
                ) : (
                  <Text dimColor>
                    Usa ◀/▶ para elegir [nodeport -&gt; local] o [service-ip -&gt; privado] y pulsa Enter.
                  </Text>
                )}
              </Box>
            </Box>

            {/* Inline Password Rotation Box (when pressing 'c' on a user) */}
            {editingPasswordFor ? (
              <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="cyan"
                paddingX={2}
                paddingY={0}
              >
                <Text bold color="cyan">
                  Asignar / rotar contraseña para &quot;{editingPasswordFor.username}&quot;
                </Text>
                <Text dimColor>
                  Vacío + Enter para autogenerar (se actualiza en PostgreSQL y en Secret {kpgSecretName}):
                </Text>
                <TextInputField
                  value={editingPasswordFor.value}
                  onChange={(val) =>
                    setEditingPasswordFor((prev) =>
                      prev ? { ...prev, value: val } : null,
                    )
                  }
                  onSubmit={() => {
                    const targetUser = editingPasswordFor.username;
                    const finalPass =
                      editingPasswordFor.value.trim() ||
                      generateRandomPassword(20);
                    setEditingPasswordFor(null);
                    setBusy(true);
                    setErrorMsg(null);
                    void updateDbUserPassword(db, targetUser, finalPass)
                      .then(async () => {
                        setStatusNote(
                          `✔ Contraseña de "${targetUser}" actualizada en PostgreSQL y guardada en ${kpgSecretName}.`,
                        );
                        await loadAll();
                      })
                      .catch((err) => {
                        setErrorMsg(
                          err instanceof Error ? err.message : String(err),
                        );
                      })
                      .finally(() => setBusy(false));
                  }}
                  onCancel={() => setEditingPasswordFor(null)}
                  placeholder="(vacío = autogenerar)"
                  isActive
                />
              </Box>
            ) : null}

            {/* ── BLOQUE 2: GENERAR .ENV + URLS POR USUARIO ── */}
            <Box
              flexDirection="column"
              borderStyle="single"
              borderColor={cursor >= 1 ? 'cyan' : 'gray'}
              paddingX={1}
              paddingY={0}
              flexGrow={1}
            >
              {/* Item 1: Quick Generate .env */}
              <Box>
                <Text
                  color={cursor === 1 ? 'green' : 'cyan'}
                  bold={cursor === 1}
                  inverse={cursor === 1}
                >
                  {cursor === 1 ? '❯ ' : '  '}
                  ⚙ Generar .env → {quickEnvPath}
                </Text>
              </Box>

              <Text dimColor>{'─'.repeat(78)}</Text>

              {/* User URLs list */}
              {credentials.length === 0 ? (
                <Text dimColor>No se encontraron usuarios con permiso LOGIN.</Text>
              ) : (
                <Box flexDirection="column">
                  {credentials.map((cred, idx) => {
                    const itemIndex = idx + 2;
                    const isFocused = cursor === itemIndex;
                    const urls = getUrlForCredential(cred);

                    const urlDisplay = !urls
                      ? '(sin acceso fijo — activa NodePort o service-ip arriba)'
                      : isFocused
                        ? urls.urlFull
                        : urls.urlMasked;

                    return (
                      <Box key={cred.username}>
                        <Text
                          color={isFocused ? 'cyan' : undefined}
                          bold={isFocused}
                          inverse={isFocused}
                        >
                          {isFocused ? '❯ ' : '  '}
                          {padCell(cred.username, 16)}
                          {'│ '}
                        </Text>
                        <Text
                          color={
                            isFocused
                              ? urls
                                ? 'yellow'
                                : 'gray'
                              : urls
                                ? 'white'
                                : 'gray'
                          }
                          dimColor={!isFocused && !urls}
                          bold={isFocused}
                          inverse={isFocused}
                        >
                          {urlDisplay}
                        </Text>
                      </Box>
                    );
                  })}
                </Box>
              )}

              <Box marginTop={1}>
                <Text dimColor>
                  Al enfocar un usuario se muestra su contraseña · Pulsa{' '}
                  <Text color="green" bold>
                    Enter
                  </Text>{' '}
                  para copiar la URL completa al portapapeles.
                </Text>
              </Box>
            </Box>
          </>
        )}
      </Box>

      {/* Minimal contextual Footer */}
      <FooterBar items={footerItems} />
    </Box>
  );
}
