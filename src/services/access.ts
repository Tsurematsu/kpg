import crypto from 'node:crypto';
import * as yaml from 'js-yaml';
import { runKubectl, runKubectlJson } from './kubectl.js';
import type { ClusterDBInfo } from '../types/k8s.js';

export type TlsPolicyMode = 'optional' | 'disabled' | 'required';

export type PermissionKey =
  | 'LOGIN'
  | 'READ'
  | 'WRITE'
  | 'DDL'
  | 'CREATEDB'
  | 'CREATEROLE'
  | 'SUPERUSER';

export interface PermissionOption {
  key: PermissionKey;
  label: string;
  description: string;
}

export const PERMISSION_OPTIONS: PermissionOption[] = [
  {
    key: 'LOGIN',
    label: 'LOGIN',
    description: 'Permitir iniciar sesión en PostgreSQL',
  },
  {
    key: 'READ',
    label: 'READ (SELECT)',
    description: 'Lectura sobre schema public y todas las tablas de app',
  },
  {
    key: 'WRITE',
    label: 'WRITE (INSERT/UPDATE/DELETE)',
    description: 'Escritura en tablas y secuencias de app',
  },
  {
    key: 'DDL',
    label: 'DDL (CREATE)',
    description: 'Crear y modificar objetos/tablas en schema public',
  },
  {
    key: 'CREATEDB',
    label: 'CREATEDB',
    description: 'Crear nuevas bases de datos',
  },
  {
    key: 'CREATEROLE',
    label: 'CREATEROLE',
    description: 'Crear y gestionar otros roles',
  },
  {
    key: 'SUPERUSER',
    label: 'SUPERUSER',
    description: 'Acceso administrativo total en PostgreSQL',
  },
];

export const PROTECTED_SYSTEM_ROLES = new Set([
  'postgres',
  'streaming_replica',
  'cnpg_pooler_pgbouncer',
  'cnpg_metrics_exporter',
]);

export interface DbUserInfo {
  name: string;
  isSystem: boolean;
  permissions: PermissionKey[];
  canLogin: boolean;
  isSuperuser: boolean;
  tableAccessCount: number;
  totalTablesCount: number;
}

export type TablePrivilegeKey = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface TablePrivilegeOption {
  key: TablePrivilegeKey;
  label: string;
  description: string;
}

export const TABLE_PRIVILEGE_OPTIONS: TablePrivilegeOption[] = [
  {
    key: 'SELECT',
    label: 'SELECT (Lectura)',
    description: 'Consultar filas de esta tabla específica',
  },
  {
    key: 'INSERT',
    label: 'INSERT (Insertar)',
    description: 'Agregar filas (incluye secuencias SERIAL/IDENTITY de la tabla)',
  },
  {
    key: 'UPDATE',
    label: 'UPDATE (Actualizar)',
    description: 'Modificar filas existentes (incluye secuencias)',
  },
  {
    key: 'DELETE',
    label: 'DELETE (Eliminar)',
    description: 'Eliminar filas de esta tabla específica',
  },
];

export interface UserTableAccessInfo {
  schema: string;
  tableName: string;
  owner: string;
  privileges: TablePrivilegeKey[];
}

export interface NodePortUserCredential {
  username: string;
  password: string | null;
  source: 'cnpg' | 'kpg' | 'none';
  canLogin: boolean;
  isSystem: boolean;
  permissions: PermissionKey[];
}

export interface DbTableInfo {
  schema: string;
  name: string;
  owner: string;
  rowEstimate: number;
  totalSize: string;
}

export interface DbColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string;
}

export interface NodePortInfo {
  serviceName: string;
  namespace: string;
  nodePort: number;
  targetPort: number;
  hostIp: string;
  labelId: string;
  appPassword: string | null;
  tlsMode: TlsPolicyMode;
  urlMasked: string;
  urlFull: string;
}

const VALID_PG_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const FIELD_SEP = '\x1f';

export function validatePgIdentifier(name: string): string | null {
  if (!name) return 'El nombre no puede estar vacío.';
  if (!VALID_PG_IDENT.test(name)) {
    return 'Usa solo minúsculas, números y guion bajo, iniciando por letra o "_" (ej: api_user).';
  }
  return null;
}

function escapeSqlLiteral(val: string): string {
  return `'${val.replace(/'/g, "''")}'`;
}

