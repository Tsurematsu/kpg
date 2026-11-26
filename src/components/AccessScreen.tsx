import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { FooterBar } from './FooterBar.js';
import { Spinner } from './Spinner.js';
import { TextInputField } from './TextInputField.js';
import { TablePermissionsView } from './TablePermissionsView.js';
import { NodePortAccessView } from './NodePortAccessView.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  PERMISSION_OPTIONS,
  createDbUser,
  deleteDbUser,
  extractHostFromServerUrl,
  generateRandomPassword,
  getKpgCredentialsSecretName,
  getTableColumns,
  getTlsPolicy,
  listDbTables,
  listDbUsers,
  setTlsPolicy,
  updateDbUserPassword,
  updateDbUserPermissions,
  validatePgIdentifier,
  type DbColumnInfo,
  type DbTableInfo,
  type DbUserInfo,
  type PermissionKey,
  type TlsPolicyMode,
} from '../services/access.js';
import type { ClusterDBInfo, NodeInfo } from '../types/k8s.js';

interface AccessScreenProps {
  db: ClusterDBInfo;
  nodes: NodeInfo[];
  serverUrl: string;
  onClose: (refresh: boolean) => void;
}

type Section = 'menu' | 'users' | 'table_perms' | 'tables' | 'nodeport' | 'tls';

type UserSubMode =
  | { type: 'list' }
  | { type: 'edit_perms'; user: DbUserInfo; selected: PermissionKey[]; cursor: number; saving: boolean }
  | { type: 'change_pass'; user: DbUserInfo; password: string; saving: boolean }
  | { type: 'create_name'; username: string; error: string | null }
  | { type: 'create_pass'; username: string; password: string }
  | { type: 'create_perms'; username: string; password: string; selected: PermissionKey[]; cursor: number; saving: boolean }
  | { type: 'created_summary'; username: string; password: string; permissions: PermissionKey[] }
  | { type: 'confirm_delete'; user: DbUserInfo; deleting: boolean };

const ACCESS_MENU_ITEMS: Array<{
  id: Exclude<Section, 'menu'>;
  title: string;
  description: string;
}> = [
  {
    id: 'users',
    title: 'Usuarios y permisos',
    description:
      'Listar roles, permisos globales (r), por tabla (t), clave (c), crear (n) y eliminar (x)',
  },
  {
    id: 'table_perms',
    title: 'Permisos por tabla específica',
    description:
      'Elegir un usuario y otorgar o revocar SELECT/INSERT/UPDATE/DELETE tabla por tabla',
  },
  {
    id: 'tables',
    title: 'Ver tablas',
    description: 'Consulta interna vía kubectl cnpg psql (sin port-forward)',
  },
  {
    id: 'nodeport',
    title: 'Acceso estable (NodePort) y contraseñas',
    description:
      'URL autogenerada con label ID, lista de usuarios/contraseñas, rotar clave (c) y destruir (x)',
  },
  {
    id: 'tls',
    title: 'Política TLS (clientes)',
    description: 'Desactivar, dejar opcional o exigir TLS vía pg_hba en caliente',
  },
];

const TLS_OPTIONS: Array<{
  mode: TlsPolicyMode;
  title: string;
  description: string;
}> = [
  {
    mode: 'disabled',
    title: 'Sin TLS (desactivado para clientes)',
    description:
      'Solo conexiones hostnossl para clientes externos (URL con ?sslmode=disable). No afecta replicación interna.',
  },
  {
    mode: 'optional',
    title: 'TLS opcional (default CNPG)',
    description:
      'Acepta tanto conexiones con TLS como sin TLS (host all all all scram-sha-256).',
  },
  {
    mode: 'required',
    title: 'Solo TLS (obligatorio para clientes)',
    description:
      'Exige hostssl y rechaza conexiones sin cifrar de clientes externos (URL con ?sslmode=require).',
  },
];

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

