import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { FooterBar } from './FooterBar.js';
import { Spinner } from './Spinner.js';
import { TextInputField } from './TextInputField.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  buildConnectionUrlsForUser,
  createOrGetNodePortAccess,
  deleteNodePortAccess,
  generateRandomPassword,
  getKpgCredentialsSecretName,
  getNodePortAccess,
  listNodePortUserCredentials,
  updateDbUserPassword,
  type NodePortInfo,
  type NodePortUserCredential,
  type TlsPolicyMode,
} from '../services/access.js';
import type { ClusterDBInfo } from '../types/k8s.js';

interface NodePortAccessViewProps {
  db: ClusterDBInfo;
  hostIp: string;
  onBack: () => void;
  onExit: () => void;
}

function padCell(value: string, width: number): string {
  if (value.length >= width) {
    return width > 1 ? `${value.slice(0, width - 1)}…` : value.slice(0, width);
  }
  return value.padEnd(width, ' ');
}

function tlsLabel(mode: TlsPolicyMode): string {
  if (mode === 'disabled') return 'Sin TLS (clientes)';
  if (mode === 'required') return 'Solo TLS (obligatorio)';
  return 'Opcional (default)';
}

function sourceLabel(source: NodePortUserCredential['source']): string {
  if (source === 'cnpg') return 'CNPG Secret';
  if (source === 'kpg') return 'kpg Secret';
  return 'sin guardar';
}