function quotePgIdent(ident: string): string {
  if (!VALID_PG_IDENT.test(ident)) {
    throw new Error(`Identificador PostgreSQL inválido: "${ident}".`);
  }
  return `"${ident}"`;
}

function quotePgObjectIdent(ident: string): string {
  if (!ident || /[\x00-\x1f\x7f]/.test(ident)) {
    throw new Error(`Nombre de objeto PostgreSQL inválido: "${ident}".`);
  }
  return `"${ident.replace(/"/g, '""')}"`;
}

export function generateRandomPassword(length = 20): string {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export async function runPsql(
  db: ClusterDBInfo,
  sql: string,
  database = 'app',
): Promise<string> {
  const res = await runKubectl(
    [
      'cnpg',
      'psql',
      db.name,
      '-n',
      db.namespace,
      '--',
      '-U',
      'postgres',
      '-d',
      database,
      '-X',
      '-q',
      '-t',
      '-A',
      '-F',
      FIELD_SEP,
      '-P',
      'pager=off',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { timeoutMs: 20000 },
  );

  if (res.code !== 0) {
    throw new Error(
      res.stderr.trim() ||
        res.stdout.trim() ||
        'Error ejecutando consulta interna vía kubectl cnpg psql.',
    );
  }

  return res.stdout;
}

export async function listDbUsers(db: ClusterDBInfo): Promise<DbUserInfo[]> {
  const sql = `
WITH user_tables AS (
  SELECT schemaname, tablename
  FROM pg_catalog.pg_tables
  WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
)
SELECT
  r.rolname,
  r.rolcanlogin,
  r.rolsuper,
  r.rolcreatedb,
  r.rolcreaterole,
  has_schema_privilege(r.oid, 'public', 'USAGE') AS has_usage,
  has_schema_privilege(r.oid, 'public', 'CREATE') AS has_create,
  EXISTS (
    SELECT 1 FROM information_schema.role_table_grants g
    WHERE g.grantee = r.rolname AND g.table_schema = 'public' AND g.privilege_type = 'SELECT'
  ) AS has_select,
  EXISTS (
    SELECT 1 FROM information_schema.role_table_grants g
    WHERE g.grantee = r.rolname AND g.table_schema = 'public' AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  ) AS has_write,
  EXISTS (
    SELECT 1 FROM pg_default_acl d
    WHERE d.defaclobjtype = 'r'
      AND d.defaclacl::text LIKE '%' || r.rolname || '=r%'
  ) AS def_select,
  EXISTS (
    SELECT 1 FROM pg_default_acl d
    WHERE d.defaclobjtype = 'r'
      AND (d.defaclacl::text LIKE '%' || r.rolname || '=%a%' OR d.defaclacl::text LIKE '%' || r.rolname || '=%w%')
  ) AS def_write,
  (SELECT count(*) FROM user_tables) AS total_tables,
  (
    SELECT count(*) FROM user_tables ut
    WHERE has_table_privilege(r.oid, format('%I.%I', ut.schemaname, ut.tablename), 'SELECT')
       OR has_table_privilege(r.oid, format('%I.%I', ut.schemaname, ut.tablename), 'INSERT')
       OR has_table_privilege(r.oid, format('%I.%I', ut.schemaname, ut.tablename), 'UPDATE')
       OR has_table_privilege(r.oid, format('%I.%I', ut.schemaname, ut.tablename), 'DELETE')
  ) AS accessible_tables
FROM pg_roles r
WHERE r.rolname NOT LIKE 'pg\\_%' ESCAPE '\\'
ORDER BY r.rolsuper DESC, r.rolname ASC;
`;

  const out = await runPsql(db, sql, 'app');
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const cols = line.split(FIELD_SEP);
    const name = cols[0] ?? '';
    const canLogin = cols[1] === 't';
    const isSuperuser = cols[2] === 't';
    const createdb = cols[3] === 't';
    const createrole = cols[4] === 't';
    const hasUsage = cols[5] === 't';
    const hasCreate = cols[6] === 't';
    const hasSelect = cols[7] === 't' || cols[9] === 't';
    const hasWrite = cols[8] === 't' || cols[10] === 't';
    const totalTablesCount = Number.parseInt(cols[11] || '0', 10) || 0;
    const tableAccessCount = Number.parseInt(cols[12] || '0', 10) || 0;

    const perms: PermissionKey[] = [];
    if (canLogin) perms.push('LOGIN');
    if (isSuperuser || (hasUsage && hasSelect)) perms.push('READ');
    if (isSuperuser || (hasUsage && hasWrite)) perms.push('WRITE');
    if (isSuperuser || hasCreate) perms.push('DDL');
    if (createdb) perms.push('CREATEDB');
    if (createrole) perms.push('CREATEROLE');
    if (isSuperuser) perms.push('SUPERUSER');

    return {
      name,
      isSystem: PROTECTED_SYSTEM_ROLES.has(name),
      permissions: perms,
      canLogin,
      isSuperuser,
      tableAccessCount,
      totalTablesCount,
    };
  });
}