export function AccessScreen({
  db,
  nodes,
  serverUrl,
  onClose,
}: AccessScreenProps) {
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

  const [section, setSection] = useState<Section>('menu');
  const [menuIdx, setMenuIdx] = useState(0);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Per-table permissions delegation state
  const [tablePermsUser, setTablePermsUser] = useState<DbUserInfo | null>(null);
  const [tablePermsReturnTo, setTablePermsReturnTo] = useState<'menu' | 'users'>('menu');

  // Users state
  const [users, setUsers] = useState<DbUserInfo[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userIdx, setUserIdx] = useState(0);
  const [userMode, setUserMode] = useState<UserSubMode>({ type: 'list' });

  // Tables state
  const [tables, setTables] = useState<DbTableInfo[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tableIdx, setTableIdx] = useState(0);
  const [selectedTableCols, setSelectedTableCols] = useState<{
    table: DbTableInfo;
    columns: DbColumnInfo[];
  } | null>(null);
  const [colsLoading, setColsLoading] = useState(false);

  // TLS state
  const [tlsMode, setTlsMode] = useState<TlsPolicyMode>('optional');
  const [tlsLoading, setTlsLoading] = useState(false);
  const [tlsSaving, setTlsSaving] = useState(false);
  const [tlsCursor, setTlsCursor] = useState(0);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setErrorMsg(null);
    try {
      const list = await listDbUsers(db);
      setUsers(list);
      setUserIdx((prev) =>
        list.length === 0 ? 0 : Math.min(prev, list.length - 1),
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUsersLoading(false);
    }
  }, [db]);

  const loadTables = useCallback(async () => {
    setTablesLoading(true);
    setErrorMsg(null);
    setSelectedTableCols(null);
    try {
      const list = await listDbTables(db);
      setTables(list);
      setTableIdx((prev) =>
        list.length === 0 ? 0 : Math.min(prev, list.length - 1),
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setTablesLoading(false);
    }
  }, [db]);

  const loadTls = useCallback(async () => {
    setTlsLoading(true);
    setErrorMsg(null);
    try {
      const current = await getTlsPolicy(db);
      setTlsMode(current);
      const idx = TLS_OPTIONS.findIndex((o) => o.mode === current);
      setTlsCursor(idx >= 0 ? idx : 0);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setTlsLoading(false);
    }
  }, [db]);

  useEffect(() => {
    setStatusNote(null);
    setErrorMsg(null);
    if (section === 'users') {
      setUserMode({ type: 'list' });
      void loadUsers();
    } else if (section === 'tables') {
      void loadTables();
    } else if (section === 'tls') {
      void loadTls();
    }
  }, [section, loadUsers, loadTables, loadTls]);

  const isDelegatedSection = section === 'table_perms' || section === 'nodeport';

  const isTypingInInput =
    section === 'users' &&
    (userMode.type === 'create_name' ||
      userMode.type === 'create_pass' ||
      (userMode.type === 'change_pass' && !userMode.saving));

  const selectedUser = users[userIdx] ?? null;
  const selectedTable = tables[tableIdx] ?? null;

  useInput(
    (input, key) => {
      const lower = input.toLowerCase();

      // ── ROOT ACCESS MENU ─────────────────────────────────────────────
      if (section === 'menu') {
        if (key.escape || lower === 'q') {
          onClose(true);
          return;
        }
        if (key.upArrow || lower === 'k') {
          setMenuIdx((prev) =>
            prev > 0 ? prev - 1 : ACCESS_MENU_ITEMS.length - 1,
          );
        } else if (key.downArrow || lower === 'j') {
          setMenuIdx((prev) =>
            prev < ACCESS_MENU_ITEMS.length - 1 ? prev + 1 : 0,
          );
        } else if (key.return) {
          const item = ACCESS_MENU_ITEMS[menuIdx];
          if (!item) return;
          if (item.id === 'table_perms') {
            setTablePermsUser(null);
            setTablePermsReturnTo('menu');
          }
          setSection(item.id);
        }
        return;
      }

      // ── USERS SECTION ────────────────────────────────────────────────
      if (section === 'users') {
        if (userMode.type === 'list') {
          if (key.escape) {
            setSection('menu');
            return;
          }
          if (lower === 'q') {
            onClose(true);
            return;
          }
          if (lower === 'u') {
            void loadUsers();
            return;
          }
          if (key.upArrow || lower === 'k') {
            setUserIdx((prev) =>
              users.length === 0 ? 0 : prev > 0 ? prev - 1 : users.length - 1,
            );
            return;
          }
          if (key.downArrow || lower === 'j') {
            setUserIdx((prev) =>
              users.length === 0 ? 0 : prev < users.length - 1 ? prev + 1 : 0,
            );
            return;
          }
          if (lower === 'n') {
            setErrorMsg(null);
            setStatusNote(null);
            setUserMode({ type: 'create_name', username: '', error: null });
            return;
          }
          if (lower === 'r' && selectedUser) {
            if (selectedUser.isSystem) {
              setErrorMsg(
                `El rol de sistema "${selectedUser.name}" está protegido para no afectar el operador CNPG.`,
              );
              return;
            }
            setErrorMsg(null);
            setStatusNote(null);
            setUserMode({
              type: 'edit_perms',
              user: selectedUser,
              selected: [...selectedUser.permissions],
              cursor: 0,
              saving: false,
            });
            return;
          }
          if (lower === 't' && selectedUser) {
            if (selectedUser.isSystem) {
              setErrorMsg(
                `El rol de sistema "${selectedUser.name}" está protegido.`,
              );
              return;
            }
            setErrorMsg(null);
            setStatusNote(null);
            setTablePermsUser(selectedUser);
            setTablePermsReturnTo('users');
            setSection('table_perms');
            return;
          }
          if (lower === 'c' && selectedUser) {
            if (selectedUser.isSystem) {
              setErrorMsg(
                `No se puede rotar la contraseña del rol de sistema "${selectedUser.name}".`,
              );
              return;
            }
            setErrorMsg(null);
            setStatusNote(null);
            setUserMode({
              type: 'change_pass',
              user: selectedUser,
              password: '',
              saving: false,
            });
            return;
          }
          if (lower === 'x' && selectedUser) {
            if (selectedUser.isSystem) {
              setErrorMsg(
                `El rol de sistema "${selectedUser.name}" no puede ser eliminado.`,
              );
              return;
            }
            setErrorMsg(null);
            setStatusNote(null);
            setUserMode({
              type: 'confirm_delete',
              user: selectedUser,
              deleting: false,
            });
            return;
          }
          return;
        }

        if (userMode.type === 'edit_perms') {
          if (userMode.saving) return;
          if (key.escape) {
            setUserMode({ type: 'list' });
            return;
          }
          if (key.upArrow || lower === 'k') {
            setUserMode((prev) =>
              prev.type === 'edit_perms'
                ? {
                    ...prev,
                    cursor:
                      prev.cursor > 0
                        ? prev.cursor - 1
                        : PERMISSION_OPTIONS.length - 1,
                  }
                : prev,
            );
            return;
          }
          if (key.downArrow || lower === 'j') {
            setUserMode((prev) =>
              prev.type === 'edit_perms'
                ? {
                    ...prev,
                    cursor:
                      prev.cursor < PERMISSION_OPTIONS.length - 1
                        ? prev.cursor + 1
                        : 0,
                  }
                : prev,
            );
            return;
          }
          if (input === ' ') {
            const opt = PERMISSION_OPTIONS[userMode.cursor];
            if (!opt) return;
            setUserMode((prev) => {
              if (prev.type !== 'edit_perms') return prev;
              const exists = prev.selected.includes(opt.key);
              return {
                ...prev,
                selected: exists
                  ? prev.selected.filter((p) => p !== opt.key)
                  : [...prev.selected, opt.key],
              };
            });
            return;
          }
          if (key.return) {
            const targetUser = userMode.user;
            const targetPerms = userMode.selected;
            setUserMode({ ...userMode, saving: true });
            void updateDbUserPermissions(db, targetUser.name, targetPerms)
              .then(async () => {
                setStatusNote(
                  `✔ Permisos de "${targetUser.name}" actualizados: ${targetPerms.join(', ') || 'ninguno'}.`,
                );
                setUserMode({ type: 'list' });
                await loadUsers();
              })
              .catch((err) => {
                setErrorMsg(err instanceof Error ? err.message : String(err));
                setUserMode({ type: 'list' });
              });
          }
          return;
        }

        if (userMode.type === 'create_perms') {
          if (userMode.saving) return;
          if (key.escape) {
            setUserMode({ type: 'list' });
            return;
          }
          if (key.upArrow || lower === 'k') {
            setUserMode((prev) =>
              prev.type === 'create_perms'
                ? {
                    ...prev,
                    cursor:
                      prev.cursor > 0
                        ? prev.cursor - 1
                        : PERMISSION_OPTIONS.length - 1,
                  }
                : prev,
            );
            return;
          }
          if (key.downArrow || lower === 'j') {
            setUserMode((prev) =>
              prev.type === 'create_perms'
                ? {
                    ...prev,
                    cursor:
                      prev.cursor < PERMISSION_OPTIONS.length - 1
                        ? prev.cursor + 1
                        : 0,
                  }
                : prev,
            );
            return;
          }
          if (input === ' ') {
            const opt = PERMISSION_OPTIONS[userMode.cursor];
            if (!opt) return;
            setUserMode((prev) => {
              if (prev.type !== 'create_perms') return prev;
              const exists = prev.selected.includes(opt.key);
              return {
                ...prev,
                selected: exists
                  ? prev.selected.filter((p) => p !== opt.key)
                  : [...prev.selected, opt.key],
              };
            });
            return;
          }
          if (key.return) {
            const { username, password, selected } = userMode;
            setUserMode({ ...userMode, saving: true });
            void createDbUser(db, username, password, selected)
              .then(async () => {
                setUserMode({
                  type: 'created_summary',
                  username,
                  password,
                  permissions: selected,
                });
                await loadUsers();
              })
              .catch((err) => {
                setErrorMsg(err instanceof Error ? err.message : String(err));
                setUserMode({ type: 'list' });
              });
          }
          return;
        }

        if (userMode.type === 'created_summary') {
          if (key.escape || key.return || lower === 'q') {
            setUserMode({ type: 'list' });
          }
          return;
        }

        if (userMode.type === 'confirm_delete') {
          if (userMode.deleting) return;
          if (key.escape || lower === 'n') {
            setUserMode({ type: 'list' });
            return;
          }
          if (key.return || lower === 'y' || lower === 's' || lower === 'x') {
            const target = userMode.user;
            setUserMode({ ...userMode, deleting: true });
            void deleteDbUser(db, target.name)
              .then(async () => {
                setStatusNote(`✔ Usuario "${target.name}" eliminado.`);
                setUserMode({ type: 'list' });
                await loadUsers();
              })
              .catch((err) => {
                setErrorMsg(err instanceof Error ? err.message : String(err));
                setUserMode({ type: 'list' });
              });
          }
          return;
        }
      }

      // ── TABLES SECTION ───────────────────────────────────────────────
      if (section === 'tables') {
        if (selectedTableCols) {
          if (key.escape || key.return) {
            setSelectedTableCols(null);
            return;
          }
          if (lower === 'q') {
            onClose(true);
            return;
          }
          return;
        }

        if (key.escape) {
          setSection('menu');
          return;
        }
        if (lower === 'q') {
          onClose(true);
          return;
        }
        if (lower === 'u') {
          void loadTables();
          return;
        }
        if (key.upArrow || lower === 'k') {
          setTableIdx((prev) =>
            tables.length === 0 ? 0 : prev > 0 ? prev - 1 : tables.length - 1,
          );
          return;
        }
        if (key.downArrow || lower === 'j') {
          setTableIdx((prev) =>
            tables.length === 0 ? 0 : prev < tables.length - 1 ? prev + 1 : 0,
          );
          return;
        }
        if (key.return && selectedTable && !colsLoading) {
          setColsLoading(true);
          setErrorMsg(null);
          void getTableColumns(db, selectedTable.schema, selectedTable.name)
            .then((columns) => {
              setSelectedTableCols({ table: selectedTable, columns });
            })
            .catch((err) => {
              setErrorMsg(err instanceof Error ? err.message : String(err));
            })
            .finally(() => setColsLoading(false));
        }
        return;
      }

      // ── TLS SECTION ──────────────────────────────────────────────────
      if (section === 'tls') {
        if (tlsSaving) return;
        if (key.escape) {
          setSection('menu');
          return;
        }
        if (lower === 'q') {
          onClose(true);
          return;
        }
        if (key.upArrow || lower === 'k') {
          setTlsCursor((prev) =>
            prev > 0 ? prev - 1 : TLS_OPTIONS.length - 1,
          );
          return;
        }
        if (key.downArrow || lower === 'j') {
          setTlsCursor((prev) =>
            prev < TLS_OPTIONS.length - 1 ? prev + 1 : 0,
          );
          return;
        }
        if (key.return) {
          const chosen = TLS_OPTIONS[tlsCursor];
          if (!chosen) return;
          setTlsSaving(true);
          setErrorMsg(null);
          setStatusNote(null);
          void setTlsPolicy(db, chosen.mode)
            .then(() => {
              setTlsMode(chosen.mode);
              setStatusNote(
                `✔ Política TLS actualizada en caliente a: ${chosen.title}.`,
              );
            })
            .catch((err) => {
              setErrorMsg(err instanceof Error ? err.message : String(err));
            })
            .finally(() => setTlsSaving(false));
        }
      }
    },
    { isActive: !isTypingInInput && !isDelegatedSection },
  );

  const footerItems = useMemo(() => {
    if (section === 'menu') {
      return [
        { key: '↑/↓', label: 'Navegar' },
        { key: 'Enter', label: 'Abrir', accent: 'green' },
        { key: 'Esc/Q', label: 'Volver al menú principal', accent: 'red' },
      ];
    }
    if (section === 'users') {
      if (userMode.type === 'edit_perms' || userMode.type === 'create_perms') {
        return [
          { key: '↑/↓', label: 'Mover' },
          { key: 'Espacio', label: 'Marcar/Desmarcar', accent: 'yellow' },
          { key: 'Enter', label: 'Guardar permisos', accent: 'green' },
          { key: 'Esc', label: 'Cancelar' },
        ];
      }
      if (
        userMode.type === 'create_name' ||
        userMode.type === 'create_pass' ||
        userMode.type === 'change_pass'
      ) {
        return [
          { key: 'Enter', label: 'Continuar / Guardar', accent: 'green' },
          { key: 'Esc', label: 'Cancelar' },
        ];
      }
      if (userMode.type === 'confirm_delete') {
        return [
          { key: 'Enter/x', label: 'Confirmar borrado', accent: 'red' },
          { key: 'Esc', label: 'Cancelar' },
        ];
      }
      return [
        { key: 'r', label: 'Permisos', accent: 'yellow', disabled: !selectedUser },
        { key: 't', label: 'Por tabla', accent: 'cyan', disabled: !selectedUser },
        { key: 'c', label: 'Clave', accent: 'magenta', disabled: !selectedUser },
        { key: 'n', label: 'Nuevo', accent: 'green' },
        { key: 'x', label: 'Eliminar', accent: 'red', disabled: !selectedUser },
        { key: 'u', label: 'Refrescar' },
        { key: 'Esc', label: 'Atrás' },
        { key: 'Q', label: 'Salir', accent: 'red' },
      ];
    }
    if (section === 'tables') {
      if (selectedTableCols) {
        return [
          { key: 'Enter/Esc', label: 'Volver a tablas' },
          { key: 'Q', label: 'Salir', accent: 'red' },
        ];
      }
      return [
        { key: '↑/↓', label: 'Elegir tabla' },
        {
          key: 'Enter',
          label: 'Ver columnas',
          accent: 'cyan',
          disabled: !selectedTable,
        },
        { key: 'u', label: 'Refrescar' },
        { key: 'Esc', label: 'Atrás' },
        { key: 'Q', label: 'Salir', accent: 'red' },
      ];
    }
    return [
      { key: '↑/↓', label: 'Elegir política' },
      { key: 'Enter', label: 'Aplicar en caliente', accent: 'green' },
      { key: 'Esc', label: 'Atrás' },
      { key: 'Q', label: 'Salir', accent: 'red' },
    ];
  }, [section, userMode.type, selectedUser, selectedTable, selectedTableCols]);

  // Delegated full-screen views
  if (section === 'table_perms') {
    return (
      <TablePermissionsView
        db={db}
        initialUser={tablePermsUser}
        onBack={() => setSection(tablePermsReturnTo)}
        onExit={() => onClose(true)}
      />
    );
  }

  if (section === 'nodeport') {
    return (
      <NodePortAccessView
        db={db}
        hostIp={hostIp}
        onBack={() => setSection('menu')}
        onExit={() => onClose(true)}
      />
    );
  }

  const secretName = getKpgCredentialsSecretName(db.name);

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
            {section === 'menu'
              ? 'Menú'
              : section === 'users'
                ? 'Usuarios'
                : section === 'tables'
                  ? 'Tablas'
                  : 'Política TLS'}
          </Text>
        </Text>
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
        {db.hibernated ? (
          <Box borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text color="yellow">
              ⚠ La BD &quot;{db.name}&quot; está apagada (hibernada). Puedes consultar NodePort/contraseñas y TLS, pero para Usuarios o Tablas enciéndela primero con (p).
            </Text>
          </Box>
        ) : null}

        {statusNote ? <Text color="green">{statusNote}</Text> : null}
        {errorMsg ? (
          <Box borderStyle="round" borderColor="red" paddingX={1}>
            <Text color="red">✖ {errorMsg}</Text>
          </Box>
        ) : null}

        {/* ── ACCESS ROOT MENU ── */}
        {section === 'menu' && (
          <Box flexDirection="column" gap={1}>
            <Text bold>Selecciona una opción de acceso para &quot;{db.name}&quot;:</Text>
            <Box flexDirection="column" gap={0}>
              {ACCESS_MENU_ITEMS.map((item, idx) => {
                const selected = idx === menuIdx;
                return (
                  <Box
                    key={item.id}
                    flexDirection="column"
                    borderStyle={selected ? 'round' : 'single'}
                    borderColor={selected ? 'cyan' : 'gray'}
                    paddingX={1}
                  >
                    <Box gap={1}>
                      <Text color={selected ? 'cyan' : 'gray'} bold={selected}>
                        {selected ? '❯' : ' '}
                      </Text>
                      <Text bold color={selected ? 'cyan' : 'white'}>
                        {item.title}
                      </Text>
                    </Box>
                    <Box marginLeft={2}>
                      <Text dimColor>{item.description}</Text>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {/* ── USERS SUBSECTION ── */}
        {section === 'users' && (
          <Box flexDirection="column" gap={1}>
            {userMode.type === 'list' && (
              <>
                <Text bold>
                  Usuarios de PostgreSQL en &quot;{db.name}&quot; (vía kubectl cnpg psql)
                </Text>
                {usersLoading ? (
                  <Box gap={1}>
                    <Spinner />
                    <Text>Consultando roles y permisos...</Text>
                  </Box>
                ) : users.length === 0 ? (
                  <Text dimColor>No se encontraron usuarios.</Text>
                ) : (
                  <Box flexDirection="column">
                    <Text bold dimColor>
                      {'  '}
                      {padCell('USUARIO', 22)}
                      {padCell('TIPO', 10)}
                      {padCell('TABLAS', 10)}
                      {'PERMISOS'}
                    </Text>
                    <Text dimColor>{'─'.repeat(82)}</Text>
                    {users.map((u, idx) => {
                      const sel = idx === userIdx;
                      const tablesRatio = `${u.tableAccessCount}/${u.totalTablesCount}`;
                      return (
                        <Box key={u.name}>
                          <Text
                            color={sel ? 'cyan' : undefined}
                            bold={sel}
                            inverse={sel}
                          >
                            {sel ? '❯ ' : '  '}
                            {padCell(u.name, 22)}
                            {padCell(u.isSystem ? 'sistema' : 'usuario', 10)}
                            {padCell(tablesRatio, 10)}
                            {u.permissions.join(', ') || 'sin permisos'}
                          </Text>
                        </Box>
                      );
                    })}
                  </Box>
                )}
              </>
            )}

            {userMode.type === 'edit_perms' && (
              <Box flexDirection="column" gap={1}>
                <Text bold color="yellow">
                  Modificar permisos generales de &quot;{userMode.user.name}&quot; (multi-selección)
                </Text>
                {userMode.saving ? (
                  <Box gap={1}>
                    <Spinner />
                    <Text>Aplicando permisos en PostgreSQL...</Text>
                  </Box>
                ) : (
                  <Box flexDirection="column">
                    {PERMISSION_OPTIONS.map((opt, idx) => {
                      const isCur = idx === userMode.cursor;
                      const checked = userMode.selected.includes(opt.key);
                      return (
                        <Box key={opt.key} gap={1}>
                          <Text color={isCur ? 'cyan' : 'gray'}>
                            {isCur ? '❯' : ' '}
                          </Text>
                          <Text color={checked ? 'green' : 'gray'} bold={checked}>
                            {checked ? '[✔]' : '[ ]'}
                          </Text>
                          <Text color={isCur ? 'cyan' : 'white'} bold={isCur}>
                            {padCell(opt.label, 28)}
                          </Text>
                          <Text dimColor>{opt.description}</Text>
                        </Box>
                      );
                    })}
                  </Box>
                )}
              </Box>
            )}

            {userMode.type === 'change_pass' && (
              <Box flexDirection="column" gap={1}>
                <Text bold color="magenta">
                  🔑 Cambiar / asignar contraseña para &quot;{userMode.user.name}&quot;
                </Text>
                {userMode.saving ? (
                  <Box gap={1}>
                    <Spinner color="magenta" />
                    <Text>Actualizando contraseña en PostgreSQL y Secret {secretName}...</Text>
                  </Box>
                ) : (
                  <>
                    <Text dimColor>
                      Déjalo vacío y pulsa Enter para autogenerar una contraseña segura:
                    </Text>
                    <TextInputField
                      value={userMode.password}
                      onChange={(val) =>
                        setUserMode({ ...userMode, password: val })
                      }
                      onSubmit={() => {
                        const target = userMode.user;
                        const finalPass =
                          userMode.password.trim() || generateRandomPassword(20);
                        setUserMode({ ...userMode, saving: true });
                        void updateDbUserPassword(db, target.name, finalPass)
                          .then(() => {
                            setStatusNote(
                              `✔ Contraseña de "${target.name}" actualizada y guardada en Secret ${secretName} (visible en NodePort).`,
                            );
                            setUserMode({ type: 'list' });
                          })
                          .catch((err) => {
                            setErrorMsg(
                              err instanceof Error ? err.message : String(err),
                            );
                            setUserMode({ type: 'list' });
                          });
                      }}
                      onCancel={() => setUserMode({ type: 'list' })}
                      placeholder="(vacío = autogenerar)"
                      isActive
                    />
                  </>
                )}
              </Box>
            )}

            {userMode.type === 'create_name' && (
              <Box flexDirection="column" gap={1}>
                <Text bold color="green">
                  + Crear nuevo usuario (1/3 · Nombre)
                </Text>
                <Text dimColor>
                  Solo minúsculas, números y guion bajo (ej. api_user):
                </Text>
                <TextInputField
                  value={userMode.username}
                  onChange={(val) =>
                    setUserMode({
                      type: 'create_name',
                      username: val.toLowerCase(),
                      error: null,
                    })
                  }
                  onSubmit={() => {
                    const clean = userMode.username.trim().toLowerCase();
                    const err = validatePgIdentifier(clean);
                    if (err) {
                      setUserMode({ ...userMode, error: err });
                      return;
                    }
                    if (users.some((u) => u.name === clean)) {
                      setUserMode({
                        ...userMode,
                        error: `El usuario "${clean}" ya existe.`,
                      });
                      return;
                    }
                    setUserMode({
                      type: 'create_pass',
                      username: clean,
                      password: '',
                    });
                  }}
                  onCancel={() => setUserMode({ type: 'list' })}
                  placeholder="api_user"
                  isActive
                />
                {userMode.error ? (
                  <Text color="red">{userMode.error}</Text>
                ) : null}
              </Box>
            )}

            {userMode.type === 'create_pass' && (
              <Box flexDirection="column" gap={1}>
                <Text bold color="green">
                  + Crear usuario &quot;{userMode.username}&quot; (2/3 · Contraseña)
                </Text>
                <Text dimColor>
                  Déjalo vacío y pulsa Enter para autogenerar una contraseña segura:
                </Text>
                <TextInputField
                  value={userMode.password}
                  onChange={(val) =>
                    setUserMode({ ...userMode, password: val })
                  }
                  onSubmit={() => {
                    const finalPass =
                      userMode.password.trim() || generateRandomPassword(20);
                    setUserMode({
                      type: 'create_perms',
                      username: userMode.username,
                      password: finalPass,
                      selected: ['LOGIN', 'READ', 'WRITE'],
                      cursor: 0,
                      saving: false,
                    });
                  }}
                  onCancel={() => setUserMode({ type: 'list' })}
                  placeholder="(vacío = autogenerar)"
                  mask
                  isActive
                />
              </Box>
            )}

            {userMode.type === 'create_perms' && (
              <Box flexDirection="column" gap={1}>
                <Text bold color="green">
                  + Crear usuario &quot;{userMode.username}&quot; (3/3 · Permisos multi-selección)
                </Text>
                {userMode.saving ? (
                  <Box gap={1}>
                    <Spinner color="green" />
                    <Text>Creando usuario, guardando credencial y asignando privilegios...</Text>
                  </Box>
                ) : (
                  <Box flexDirection="column">
                    {PERMISSION_OPTIONS.map((opt, idx) => {
                      const isCur = idx === userMode.cursor;
                      const checked = userMode.selected.includes(opt.key);
                      return (
                        <Box key={opt.key} gap={1}>
                          <Text color={isCur ? 'cyan' : 'gray'}>
                            {isCur ? '❯' : ' '}
                          </Text>
                          <Text color={checked ? 'green' : 'gray'} bold={checked}>
                            {checked ? '[✔]' : '[ ]'}
                          </Text>
                          <Text color={isCur ? 'cyan' : 'white'} bold={isCur}>
                            {padCell(opt.label, 28)}
                          </Text>
                          <Text dimColor>{opt.description}</Text>
                        </Box>
                      );
                    })}
                  </Box>
                )}
              </Box>
            )}

            {userMode.type === 'created_summary' && (
              <Box
                flexDirection="column"
                borderStyle="double"
                borderColor="green"
                paddingX={2}
                paddingY={1}
                gap={0}
              >
                <Text bold color="green">
                  ✔ Usuario &quot;{userMode.username}&quot; creado correctamente
                </Text>
                <Text>
                  <Text dimColor>Usuario: </Text>
                  <Text bold>{userMode.username}</Text>
                </Text>
                <Text>
                  <Text dimColor>Contraseña: </Text>
                  <Text bold color="yellow">
                    {userMode.password}
                  </Text>
                </Text>
                <Text>
                  <Text dimColor>Permisos: </Text>
                  <Text>{userMode.permissions.join(', ') || 'ninguno'}</Text>
                </Text>
                <Text dimColor>
                  Contraseña guardada en Secret {secretName} (también visible en el panel NodePort). Pulsa [Enter / Esc].
                </Text>
              </Box>
            )}

            {userMode.type === 'confirm_delete' && (
              <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="red"
                paddingX={2}
                paddingY={1}
                gap={1}
              >
                <Text bold color="red">
                  ⚠ ¿Eliminar el usuario &quot;{userMode.user.name}&quot;?
                </Text>
                <Text dimColor>
                  Se revocarán sus privilegios, se reasignarán sus objetos a postgres, se eliminará su credencial guardada y se ejecutará DROP ROLE.
                </Text>
                {userMode.deleting ? (
                  <Box gap={1}>
                    <Spinner color="red" />
                    <Text color="red">Eliminando usuario...</Text>
                  </Box>
                ) : (
                  <Text>
                    <Text bold color="red">
                      [Enter / x] Sí, eliminar
                    </Text>{' '}
                    · <Text dimColor>[Esc] Cancelar</Text>
                  </Text>
                )}
              </Box>
            )}
          </Box>
        )}

        {/* ── TABLES SUBSECTION ── */}
        {section === 'tables' && (
          <Box flexDirection="column" gap={1}>
            {selectedTableCols ? (
              <>
                <Text bold color="cyan">
                  Columnas de {selectedTableCols.table.schema}.{selectedTableCols.table.name}
                </Text>
                <Box flexDirection="column">
                  <Text bold dimColor>
                    {padCell('COLUMNA', 26)}
                    {padCell('TIPO', 24)}
                    {padCell('NULL', 8)}
                    {'DEFAULT'}
                  </Text>
                  <Text dimColor>{'─'.repeat(78)}</Text>
                  {selectedTableCols.columns.map((c) => (
                    <Text key={c.name}>
                      {padCell(c.name, 26)}
                      {padCell(c.dataType, 24)}
                      {padCell(c.nullable ? 'YES' : 'NO', 8)}
                      <Text dimColor>{c.defaultValue || '—'}</Text>
                    </Text>
                  ))}
                </Box>
              </>
            ) : (
              <>
                <Text bold>
                  Tablas en base &quot;app&quot; de &quot;{db.name}&quot; (comando interno sin port-forward)
                </Text>
                {tablesLoading || colsLoading ? (
                  <Box gap={1}>
                    <Spinner />
                    <Text>
                      {colsLoading
                        ? 'Consultando columnas...'
                        : 'Consultando tablas en PostgreSQL...'}
                    </Text>
                  </Box>
                ) : tables.length === 0 ? (
                  <Text dimColor>
                    No hay tablas de usuario en la base &quot;app&quot; todavía.
                  </Text>
                ) : (
                  <Box flexDirection="column">
                    <Text bold dimColor>
                      {'  '}
                      {padCell('ESQUEMA', 14)}
                      {padCell('TABLA', 28)}
                      {padCell('OWNER', 16)}
                      {padCell('FILAS (EST.)', 14)}
                      {'TAMAÑO'}
                    </Text>
                    <Text dimColor>{'─'.repeat(84)}</Text>
                    {tables.map((t, idx) => {
                      const sel = idx === tableIdx;
                      return (
                        <Box key={`${t.schema}.${t.name}`}>
                          <Text
                            color={sel ? 'cyan' : undefined}
                            bold={sel}
                            inverse={sel}
                          >
                            {sel ? '❯ ' : '  '}
                            {padCell(t.schema, 14)}
                            {padCell(t.name, 28)}
                            {padCell(t.owner, 16)}
                            {padCell(String(t.rowEstimate), 14)}
                            {t.totalSize}
                          </Text>
                        </Box>
                      );
                    })}
                  </Box>
                )}
              </>
            )}
          </Box>
        )}

        {/* ── TLS POLICY SUBSECTION ── */}
        {section === 'tls' && (
          <Box flexDirection="column" gap={1}>
            <Text bold>
              Política TLS para conexiones de clientes (spec.postgresql.pg_hba)
            </Text>
            <Text dimColor>
              Estado actual:{' '}
              <Text color="cyan" bold>
                {tlsLabel(tlsMode)}
              </Text>{' '}
              · Se aplica en caliente sin reiniciar pods ni afectar la replicación interna.
            </Text>

            {tlsLoading || tlsSaving ? (
              <Box gap={1}>
                <Spinner />
                <Text>
                  {tlsSaving
                    ? 'Aplicando reglas pg_hba en caliente...'
                    : 'Leyendo configuración pg_hba actual...'}
                </Text>
              </Box>
            ) : (
              <Box flexDirection="column" gap={0}>
                {TLS_OPTIONS.map((opt, idx) => {
                  const isCur = idx === tlsCursor;
                  const isActive = opt.mode === tlsMode;
                  return (
                    <Box
                      key={opt.mode}
                      flexDirection="column"
                      borderStyle={isCur ? 'round' : 'single'}
                      borderColor={
                        isCur ? 'cyan' : isActive ? 'green' : 'gray'
                      }
                      paddingX={1}
                    >
                      <Box justifyContent="space-between">
                        <Box gap={1}>
                          <Text color={isCur ? 'cyan' : 'gray'} bold={isCur}>
                            {isCur ? '❯' : ' '}
                          </Text>
                          <Text bold color={isCur ? 'cyan' : 'white'}>
                            {opt.title}
                          </Text>
                        </Box>
                        {isActive ? (
                          <Text color="green" bold>
                            ● Activo
                          </Text>
                        ) : null}
                      </Box>
                      <Box marginLeft={2}>
                        <Text dimColor>{opt.description}</Text>
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* Bottom bar */}
      <FooterBar items={footerItems} />
    </Box>
  );
}