export function NodePortAccessView({
  db,
  hostIp,
  onBack,
  onExit,
}: NodePortAccessViewProps) {
  const { rows: termHeight } = useTerminalSize();

  const [nodePortInfo, setNodePortInfo] = useState<NodePortInfo | null>(null);
  const [credentials, setCredentials] = useState<NodePortUserCredential[]>([]);
  const [userIdx, setUserIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPasswords, setShowPasswords] = useState(false);
  const [confirmDestroyNp, setConfirmDestroyNp] = useState(false);
  const [editingPasswordFor, setEditingPasswordFor] = useState<{
    username: string;
    value: string;
  } | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    setConfirmDestroyNp(false);
    try {
      const [info, creds] = await Promise.all([
        getNodePortAccess(db, hostIp),
        listNodePortUserCredentials(db),
      ]);
      setNodePortInfo(info);
      setCredentials(creds);
      setUserIdx((prev) =>
        creds.length === 0 ? 0 : Math.min(prev, creds.length - 1),
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [db, hostIp]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const selectedCred = credentials[userIdx] ?? null;

  const activeUrls = useMemo(() => {
    if (!nodePortInfo) return null;
    const username = selectedCred?.username ?? 'app';
    const password = selectedCred?.password ?? nodePortInfo.appPassword;
    return buildConnectionUrlsForUser(
      nodePortInfo.hostIp,
      nodePortInfo.nodePort,
      username,
      password,
      nodePortInfo.tlsMode,
    );
  }, [nodePortInfo, selectedCred]);

  const isTypingPassword = editingPasswordFor !== null;

  useInput(
    (input, key) => {
      if (busy) return;
      const lower = input.toLowerCase();

      if (confirmDestroyNp) {
        if (key.escape || lower === 'n') {
          setConfirmDestroyNp(false);
          return;
        }
        if (
          (key.return || lower === 'y' || lower === 's' || lower === 'x') &&
          nodePortInfo
        ) {
          setBusy(true);
          setErrorMsg(null);
          void deleteNodePortAccess(db, nodePortInfo.serviceName)
            .then(() => {
              setNodePortInfo(null);
              setConfirmDestroyNp(false);
              setStatusNote(
                `✔ Conexión NodePort "${nodePortInfo.serviceName}" destruida.`,
              );
            })
            .catch((err) => {
              setErrorMsg(err instanceof Error ? err.message : String(err));
            })
            .finally(() => setBusy(false));
        }
        return;
      }

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
        setUserIdx((prev) =>
          credentials.length === 0
            ? 0
            : prev > 0
              ? prev - 1
              : credentials.length - 1,
        );
        return;
      }
      if (key.downArrow || lower === 'j') {
        setUserIdx((prev) =>
          credentials.length === 0
            ? 0
            : prev < credentials.length - 1
              ? prev + 1
              : 0,
        );
        return;
      }
      if (lower === 'p') {
        setShowPasswords((prev) => !prev);
        return;
      }
      if (lower === 'c' && selectedCred) {
        if (db.hibernated) {
          setErrorMsg(
            `La BD "${db.name}" está apagada. Enciéndela con (p) para cambiar contraseñas en PostgreSQL.`,
          );
          return;
        }
        if (selectedCred.isSystem) {
          setErrorMsg(
            `El rol de sistema "${selectedCred.username}" está protegido y no se puede rotar desde aquí.`,
          );
          return;
        }
        setErrorMsg(null);
        setStatusNote(null);
        setEditingPasswordFor({ username: selectedCred.username, value: '' });
        return;
      }
      if (lower === 'x' && nodePortInfo) {
        setConfirmDestroyNp(true);
        return;
      }
      if (key.return && !nodePortInfo && !loading) {
        setBusy(true);
        setErrorMsg(null);
        setStatusNote(null);
        void createOrGetNodePortAccess(db, hostIp)
          .then(async ({ info, created }) => {
            setNodePortInfo(info);
            setStatusNote(
              created
                ? `✔ Acceso estable NodePort creado (${info.serviceName} → puerto ${info.nodePort}).`
                : `✔ Ya existía acceso estable NodePort (${info.serviceName}).`,
            );
            const creds = await listNodePortUserCredentials(db);
            setCredentials(creds);
          })
          .catch((err) => {
            setErrorMsg(err instanceof Error ? err.message : String(err));
          })
          .finally(() => setBusy(false));
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
    if (confirmDestroyNp) {
      return [
        { key: 'Enter/x', label: 'Confirmar destrucción NodePort', accent: 'red' },
        { key: 'Esc', label: 'Cancelar' },
      ];
    }
    const base = [
      { key: '↑/↓', label: 'Elegir usuario' },
      {
        key: 'p',
        label: showPasswords ? 'Ocultar contraseñas' : 'Mostrar contraseñas',
        accent: 'yellow',
      },
      {
        key: 'c',
        label: 'Cambiar/guardar clave',
        accent: 'cyan',
        disabled: !selectedCred || selectedCred.isSystem || db.hibernated,
      },
    ];
    if (nodePortInfo) {
      return [
        ...base,
        { key: 'x', label: 'Destruir NodePort', accent: 'red' },
        { key: 'u', label: 'Refrescar' },
        { key: 'Esc', label: 'Atrás' },
        { key: 'Q', label: 'Salir', accent: 'red' },
      ];
    }
    return [
      { key: 'Enter', label: 'Crear NodePort', accent: 'green' },
      ...base,
      { key: 'Esc', label: 'Atrás' },
      { key: 'Q', label: 'Salir', accent: 'red' },
    ];
  }, [
    editingPasswordFor,
    confirmDestroyNp,
    showPasswords,
    selectedCred,
    db.hibernated,
    nodePortInfo,
  ]);

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
            ({db.primaryNode} · {db.labelId?.display ?? 'sin label'})
          </Text>
        </Box>
        <Text dimColor>
          Sección:{' '}
          <Text color="cyan" bold>
            NodePort y Contraseñas
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
                ? 'Aplicando operación sobre NodePort / credenciales...'
                : 'Consultando Service NodePort y contraseñas almacenadas...'}
            </Text>
          </Box>
        ) : (
          <>
            {/* NodePort Card */}
            {nodePortInfo ? (
              <Box
                flexDirection="column"
                borderStyle="double"
                borderColor="green"
                paddingX={2}
                paddingY={0}
              >
                <Box justifyContent="space-between">
                  <Text bold color="green">
                    ● NodePort activo: {nodePortInfo.serviceName}
                  </Text>
                  <Text dimColor>
                    TLS: <Text color="cyan">{tlsLabel(nodePortInfo.tlsMode)}</Text>
                  </Text>
                </Box>
                <Text>
                  <Text dimColor>Host / Puerto: </Text>
                  <Text bold>
                    {nodePortInfo.hostIp}:{nodePortInfo.nodePort}
                  </Text>
                  <Text dimColor> → primario automático · Label ID: </Text>
                  <Text color="yellow" bold>
                    {nodePortInfo.labelId}
                  </Text>
                </Text>
                <Box flexDirection="column" marginTop={0}>
                  <Text dimColor>
                    URL para usuario{' '}
                    <Text color="white" bold>
                      {selectedCred?.username ?? 'app'}
                    </Text>
                    :
                  </Text>
                  <Text bold color="cyan">
                    {showPasswords ? activeUrls?.urlFull : activeUrls?.urlMasked}
                  </Text>
                </Box>
              </Box>
            ) : (
              <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="yellow"
                paddingX={2}
                paddingY={0}
              >
                <Text color="yellow" bold>
                  Esta BD todavía no tiene un Service NodePort creado.
                </Text>
                <Text>
                  Pulsa <Text color="green" bold>[Enter]</Text> para crear el acceso estable ligado al label{' '}
                  <Text color="green" bold>
                    {db.labelId?.display ?? db.name}
                  </Text>{' '}
                  (copiando selector de {db.name}-rw).
                </Text>
              </Box>
            )}

            {/* Confirm Destroy NodePort */}
            {confirmDestroyNp && nodePortInfo ? (
              <Box borderStyle="round" borderColor="red" paddingX={2}>
                <Text color="red" bold>
                  ⚠ ¿Destruir Service NodePort &quot;{nodePortInfo.serviceName}&quot;?{' '}
                  [Enter/x] Sí · [Esc] Cancelar
                </Text>
              </Box>
            ) : null}

            {/* Inline Password Rotation Box */}
            {editingPasswordFor ? (
              <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="cyan"
                paddingX={2}
                paddingY={0}
                gap={0}
              >
                <Text bold color="cyan">
                  Asignar / rotar contraseña para &quot;{editingPasswordFor.username}&quot;
                </Text>
                <Text dimColor>
                  Déjalo vacío y pulsa Enter para autogenerar una clave segura (se actualiza en PostgreSQL y en Secret {kpgSecretName}):
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
                      editingPasswordFor.value.trim() || generateRandomPassword(20);
                    setEditingPasswordFor(null);
                    setBusy(true);
                    setErrorMsg(null);
                    void updateDbUserPassword(db, targetUser, finalPass)
                      .then(async () => {
                        setShowPasswords(true);
                        setStatusNote(
                          `✔ Contraseña de "${targetUser}" actualizada en PostgreSQL y guardada en Secret ${kpgSecretName}.`,
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

            {/* Users & Passwords Table */}
            <Box flexDirection="column" marginTop={0}>
              <Box justifyContent="space-between">
                <Text bold>
                  Usuarios con acceso y contraseñas ({credentials.length})
                </Text>
                <Text dimColor>
                  {showPasswords ? '🔓 Visibles' : '🔒 Ocultas — pulsa (p) para ver'}
                </Text>
              </Box>

              {credentials.length === 0 ? (
                <Text dimColor>No se encontraron usuarios con permiso LOGIN.</Text>
              ) : (
                <Box flexDirection="column">
                  <Text bold dimColor>
                    {'  '}
                    {padCell('USUARIO', 20)}
                    {padCell('ORIGEN', 14)}
                    {padCell('CONTRASEÑA', 28)}
                    {'PERMISOS'}
                  </Text>
                  <Text dimColor>{'─'.repeat(84)}</Text>
                  {credentials.map((cred, idx) => {
                    const sel = idx === userIdx;
                    const passDisplay = cred.password
                      ? showPasswords
                        ? cred.password
                        : '••••••••••••••••'
                      : '(sin guardar — pulsa c)';
                    return (
                      <Box key={cred.username}>
                        <Text
                          color={sel ? 'cyan' : undefined}
                          bold={sel}
                          inverse={sel}
                        >
                          {sel ? '❯ ' : '  '}
                          {padCell(cred.username, 20)}
                          {padCell(sourceLabel(cred.source), 14)}
                        </Text>
                        <Text
                          color={
                            sel
                              ? 'cyan'
                              : cred.password
                                ? showPasswords
                                  ? 'yellow'
                                  : 'green'
                                : 'gray'
                          }
                          bold={sel || (showPasswords && Boolean(cred.password))}
                          inverse={sel}
                        >
                          {padCell(passDisplay, 28)}
                        </Text>
                        <Text
                          color={sel ? 'cyan' : undefined}
                          dimColor={!sel}
                          bold={sel}
                          inverse={sel}
                        >
                          {cred.permissions.join(', ') || 'LOGIN'}
                        </Text>
                      </Box>
                    );
                  })}
                </Box>
              )}

              <Box marginTop={1}>
                <Text dimColor>
                  Secrets: &quot;app&quot; viene de {db.name}-app (CNPG); usuarios creados/rotados en kpg se guardan en {kpgSecretName}.
                </Text>
              </Box>
            </Box>
          </>
        )}
      </Box>

      {/* Footer */}
      <FooterBar items={footerItems} />
    </Box>
  );
}