function buildPermissionsSql(username: string, permissions: PermissionKey[]): string {
  const qUser = quotePgIdent(username);
  const set = new Set(permissions);

  const roleAttrs = [
    set.has('LOGIN') ? 'LOGIN' : 'NOLOGIN',
    set.has('SUPERUSER') ? 'SUPERUSER' : 'NOSUPERUSER',
    set.has('CREATEDB') ? 'CREATEDB' : 'NOCREATEDB',
    set.has('CREATEROLE') ? 'CREATEROLE' : 'NOCREATEROLE',
  ].join(' ');

  const statements: string[] = [
    `ALTER ROLE ${qUser} WITH ${roleAttrs};`,
    `REVOKE ALL PRIVILEGES ON DATABASE app FROM ${qUser};`,
    `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${qUser};`,
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${qUser};`,
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${qUser};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${qUser};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${qUser};`,
  ];

  if (set.has('LOGIN') || set.has('READ') || set.has('WRITE') || set.has('DDL')) {
    statements.push(`GRANT CONNECT ON DATABASE app TO ${qUser};`);
  }

  if (set.has('READ') || set.has('WRITE') || set.has('DDL')) {
    statements.push(`GRANT USAGE ON SCHEMA public TO ${qUser};`);
  }

  if (set.has('READ')) {
    statements.push(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${qUser};`);
    statements.push(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${qUser};`);
    statements.push(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${qUser};`,
    );
    statements.push(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO ${qUser};`,
    );
  }

  if (set.has('WRITE')) {
    statements.push(
      `GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${qUser};`,
    );
    statements.push(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${qUser};`,
    );
    statements.push(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT, UPDATE, DELETE ON TABLES TO ${qUser};`,
    );
    statements.push(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${qUser};`,
    );
  }

  if (set.has('DDL')) {
    statements.push(`GRANT CREATE ON SCHEMA public TO ${qUser};`);
  }

  return statements.join('\n');
}

export async function createDbUser(
  db: ClusterDBInfo,
  username: string,
  password: string,
  permissions: PermissionKey[],
): Promise<void> {
  const err = validatePgIdentifier(username);
  if (err) throw new Error(err);
  if (PROTECTED_SYSTEM_ROLES.has(username)) {
    throw new Error(`"${username}" es un rol reservado del sistema.`);
  }

  const qUser = quotePgIdent(username);
  const createSql = `CREATE ROLE ${qUser} WITH LOGIN PASSWORD ${escapeSqlLiteral(password)};`;
  const permsSql = buildPermissionsSql(username, permissions);
  await runPsql(db, `${createSql}\n${permsSql}`, 'app');
  await saveKpgUserPassword(db, username, password);
}

export async function updateDbUserPermissions(
  db: ClusterDBInfo,
  username: string,
  permissions: PermissionKey[],
): Promise<void> {
  if (PROTECTED_SYSTEM_ROLES.has(username)) {
    throw new Error(`No se pueden modificar permisos del rol de sistema "${username}".`);
  }
  const sql = buildPermissionsSql(username, permissions);
  await runPsql(db, sql, 'app');
}

export async function updateDbUserPassword(
  db: ClusterDBInfo,
  username: string,
  newPassword: string,
): Promise<void> {
  if (PROTECTED_SYSTEM_ROLES.has(username)) {
    throw new Error(
      `No se puede modificar la contraseña del rol de sistema "${username}".`,
    );
  }
  const trimmed = newPassword.trim();
  if (!trimmed) {
    throw new Error('La contraseña no puede estar vacía.');
  }

  const qUser = quotePgIdent(username);
  await runPsql(
    db,
    `ALTER ROLE ${qUser} WITH PASSWORD ${escapeSqlLiteral(trimmed)};`,
    'app',
  );

  await saveKpgUserPassword(db, username, trimmed);

  // If rotating the default CNPG "app" user password, also keep <cluster>-app Secret in sync if present
  if (username === 'app') {
    const b64 = Buffer.from(trimmed, 'utf8').toString('base64');
    await runKubectl(
      [
        'patch',
        'secret',
        `${db.name}-app`,
        '-n',
        db.namespace,
        '--type=merge',
        '-p',
        JSON.stringify({ data: { password: b64 } }),
      ],
      { timeoutMs: 10000 },
    ).catch(() => {
      // Best-effort sync with CNPG app secret
    });
  }
}

export async function deleteDbUser(
  db: ClusterDBInfo,
  username: string,
): Promise<void> {
  if (PROTECTED_SYSTEM_ROLES.has(username)) {
    throw new Error(`No se puede eliminar el rol de sistema "${username}".`);
  }
  const qUser = quotePgIdent(username);
  const sql = `
REVOKE ALL PRIVILEGES ON DATABASE app FROM ${qUser};
REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${qUser};
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${qUser};
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${qUser};
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${qUser};
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${qUser};
REASSIGN OWNED BY ${qUser} TO postgres;
DROP ROLE ${qUser};
`;
  await runPsql(db, sql, 'app');
  await removeKpgUserPassword(db, username).catch(() => {
    // Best-effort cleanup of stored credential
  });
}

// ── Per-Table Permissions ────────────────────────────────────────────────────

export async function listUserTablePermissions(
  db: ClusterDBInfo,
  username: string,
): Promise<UserTableAccessInfo[]> {
  const err = validatePgIdentifier(username);
  if (err) throw new Error(err);

  const uLit = escapeSqlLiteral(username);
  const sql = `
SELECT
  t.schemaname,
  t.tablename,
  t.tableowner,
  has_table_privilege(${uLit}, format('%I.%I', t.schemaname, t.tablename), 'SELECT') AS can_select,
  has_table_privilege(${uLit}, format('%I.%I', t.schemaname, t.tablename), 'INSERT') AS can_insert,
  has_table_privilege(${uLit}, format('%I.%I', t.schemaname, t.tablename), 'UPDATE') AS can_update,
  has_table_privilege(${uLit}, format('%I.%I', t.schemaname, t.tablename), 'DELETE') AS can_delete
FROM pg_catalog.pg_tables t
WHERE t.schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY t.schemaname ASC, t.tablename ASC;
`;

  const out = await runPsql(db, sql, 'app');
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const [schema, tableName, owner, sel, ins, upd, del] = line.split(FIELD_SEP);
    const privileges: TablePrivilegeKey[] = [];
    if (sel === 't') privileges.push('SELECT');
    if (ins === 't') privileges.push('INSERT');
    if (upd === 't') privileges.push('UPDATE');
    if (del === 't') privileges.push('DELETE');

    return {
      schema: schema || 'public',
      tableName: tableName || '',
      owner: owner || '',
      privileges,
    };
  });
}

export async function updateUserTablePermissions(
  db: ClusterDBInfo,
  username: string,
  schema: string,
  tableName: string,
  privileges: TablePrivilegeKey[],
): Promise<void> {
  if (PROTECTED_SYSTEM_ROLES.has(username)) {
    throw new Error(
      `No se pueden modificar permisos de tabla del rol de sistema "${username}".`,
    );
  }
  const qUser = quotePgIdent(username);
  const qSchema = quotePgObjectIdent(schema);
  const qTable = quotePgObjectIdent(tableName);

  const validSet = new Set<TablePrivilegeKey>(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
  const cleanPrivs = privileges.filter((p) => validSet.has(p));

  const statements: string[] = [
    'BEGIN;',
    `REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE ${qSchema}.${qTable} FROM ${qUser};`,
  ];

  if (cleanPrivs.length > 0) {
    statements.push(`GRANT CONNECT ON DATABASE app TO ${qUser};`);
    statements.push(`GRANT USAGE ON SCHEMA ${qSchema} TO ${qUser};`);
    statements.push(
      `GRANT ${cleanPrivs.join(', ')} ON TABLE ${qSchema}.${qTable} TO ${qUser};`,
    );

    if (cleanPrivs.includes('INSERT') || cleanPrivs.includes('UPDATE')) {
      statements.push(`
DO $$
DECLARE
  seq_rec RECORD;
BEGIN
  FOR seq_rec IN
    SELECT pg_get_serial_sequence(format('%I.%I', ${escapeSqlLiteral(schema)}, ${escapeSqlLiteral(tableName)}), a.attname) AS seq_name
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${escapeSqlLiteral(schema)}
      AND c.relname = ${escapeSqlLiteral(tableName)}
      AND a.attnum > 0
      AND NOT a.attisdropped
  LOOP
    IF seq_rec.seq_name IS NOT NULL THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO %I', seq_rec.seq_name, ${escapeSqlLiteral(username)});
    END IF;
  END LOOP;
END $$;`);
    }
  }

  statements.push('COMMIT;');
  await runPsql(db, statements.join('\n'), 'app');
}

export async function listDbTables(db: ClusterDBInfo): Promise<DbTableInfo[]> {
  const sql = `
SELECT
  t.schemaname,
  t.tablename,
  t.tableowner,
  COALESCE(s.n_live_tup, 0) AS row_est,
  pg_size_pretty(pg_total_relation_size(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))) AS total_size
FROM pg_catalog.pg_tables t
LEFT JOIN pg_stat_user_tables s
  ON s.schemaname = t.schemaname AND s.relname = t.tablename
WHERE t.schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY t.schemaname ASC, t.tablename ASC;
`;

  const out = await runPsql(db, sql, 'app');
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const [schema, name, owner, rowsStr, totalSize] = line.split(FIELD_SEP);
    return {
      schema: schema || 'public',
      name: name || '',
      owner: owner || '',
      rowEstimate: Number.parseInt(rowsStr || '0', 10) || 0,
      totalSize: totalSize || '0 bytes',
    };
  });
}

export async function getTableColumns(
  db: ClusterDBInfo,
  schema: string,
  tableName: string,
): Promise<DbColumnInfo[]> {
  const sql = `
SELECT
  column_name,
  data_type,
  is_nullable,
  COALESCE(column_default, '')
FROM information_schema.columns
WHERE table_schema = ${escapeSqlLiteral(schema)}
  AND table_name = ${escapeSqlLiteral(tableName)}
ORDER BY ordinal_position ASC;
`;
  const out = await runPsql(db, sql, 'app');
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const [name, dataType, nullable, defaultValue] = line.split(FIELD_SEP);
    return {
      name: name || '',
      dataType: dataType || '',
      nullable: nullable === 'YES',
      defaultValue: defaultValue || '',
    };
  });
}

// ── TLS Policy (spec.postgresql.pg_hba) ──────────────────────────────────────

const HBA_DISABLE_TLS = [
  'hostnossl all all all scram-sha-256',
  'hostssl all all all reject',
];

const HBA_REQUIRE_TLS = [
  'hostssl all all all scram-sha-256',
  'hostnossl all all all reject',
];

interface RawClusterSpec {
  spec?: {
    postgresql?: {
      pg_hba?: string[];
    };
  };
}

export async function getTlsPolicy(db: ClusterDBInfo): Promise<TlsPolicyMode> {
  const raw = await runKubectlJson<RawClusterSpec>([
    'get',
    'cluster.postgresql.cnpg.io',
    db.name,
    '-n',
    db.namespace,
  ]);
  const rules = raw.spec?.postgresql?.pg_hba ?? [];
  const joined = rules.join('\n').toLowerCase();

  if (
    joined.includes('hostnossl all all all scram-sha-256') &&
    joined.includes('hostssl all all all reject')
  ) {
    return 'disabled';
  }
  if (
    joined.includes('hostssl all all all scram-sha-256') &&
    joined.includes('hostnossl all all all reject')
  ) {
    return 'required';
  }
  return 'optional';
}

export async function setTlsPolicy(
  db: ClusterDBInfo,
  mode: TlsPolicyMode,
): Promise<void> {
  const pgHba =
    mode === 'disabled'
      ? HBA_DISABLE_TLS
      : mode === 'required'
        ? HBA_REQUIRE_TLS
        : null;

  const patchObj = {
    spec: {
      postgresql: {
        pg_hba: pgHba,
      },
    },
  };

  const res = await runKubectl(
    [
      'patch',
      'cluster.postgresql.cnpg.io',
      db.name,
      '-n',
      db.namespace,
      '--type=merge',
      '-p',
      JSON.stringify(patchObj),
    ],
    { timeoutMs: 20000 },
  );

  if (res.code !== 0) {
    throw new Error(
      res.stderr.trim() ||
        res.stdout.trim() ||
        'No se pudo actualizar la política TLS (pg_hba).',
    );
  }
}

// ── NodePort Stable Access ───────────────────────────────────────────────────

interface RawService {
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
  };
  spec?: {
    type?: string;
    selector?: Record<string, string>;
    ports?: Array<{
      port?: number;
      targetPort?: number | string;
      nodePort?: number;
    }>;
  };
}

interface RawServiceList {
  items: RawService[];
}

function sanitizeK8sLabelToken(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.slice(0, 32) || 'db';
}

function getStableLabelToken(db: ClusterDBInfo): string {
  if (db.labelId?.shortId) {
    return sanitizeK8sLabelToken(db.labelId.shortId);
  }
  return sanitizeK8sLabelToken(db.name);
}

export function extractHostFromServerUrl(
  serverUrl: string,
  fallbackIp: string,
): string {
  try {
    const parsed = new URL(serverUrl);
    if (parsed.hostname && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      return parsed.hostname;
    }
  } catch {
    // fallback below
  }
  return fallbackIp || '127.0.0.1';
}

// ── Stored User Credentials (CNPG Secrets + kpg-creds-<cluster>) ─────────────

interface RawSecret {
  metadata?: {
    name?: string;
    namespace?: string;
  };
  data?: Record<string, string>;
}

export function getKpgCredentialsSecretName(dbName: string): string {
  return sanitizeK8sLabelToken(`kpg-creds-${dbName}`);
}

async function getRawSecretData(
  secretName: string,
  namespace: string,
): Promise<Record<string, string> | null> {
  const res = await runKubectl(
    ['get', 'secret', secretName, '-n', namespace, '-o', 'json'],
    { timeoutMs: 10000 },
  );
  if (res.code !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as RawSecret;
    const decoded: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.data ?? {})) {
      try {
        decoded[k] = Buffer.from(v, 'base64').toString('utf8');
      } catch {
        // skip invalid base64 entry
      }
    }
    return decoded;
  } catch {
    return null;
  }
}

export async function getKpgCredentialsSecret(
  db: ClusterDBInfo,
): Promise<Record<string, string>> {
  const secretName = getKpgCredentialsSecretName(db.name);
  const data = await getRawSecretData(secretName, db.namespace);
  return data ?? {};
}

export async function saveKpgUserPassword(
  db: ClusterDBInfo,
  username: string,
  password: string,
): Promise<void> {
  const secretName = getKpgCredentialsSecretName(db.name);
  const existing = await getKpgCredentialsSecret(db);
  const nextPlain: Record<string, string> = {
    ...existing,
    [username]: password,
  };

  const encodedData: Record<string, string> = {};
  for (const [k, v] of Object.entries(nextPlain)) {
    encodedData[k] = Buffer.from(v, 'utf8').toString('base64');
  }

  const secretManifest = {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: secretName,
      namespace: db.namespace,
      labels: {
        'kpg.io/managed': 'true',
        'kpg.io/cluster': db.name,
        'kpg.io/type': 'credentials',
      },
    },
    data: encodedData,
  };

  const secretYaml = yaml.dump(secretManifest, { lineWidth: -1, noRefs: true });
  const res = await runKubectl(['apply', '-f', '-'], {
    stdin: secretYaml,
    timeoutMs: 15000,
  });

  if (res.code !== 0) {
    throw new Error(
      res.stderr.trim() ||
        res.stdout.trim() ||
        `No se pudo guardar la contraseña en el Secret ${secretName}.`,
    );
  }
}

export async function removeKpgUserPassword(
  db: ClusterDBInfo,
  username: string,
): Promise<void> {
  const secretName = getKpgCredentialsSecretName(db.name);
  const existing = await getRawSecretData(secretName, db.namespace);
  if (!existing || !(username in existing)) return;

  delete existing[username];
  const encodedData: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing)) {
    encodedData[k] = Buffer.from(v, 'utf8').toString('base64');
  }

  const secretManifest = {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: secretName,
      namespace: db.namespace,
      labels: {
        'kpg.io/managed': 'true',
        'kpg.io/cluster': db.name,
        'kpg.io/type': 'credentials',
      },
    },
    data: encodedData,
  };

  const secretYaml = yaml.dump(secretManifest, { lineWidth: -1, noRefs: true });
  await runKubectl(['apply', '-f', '-'], {
    stdin: secretYaml,
    timeoutMs: 15000,
  });
}

export async function getAllStoredUserPasswords(
  db: ClusterDBInfo,
): Promise<Record<string, { password: string; source: 'cnpg' | 'kpg' }>> {
  const [appData, superData, kpgData] = await Promise.all([
    getRawSecretData(`${db.name}-app`, db.namespace),
    getRawSecretData(`${db.name}-superuser`, db.namespace),
    getKpgCredentialsSecret(db),
  ]);

  const result: Record<string, { password: string; source: 'cnpg' | 'kpg' }> = {};

  if (appData?.password) {
    const appUser = appData.username || 'app';
    result[appUser] = { password: appData.password, source: 'cnpg' };
  }

  if (superData?.password) {
    const superUser = superData.username || 'postgres';
    result[superUser] = { password: superData.password, source: 'cnpg' };
  }

  for (const [user, pass] of Object.entries(kpgData)) {
    if (pass) {
      result[user] = { password: pass, source: 'kpg' };
    }
  }

  return result;
}

const INTERNAL_NON_CLIENT_ROLES = new Set([
  'streaming_replica',
  'cnpg_pooler_pgbouncer',
  'cnpg_metrics_exporter',
]);

export async function listNodePortUserCredentials(
  db: ClusterDBInfo,
): Promise<NodePortUserCredential[]> {
  const [stored, pgUsers] = await Promise.all([
    getAllStoredUserPasswords(db),
    db.hibernated
      ? Promise.resolve<DbUserInfo[] | null>(null)
      : listDbUsers(db).catch(() => null),
  ]);

  const list: NodePortUserCredential[] = [];
  const seen = new Set<string>();

  if (pgUsers) {
    for (const u of pgUsers) {
      if (INTERNAL_NON_CLIENT_ROLES.has(u.name)) continue;
      if (!u.canLogin) continue;
      const cred = stored[u.name];
      list.push({
        username: u.name,
        password: cred?.password ?? null,
        source: cred?.source ?? 'none',
        canLogin: u.canLogin,
        isSystem: u.isSystem,
        permissions: u.permissions,
      });
      seen.add(u.name);
    }
  }

  // Include any stored secrets if DB is hibernated or role lookup failed
  for (const [username, cred] of Object.entries(stored)) {
    if (seen.has(username) || INTERNAL_NON_CLIENT_ROLES.has(username)) continue;
    list.push({
      username,
      password: cred.password,
      source: cred.source,
      canLogin: true,
      isSystem: PROTECTED_SYSTEM_ROLES.has(username),
      permissions: username === 'postgres' ? ['LOGIN', 'SUPERUSER'] : ['LOGIN'],
    });
  }

  // Sort: "app" first, then regular users alphabetically, then system roles (like postgres) last
  return list.sort((a, b) => {
    if (a.username === 'app' && b.username !== 'app') return -1;
    if (b.username === 'app' && a.username !== 'app') return 1;
    if (a.isSystem !== b.isSystem) return a.isSystem ? 1 : -1;
    return a.username.localeCompare(b.username);
  });
}

async function getAppSecretPassword(db: ClusterDBInfo): Promise<string | null> {
  const stored = await getAllStoredUserPasswords(db);
  return stored.app?.password ?? null;
}

export function buildConnectionUrlsForUser(
  hostIp: string,
  nodePort: number,
  username: string,
  password: string | null,
  tlsMode: TlsPolicyMode,
  database = 'app',
): { urlMasked: string; urlFull: string } {
  const sslParam =
    tlsMode === 'disabled'
      ? '?sslmode=disable'
      : tlsMode === 'required'
        ? '?sslmode=require'
        : '?sslmode=prefer';

  const encodedUser = encodeURIComponent(username);
  const encodedPass = password ? encodeURIComponent(password) : '<SIN_GUARDAR>';
  const maskedPass = password ? '********' : '<SIN_GUARDAR>';

  return {
    urlMasked: `postgresql://${encodedUser}:${maskedPass}@${hostIp}:${nodePort}/${database}${sslParam}`,
    urlFull: `postgresql://${encodedUser}:${encodedPass}@${hostIp}:${nodePort}/${database}${sslParam}`,
  };
}

