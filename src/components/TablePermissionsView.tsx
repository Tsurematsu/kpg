import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { FooterBar } from './FooterBar.js';
import { Spinner } from './Spinner.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  TABLE_PRIVILEGE_OPTIONS,
  listDbUsers,
  listUserTablePermissions,
  updateUserTablePermissions,
  type DbUserInfo,
  type TablePrivilegeKey,
  type UserTableAccessInfo,
} from '../services/access.js';
import type { ClusterDBInfo } from '../types/k8s.js';

interface TablePermissionsViewProps {
  db: ClusterDBInfo;
  initialUser: DbUserInfo | null;
  onBack: () => void;
  onExit: () => void;
}

type Mode =
  | { type: 'pick_user' }
  | { type: 'tables'; user: DbUserInfo }
  | {
      type: 'edit_table';
      user: DbUserInfo;
      table: UserTableAccessInfo;
      selected: TablePrivilegeKey[];
      cursor: number;
      saving: boolean;
    };

function padCell(value: string, width: number): string {
  if (value.length >= width) {
    return width > 1 ? `${value.slice(0, width - 1)}…` : value.slice(0, width);
  }
  return value.padEnd(width, ' ');
}

export function TablePermissionsView({
  db,
  initialUser,
  onBack,
  onExit,
}: TablePermissionsViewProps) {
  const { rows: termHeight } = useTerminalSize();

  const [mode, setMode] = useState<Mode>(() =>
    initialUser ? { type: 'tables', user: initialUser } : { type: 'pick_user' },
  );
  const [users, setUsers] = useState<DbUserInfo[]>([]);
  const [userIdx, setUserIdx] = useState(0);
  const [tables, setTables] = useState<UserTableAccessInfo[]>([]);
  const [tableIdx, setTableIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [quickSaving, setQuickSaving] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const list = await listDbUsers(db);
      const editable = list.filter((u) => !u.isSystem);
      setUsers(editable);
      setUserIdx((prev) =>
        editable.length === 0 ? 0 : Math.min(prev, editable.length - 1),
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [db]);

  const loadUserTables = useCallback(
    async (username: string) => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const list = await listUserTablePermissions(db, username);
        setTables(list);
        setTableIdx((prev) =>
          list.length === 0 ? 0 : Math.min(prev, list.length - 1),
        );
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [db],
  );

  useEffect(() => {
    if (mode.type === 'pick_user') {
      void loadUsers();
    } else if (mode.type === 'tables') {
      void loadUserTables(mode.user.name);
    }
  }, [mode.type === 'pick_user' ? 'pick' : mode.user.name, loadUsers, loadUserTables]);

  const selectedPickUser = users[userIdx] ?? null;
  const selectedTable = tables[tableIdx] ?? null;

  useInput((input, key) => {
    if (quickSaving) return;
    const lower = input.toLowerCase();

    if (mode.type === 'pick_user') {
      if (key.escape) {
        onBack();
        return;
      }
      if (lower === 'q') {
        onExit();
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
      if (key.return && selectedPickUser) {
        setStatusNote(null);
        setErrorMsg(null);
        setTableIdx(0);
        setMode({ type: 'tables', user: selectedPickUser });
      }
      return;
    }

    if (mode.type === 'tables') {
      if (key.escape) {
        if (!initialUser) {
          setStatusNote(null);
          setErrorMsg(null);
          setMode({ type: 'pick_user' });
        } else {
          onBack();
        }
        return;
      }
      if (lower === 'q') {
        onExit();
        return;
      }
      if (lower === 'u') {
        void loadUserTables(mode.user.name);
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
      if ((key.return || lower === 'e' || input === ' ') && selectedTable) {
        setErrorMsg(null);
        setStatusNote(null);
        setMode({
          type: 'edit_table',
          user: mode.user,
          table: selectedTable,
          selected: [...selectedTable.privileges],
          cursor: 0,
          saving: false,
        });
        return;
      }
      if (lower === 'a' && selectedTable) {
        setQuickSaving(true);
        setErrorMsg(null);
        const allPrivs: TablePrivilegeKey[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
        void updateUserTablePermissions(
          db,
          mode.user.name,
          selectedTable.schema,
          selectedTable.tableName,
          allPrivs,
        )
          .then(async () => {
            setStatusNote(
              `✔ Acceso completo otorgado a "${mode.user.name}" sobre ${selectedTable.schema}.${selectedTable.tableName}.`,
            );
            await loadUserTables(mode.user.name);
          })
          .catch((err) => {
            setErrorMsg(err instanceof Error ? err.message : String(err));
          })
          .finally(() => setQuickSaving(false));
        return;
      }
      if (lower === 'd' && selectedTable) {
        setQuickSaving(true);
        setErrorMsg(null);
        void updateUserTablePermissions(
          db,
          mode.user.name,
          selectedTable.schema,
          selectedTable.tableName,
          [],
        )
          .then(async () => {
            setStatusNote(
              `✔ Acceso revocado a "${mode.user.name}" sobre ${selectedTable.schema}.${selectedTable.tableName}.`,
            );
            await loadUserTables(mode.user.name);
          })
          .catch((err) => {
            setErrorMsg(err instanceof Error ? err.message : String(err));
          })
          .finally(() => setQuickSaving(false));
      }
      return;
    }

    if (mode.type === 'edit_table') {
      if (mode.saving) return;
      if (key.escape) {
        setMode({ type: 'tables', user: mode.user });
        return;
      }
      if (key.upArrow || lower === 'k') {
        setMode((prev) =>
          prev.type === 'edit_table'
            ? {
                ...prev,
                cursor:
                  prev.cursor > 0
                    ? prev.cursor - 1
                    : TABLE_PRIVILEGE_OPTIONS.length - 1,
              }
            : prev,
        );
        return;
      }
      if (key.downArrow || lower === 'j') {
        setMode((prev) =>
          prev.type === 'edit_table'
            ? {
                ...prev,
                cursor:
                  prev.cursor < TABLE_PRIVILEGE_OPTIONS.length - 1
                    ? prev.cursor + 1
                    : 0,
              }
            : prev,
        );
        return;
      }
      if (input === ' ') {
        const opt = TABLE_PRIVILEGE_OPTIONS[mode.cursor];
        if (!opt) return;
        setMode((prev) => {
          if (prev.type !== 'edit_table') return prev;
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
      if (lower === 'a') {
        setMode((prev) =>
          prev.type === 'edit_table'
            ? { ...prev, selected: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] }
            : prev,
        );
        return;
      }
      if (lower === 'n') {
        setMode((prev) =>
          prev.type === 'edit_table' ? { ...prev, selected: [] } : prev,
        );
        return;
      }
      if (key.return) {
        const { user, table, selected } = mode;
        setMode({ ...mode, saving: true });
        void updateUserTablePermissions(
          db,
          user.name,
          table.schema,
          table.tableName,
          selected,
        )
          .then(async () => {
            setStatusNote(
              `✔ Permisos de "${user.name}" en ${table.schema}.${table.tableName}: ${selected.join(', ') || 'sin acceso'}.`,
            );
            setMode({ type: 'tables', user });
            await loadUserTables(user.name);
          })
          .catch((err) => {
            setErrorMsg(err instanceof Error ? err.message : String(err));
            setMode({ type: 'tables', user });
          });
      }
    }
  });

  const footerItems = useMemo(() => {
    if (mode.type === 'pick_user') {
      return [
        { key: '↑/↓', label: 'Elegir usuario' },
        { key: 'Enter', label: 'Configurar tablas', accent: 'green', disabled: !selectedPickUser },
        { key: 'u', label: 'Refrescar' },
        { key: 'Esc', label: 'Atrás' },
        { key: 'Q', label: 'Salir', accent: 'red' },
      ];
    }
    if (mode.type === 'edit_table') {
      return [
        { key: '↑/↓', label: 'Mover' },
        { key: 'Espacio', label: 'Marcar/Desmarcar', accent: 'yellow' },
        { key: 'a', label: 'Todos', accent: 'green' },
        { key: 'n', label: 'Ninguno', accent: 'red' },
        { key: 'Enter', label: 'Guardar', accent: 'green' },
        { key: 'Esc', label: 'Cancelar' },
      ];
    }
    return [
      { key: 'Enter/e', label: 'Elegir permisos', accent: 'cyan', disabled: !selectedTable },
      { key: 'a', label: 'Dar todo acceso', accent: 'green', disabled: !selectedTable },
      { key: 'd', label: 'Quitar acceso', accent: 'red', disabled: !selectedTable },
      { key: 'u', label: 'Refrescar' },
      { key: 'Esc', label: 'Atrás' },
      { key: 'Q', label: 'Salir', accent: 'red' },
    ];
  }, [mode.type, selectedPickUser, selectedTable]);

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
            Permisos por tabla
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
        {db.hibernated ? (
          <Box borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text color="yellow">
              ⚠ La BD &quot;{db.name}&quot; está apagada (hibernada). Enciéndela desde el menú principal con (p) para gestionar permisos en PostgreSQL.
            </Text>
          </Box>
        ) : null}

        {statusNote ? <Text color="green">{statusNote}</Text> : null}
        {errorMsg ? (
          <Box borderStyle="round" borderColor="red" paddingX={1}>
            <Text color="red">✖ {errorMsg}</Text>
          </Box>
        ) : null}

        {/* PICK USER */}
        {mode.type === 'pick_user' && (
          <Box flexDirection="column" gap={1}>
            <Text bold>
              Selecciona el usuario para ajustar sus permisos por tabla específica:
            </Text>
            {loading ? (
              <Box gap={1}>
                <Spinner />
                <Text>Consultando usuarios en PostgreSQL...</Text>
              </Box>
            ) : users.length === 0 ? (
              <Text dimColor>
                No hay usuarios editables en &quot;{db.name}&quot;. Crea uno primero en &quot;Usuarios y permisos&quot;.
              </Text>
            ) : (
              <Box flexDirection="column">
                <Text bold dimColor>
                  {'  '}
                  {padCell('USUARIO', 24)}
                  {padCell('TABLAS', 14)}
                  {'PERMISOS GENERALES'}
                </Text>
                <Text dimColor>{'─'.repeat(78)}</Text>
                {users.map((u, idx) => {
                  const sel = idx === userIdx;
                  const tabSummary = `${u.tableAccessCount}/${u.totalTablesCount}`;
                  return (
                    <Box key={u.name}>
                      <Text
                        color={sel ? 'cyan' : undefined}
                        bold={sel}
                        inverse={sel}
                      >
                        {sel ? '❯ ' : '  '}
                        {padCell(u.name, 24)}
                        {padCell(tabSummary, 14)}
                        {u.permissions.join(', ') || 'sin permisos'}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
            )}
          </Box>
        )}

        {/* USER TABLES LIST */}
        {mode.type === 'tables' && (
          <Box flexDirection="column" gap={1}>
            <Box justifyContent="space-between">
              <Text bold>
                Acceso por tabla para usuario{' '}
                <Text color="cyan">{mode.user.name}</Text> (base &quot;app&quot;)
              </Text>
              <Text dimColor>Total tablas: {tables.length}</Text>
            </Box>

            {mode.user.isSuperuser ? (
              <Box borderStyle="round" borderColor="yellow" paddingX={1}>
                <Text color="yellow">
                  ⚠ &quot;{mode.user.name}&quot; tiene rol SUPERUSER: PostgreSQL siempre le otorga acceso total aunque revoques permisos de tabla.
                </Text>
              </Box>
            ) : null}

            {loading || quickSaving ? (
              <Box gap={1}>
                <Spinner />
                <Text>
                  {quickSaving
                    ? 'Aplicando permisos sobre la tabla...'
                    : 'Consultando permisos de tablas en PostgreSQL...'}
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
                  {padCell('TABLA', 26)}
                  {padCell('OWNER', 14)}
                  {'PRIVILEGIOS ACTUALES'}
                </Text>
                <Text dimColor>{'─'.repeat(84)}</Text>
                {tables.map((t, idx) => {
                  const sel = idx === tableIdx;
                  const hasAny = t.privileges.length > 0;
                  const privText = hasAny
                    ? t.privileges.join(', ')
                    : 'sin acceso';
                  return (
                    <Box key={`${t.schema}.${t.tableName}`}>
                      <Text
                        color={sel ? 'cyan' : undefined}
                        bold={sel}
                        inverse={sel}
                      >
                        {sel ? '❯ ' : '  '}
                        {padCell(t.schema, 14)}
                        {padCell(t.tableName, 26)}
                        {padCell(t.owner, 14)}
                      </Text>
                      <Text
                        color={
                          sel ? 'cyan' : hasAny ? 'green' : 'gray'
                        }
                        bold={sel}
                        inverse={sel}
                      >
                        {privText}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
            )}

            <Text dimColor>
              Tip: Para restringir un usuario a solo ciertas tablas, deja solo LOGIN en permisos globales y activa aquí las tablas deseadas.
            </Text>
          </Box>
        )}

        {/* EDIT SPECIFIC TABLE PRIVILEGES */}
        {mode.type === 'edit_table' && (
          <Box flexDirection="column" gap={1}>
            <Text bold color="yellow">
              Permisos de &quot;{mode.user.name}&quot; sobre{' '}
              <Text color="cyan">
                {mode.table.schema}.{mode.table.tableName}
              </Text>{' '}
              (multi-selección)
            </Text>

            {mode.saving ? (
              <Box gap={1}>
                <Spinner color="yellow" />
                <Text>Aplicando permisos sobre {mode.table.schema}.{mode.table.tableName}...</Text>
              </Box>
            ) : (
              <Box flexDirection="column">
                {TABLE_PRIVILEGE_OPTIONS.map((opt, idx) => {
                  const isCur = idx === mode.cursor;
                  const checked = mode.selected.includes(opt.key);
                  return (
                    <Box key={opt.key} gap={1}>
                      <Text color={isCur ? 'cyan' : 'gray'}>
                        {isCur ? '❯' : ' '}
                      </Text>
                      <Text color={checked ? 'green' : 'gray'} bold={checked}>
                        {checked ? '[✔]' : '[ ]'}
                      </Text>
                      <Text color={isCur ? 'cyan' : 'white'} bold={isCur}>
                        {padCell(opt.label, 24)}
                      </Text>
                      <Text dimColor>{opt.description}</Text>
                    </Box>
                  );
                })}
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* Footer */}
      <FooterBar items={footerItems} />
    </Box>
  );
}