function buildConnectionUrls(
  hostIp: string,
  nodePort: number,
  password: string | null,
  tlsMode: TlsPolicyMode,
): { urlMasked: string; urlFull: string } {
  return buildConnectionUrlsForUser(hostIp, nodePort, 'app', password, tlsMode);
}

export async function getNodePortAccess(
  db: ClusterDBInfo,
  hostIp: string,
): Promise<NodePortInfo | null> {
  const [svcList, tlsMode, appPassword] = await Promise.all([
    runKubectlJson<RawServiceList>([
      'get',
      'svc',
      '-n',
      db.namespace,
      '-l',
      `kpg.io/cluster=${db.name}`,
    ]).catch(() => ({ items: [] })),
    getTlsPolicy(db).catch(() => 'optional' as TlsPolicyMode),
    getAppSecretPassword(db),
  ]);

  const npSvc = svcList.items.find((s) => s.spec?.type === 'NodePort');
  if (!npSvc) return null;

  const portEntry = npSvc.spec?.ports?.[0];
  const nodePort = portEntry?.nodePort;
  if (!nodePort) return null;

  const labelId =
    npSvc.metadata.labels?.['kpg.io/label-id'] ??
    db.labelId?.display ??
    getStableLabelToken(db);

  const { urlMasked, urlFull } = buildConnectionUrls(
    hostIp,
    nodePort,
    appPassword,
    tlsMode,
  );

  return {
    serviceName: npSvc.metadata.name,
    namespace: npSvc.metadata.namespace,
    nodePort,
    targetPort: Number(portEntry.targetPort ?? 5432) || 5432,
    hostIp,
    labelId,
    appPassword,
    tlsMode,
    urlMasked,
    urlFull,
  };
}

export async function createOrGetNodePortAccess(
  db: ClusterDBInfo,
  hostIp: string,
): Promise<{ info: NodePortInfo; created: boolean }> {
  const existing = await getNodePortAccess(db, hostIp);
  if (existing) {
    return { info: existing, created: false };
  }

  // Copy exact primary selector from CNPG's <cluster>-rw service so NodePort survives switchovers/migrations!
  let selector: Record<string, string> = {
    'cnpg.io/cluster': db.name,
    'cnpg.io/instanceRole': 'primary',
  };
  try {
    const rwSvc = await runKubectlJson<RawService>([
      'get',
      'svc',
      `${db.name}-rw`,
      '-n',
      db.namespace,
    ]);
    if (rwSvc.spec?.selector && Object.keys(rwSvc.spec.selector).length > 0) {
      selector = rwSvc.spec.selector;
    }
  } catch {
    // keep default CNPG selector
  }

  const labelToken = getStableLabelToken(db);
  const serviceName = sanitizeK8sLabelToken(`kpg-np-${labelToken}`);

  const svcManifest = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: serviceName,
      namespace: db.namespace,
      labels: {
        'kpg.io/managed': 'true',
        'kpg.io/cluster': db.name,
        'kpg.io/label-id': labelToken,
      },
    },
    spec: {
      type: 'NodePort',
      selector,
      ports: [
        {
          name: 'postgres',
          protocol: 'TCP',
          port: 5432,
          targetPort: 5432,
        },
      ],
    },
  };

  const svcYaml = yaml.dump(svcManifest, { lineWidth: -1, noRefs: true });
  const applyRes = await runKubectl(['apply', '-f', '-'], {
    stdin: svcYaml,
    timeoutMs: 20000,
  });

  if (applyRes.code !== 0) {
    throw new Error(
      applyRes.stderr.trim() ||
        applyRes.stdout.trim() ||
        'No se pudo crear el Service NodePort.',
    );
  }

  const createdInfo = await getNodePortAccess(db, hostIp);
  if (!createdInfo) {
    throw new Error(
      'El Service NodePort se aplicó, pero aún no reporta puerto asignado.',
    );
  }

  return { info: createdInfo, created: true };
}

export async function deleteNodePortAccess(
  db: ClusterDBInfo,
  serviceName: string,
): Promise<void> {
  const res = await runKubectl(
    ['delete', 'svc', serviceName, '-n', db.namespace],
    { timeoutMs: 15000 },
  );
  if (res.code !== 0 && !res.stderr.includes('NotFound')) {
    throw new Error(
      res.stderr.trim() ||
        res.stdout.trim() ||
        `No se pudo eliminar el Service NodePort ${serviceName}.`,
    );
  }
}
