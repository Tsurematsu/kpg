import crypto from 'node:crypto';
import * as yaml from 'js-yaml';
import { runKubectl, runKubectlJson } from './kubectl.js';
import type {
  ClusterDBInfo,
  ClusterPowerState,
  ClusterSnapshot,
  CnpgPluginStatus,
  KubectlConnectionStatus,
  LabelSelectorEntry,
  NamespaceInfo,
  NodeInfo,
  OperatorStatus,
  ReplicaPodInfo,
} from '../types/k8s.js';

export const CNPG_DEFAULT_VERSION = '1.29.1';
export const CNPG_MANIFEST_URL =
  process.env.KPG_CNPG_MANIFEST_URL ??
  `https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.29/releases/cnpg-${CNPG_DEFAULT_VERSION}.yaml`;

export const KPG_LABEL_PREFIX = 'kpg.db/';
export const KPG_NS_USAGE_LABEL = 'tsure.io/kpg';

const SYSTEM_NAMESPACES = new Set([
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'cnpg-system',
]);

export function isSystemNamespace(name: string): boolean {
  return SYSTEM_NAMESPACES.has(name);
}

export function isDefaultNamespace(name: string): boolean {
  return name === 'default';
}

const SYSTEM_LABEL_PREFIXES = [
  'kubernetes.io/',
  'beta.kubernetes.io/',
  'node.kubernetes.io/',
  'node-role.kubernetes.io/',
  'k3s.io/',
  'flannel.alpha.coreos.com/',
];

function isSystemLabel(key: string): boolean {
  return SYSTEM_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function extractLabelId(nodeSelector: Record<string, string>): LabelSelectorEntry | null {
  const entries = Object.entries(nodeSelector);
  if (entries.length === 0) return null;

  const kpgEntry = entries.find(([key]) => key.startsWith(KPG_LABEL_PREFIX));
  if (kpgEntry) {
    const [key, value] = kpgEntry;
    const shortId = key.slice(KPG_LABEL_PREFIX.length);
    return {
      key,
      value,
      shortId,
      display: `${key}`,
    };
  }

  const [key, value] = entries[0];
  return {
    key,
    value,
    shortId: `${key}=${value}`,
    display: `${key}=${value}`,
  };
}

function parseInstanceNumber(podName: string, clusterName: string): number | null {
  const prefix = `${clusterName}-`;
  if (!podName.startsWith(prefix)) return null;
  const rest = podName.slice(prefix.length);
  if (!/^\d+$/.test(rest)) return null;
  return Number.parseInt(rest, 10);
}

export async function checkKubectlConnection(): Promise<KubectlConnectionStatus> {
  const clientRes = await runKubectl(['version', '--client', '-o', 'json'], {
    timeoutMs: 5000,
  });

  if (clientRes.code !== 0) {
    return {
      installed: false,
      connected: false,
      context: '',
      serverUrl: '',
      clientVersion: '',
      serverVersion: '',
      error: clientRes.stderr.trim() || 'No se encontró el binario `kubectl` en el PATH.',
    };
  }

  let clientVersion = '';
  try {
    const parsed = JSON.parse(clientRes.stdout) as {
      clientVersion?: { gitVersion?: string };
    };
    clientVersion = parsed.clientVersion?.gitVersion ?? '';
  } catch {
    clientVersion = '';
  }

  const [ctxRes, serverUrlRes, versionRes] = await Promise.all([
    runKubectl(['config', 'current-context'], { timeoutMs: 5000 }),
    runKubectl(
      ['config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}'],
      { timeoutMs: 5000 },
    ),
    runKubectl(['version', '-o', 'json'], { timeoutMs: 8000 }),
  ]);

  const context = ctxRes.code === 0 ? ctxRes.stdout.trim() : '';
  const serverUrl = serverUrlRes.code === 0 ? serverUrlRes.stdout.trim() : '';

  if (versionRes.code !== 0) {
    const rawErr = versionRes.stderr.trim() || versionRes.stdout.trim();
    return {
      installed: true,
      connected: false,
      context,
      serverUrl,
      clientVersion,
      serverVersion: '',
      error: versionRes.timedOut
        ? 'Tiempo de espera agotado al conectar con el API server de Kubernetes.'
        : rawErr || 'No se pudo conectar con el cluster de Kubernetes.',
    };
  }

  let serverVersion = '';
  try {
    const parsed = JSON.parse(versionRes.stdout) as {
      serverVersion?: { gitVersion?: string };
    };
    serverVersion = parsed.serverVersion?.gitVersion ?? '';
  } catch {
    serverVersion = '';
  }

  return {
    installed: true,
    connected: Boolean(serverVersion),
    context,
    serverUrl,
    clientVersion,
    serverVersion,
    error: serverVersion ? undefined : 'No se recibió versión del servidor de Kubernetes.',
  };
}

export async function checkCnpgPlugin(): Promise<CnpgPluginStatus> {
  const res = await runKubectl(['plugin', 'list'], { timeoutMs: 5000 });
  if (res.code === 0) {
    const lines = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const match = lines.find((line) => {
      const norm = line.replace(/\\/g, '/').toLowerCase();
      return (
        norm.endsWith('/kubectl-cnpg') ||
        norm.endsWith('/kubectl-cnpg.exe') ||
        norm === 'kubectl-cnpg' ||
        norm === 'kubectl-cnpg.exe'
      );
    });
    if (match) {
      return { installed: true, path: match };
    }
  }

  const fallback = await runKubectl(['cnpg', 'version'], { timeoutMs: 5000 });
  if (fallback.code === 0) {
    return { installed: true };
  }

  return { installed: false };
}

interface RawDeployment {
  spec?: {
    replicas?: number;
    template?: {
      spec?: {
        containers?: Array<{ image?: string }>;
      };
    };
  };
  status?: {
    replicas?: number;
    readyReplicas?: number;
  };
}

interface RawPodList {
  items: Array<{
    metadata: {
      name: string;
      namespace: string;
      labels?: Record<string, string>;
    };
    spec?: {
      nodeName?: string;
      containers?: Array<{ image?: string }>;
    };
    status?: {
      phase?: string;
      podIP?: string;
      containerStatuses?: Array<{
        ready?: boolean;
        restartCount?: number;
      }>;
    };
  }>;
}

export async function checkCnpgOperator(): Promise<OperatorStatus> {
  const depRes = await runKubectl(
    ['get', 'deployment', '-n', 'cnpg-system', 'cnpg-controller-manager', '-o', 'json'],
    { timeoutMs: 10000 },
  );

  if (depRes.code !== 0) {
    return {
      installed: false,
      ready: false,
      replicas: 0,
      readyReplicas: 0,
    };
  }

  let dep: RawDeployment = {};
  try {
    dep = JSON.parse(depRes.stdout) as RawDeployment;
  } catch {
    return { installed: false, ready: false, replicas: 0, readyReplicas: 0 };
  }

  const replicas = dep.spec?.replicas ?? 1;
  const readyReplicas = dep.status?.readyReplicas ?? 0;
  const image = dep.spec?.template?.spec?.containers?.[0]?.image ?? '';
  const versionMatch = image.match(/:([^:]+)$/);

  let podName: string | undefined;
  let nodeName: string | undefined;
  let phase: string | undefined;

  try {
    const pods = await runKubectlJson<RawPodList>([
      'get',
      'pods',
      '-n',
      'cnpg-system',
      '-l',
      'app.kubernetes.io/name=cloudnative-pg',
    ]);
    const activePod =
      pods.items.find((p) => p.status?.phase === 'Running') ?? pods.items[0];
    if (activePod) {
      podName = activePod.metadata.name;
      nodeName = activePod.spec?.nodeName;
      phase = activePod.status?.phase;
    }
  } catch {
    // Best-effort pod lookup
  }

  return {
    installed: true,
    ready: readyReplicas > 0 && readyReplicas >= replicas,
    podName,
    nodeName,
    phase,
    replicas,
    readyReplicas,
    version: versionMatch?.[1],
  };
}

interface RawNodeList {
  items: Array<{
    metadata: {
      name: string;
      labels?: Record<string, string>;
    };
    status?: {
      conditions?: Array<{ type: string; status: string }>;
      addresses?: Array<{ type: string; address: string }>;
    };
  }>;
}

export async function getNodes(): Promise<NodeInfo[]> {
  const raw = await runKubectlJson<RawNodeList>(['get', 'nodes']);

  return raw.items.map((node) => {
    const labels = node.metadata.labels ?? {};
    const roles: string[] = [];
    for (const key of Object.keys(labels)) {
      if (key.startsWith('node-role.kubernetes.io/')) {
        const role = key.slice('node-role.kubernetes.io/'.length);
        if (role) roles.push(role);
      }
    }

    const isControlPlane =
      roles.includes('control-plane') || roles.includes('master');

    const readyCondition = node.status?.conditions?.find(
      (c) => c.type === 'Ready',
    );
    const ready = readyCondition?.status === 'True';

    const internalIp =
      node.status?.addresses?.find((a) => a.type === 'InternalIP')?.address ??
      '';

    const customLabels: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) {
      if (!isSystemLabel(k)) {
        customLabels[k] = v;
      }
    }

    return {
      name: node.metadata.name,
      isControlPlane,
      ready,
      roles: roles.length > 0 ? roles : ['agent'],
      internalIp,
      labels,
      customLabels,
    };
  });
}

function patchOperatorManifestForNode(
  rawYaml: string,
  agentNodeName: string | null,
): string {
  const chunks = rawYaml.split(/\n---(?=\n|$)/);

  const patchedChunks = chunks.map((chunk) => {
    if (
      !chunk.includes('kind: Deployment') ||
      !chunk.includes('cnpg-controller-manager')
    ) {
      return chunk;
    }

    const doc = yaml.load(chunk) as Record<string, any> | null;
    if (
      !doc ||
      doc.kind !== 'Deployment' ||
      doc.metadata?.name !== 'cnpg-controller-manager'
    ) {
      return chunk;
    }

    doc.spec = doc.spec ?? {};
    doc.spec.replicas = 1;

    if (agentNodeName) {
      doc.spec.template = doc.spec.template ?? {};
      doc.spec.template.spec = doc.spec.template.spec ?? {};
      doc.spec.template.spec.nodeSelector = {
        ...(doc.spec.template.spec.nodeSelector ?? {}),
        'kubernetes.io/hostname': agentNodeName,
      };
    }

    return yaml.dump(doc, { lineWidth: -1, noRefs: true });
  });

  return patchedChunks.join('\n---\n');
}

export async function installCnpgOperator(
  agentNodeName: string | null,
  onProgress?: (line: string) => void,
): Promise<OperatorStatus> {
  onProgress?.(`Descargando manifiesto CNPG (${CNPG_DEFAULT_VERSION})...`);

  const response = await fetch(CNPG_MANIFEST_URL);
  if (!response.ok) {
    throw new Error(
      `No se pudo descargar el manifiesto CNPG (HTTP ${response.status}).`,
    );
  }

  const rawYaml = await response.text();
  onProgress?.(
    agentNodeName
      ? `Configurando operador (replicas: 1) en el agente ${agentNodeName}...`
      : 'Configurando operador (replicas: 1, scheduler automático)...',
  );

  const manifestYaml = patchOperatorManifestForNode(rawYaml, agentNodeName);

  onProgress?.('Aplicando CRDs y operador con kubectl apply --server-side...');
  const applyRes = await runKubectl(['apply', '--server-side', '-f', '-'], {
    stdin: manifestYaml,
    timeoutMs: 120000,
    onStdout: (chunk) => {
      const lines = chunk
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) onProgress?.(last);
    },
  });

  if (applyRes.code !== 0) {
    throw new Error(
      applyRes.stderr.trim() ||
        applyRes.stdout.trim() ||
        'Falló la aplicación del manifiesto del operador CNPG.',
    );
  }

  onProgress?.('Esperando a que cnpg-controller-manager esté Ready...');
  const rolloutRes = await runKubectl(
    [
      'rollout',
      'status',
      'deployment',
      '-n',
      'cnpg-system',
      'cnpg-controller-manager',
      '--timeout=180s',
    ],
    {
      timeoutMs: 190000,
      onStdout: (chunk) => {
        const line = chunk.trim();
        if (line) onProgress?.(line);
      },
    },
  );

  if (rolloutRes.code !== 0) {
    throw new Error(
      rolloutRes.stderr.trim() ||
        rolloutRes.stdout.trim() ||
        'El operador no llegó a estado Ready dentro del tiempo esperado.',
    );
  }

  onProgress?.('Operador CNPG instalado y listo.');
  return checkCnpgOperator();
}

interface RawClusterList {
  items: Array<{
    metadata: {
      name: string;
      namespace: string;
      annotations?: Record<string, string>;
    };
    spec?: {
      instances?: number;
      imageName?: string;
      storage?: {
        size?: string;
        storageClass?: string;
      };
      affinity?: {
        nodeSelector?: Record<string, string>;
      };
    };
    status?: {
      phase?: string;
      readyInstances?: number;
      currentPrimary?: string;
      conditions?: Array<{
        type?: string;
        status?: string;
        reason?: string;
        message?: string;
      }>;
    };
  }>;
}

interface RawPvcList {
  items: Array<{
    metadata: {
      name: string;
      namespace: string;
      labels?: Record<string, string>;
    };
  }>;
}

export async function listClusterDBs(): Promise<ClusterDBInfo[]> {
  const [clustersRes, podsRes, pvcsRes] = await Promise.all([
    runKubectl(['get', 'clusters.postgresql.cnpg.io', '-A', '-o', 'json'], {
      timeoutMs: 15000,
    }),
    runKubectl(['get', 'pods', '-A', '-l', 'cnpg.io/cluster', '-o', 'json'], {
      timeoutMs: 15000,
    }),
    runKubectl(['get', 'pvc', '-A', '-l', 'cnpg.io/cluster', '-o', 'json'], {
      timeoutMs: 15000,
    }),
  ]);

  if (clustersRes.code !== 0) {
    // If CRD is missing or no clusters
    if (
      clustersRes.stderr.includes('the server doesn\'t have a resource type') ||
      clustersRes.stderr.includes('NotFound')
    ) {
      return [];
    }
    throw new Error(
      clustersRes.stderr.trim() || 'No se pudo obtener la lista de Clusters CNPG.',
    );
  }

  const clusters = (JSON.parse(clustersRes.stdout) as RawClusterList).items ?? [];
  const allPods =
    podsRes.code === 0
      ? ((JSON.parse(podsRes.stdout) as RawPodList).items ?? [])
      : [];
  const allPvcs =
    pvcsRes.code === 0
      ? ((JSON.parse(pvcsRes.stdout) as RawPvcList).items ?? [])
      : [];

  return clusters
    .map((cluster) => {
      const name = cluster.metadata.name;
      const namespace = cluster.metadata.namespace || 'default';
      const instances = cluster.spec?.instances ?? 1;
      const readyInstances = cluster.status?.readyInstances ?? 0;
      const phase = cluster.status?.phase ?? 'Desconocido';
      const currentPrimary = cluster.status?.currentPrimary ?? '';
      const nodeSelector = cluster.spec?.affinity?.nodeSelector ?? {};
      const labelId = extractLabelId(nodeSelector);

      const clusterPods: ReplicaPodInfo[] = allPods
        .filter((p) => {
          if (p.metadata.namespace !== namespace) return false;
          if (p.metadata.labels?.['cnpg.io/cluster'] !== name) return false;
          // Exclude initdb/join/recovery job pods
          if (p.metadata.labels?.['cnpg.io/jobRole']) return false;
          return parseInstanceNumber(p.metadata.name, name) !== null;
        })
        .map((p) => {
          const labels = p.metadata.labels ?? {};
          const rawRole =
            labels['cnpg.io/instanceRole'] ?? labels['role'] ?? '';
          const isPrimary =
            p.metadata.name === currentPrimary || rawRole === 'primary';
          const role: ReplicaPodInfo['role'] = isPrimary
            ? 'primary'
            : rawRole === 'replica'
              ? 'replica'
              : currentPrimary
                ? 'replica'
                : 'unknown';

          const cs = p.status?.containerStatuses ?? [];
          const ready = cs.length > 0 && cs.every((c) => Boolean(c.ready));
          const restarts = cs.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);

          return {
            name: p.metadata.name,
            instanceNumber: parseInstanceNumber(p.metadata.name, name),
            nodeName: p.spec?.nodeName ?? 'Pending',
            role,
            phase: p.status?.phase ?? 'Unknown',
            ready,
            restarts,
            podIp: p.status?.podIP ?? '',
          };
        })
        .sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0));

      const hibAnnot =
        cluster.metadata.annotations?.['cnpg.io/hibernation']?.toLowerCase();
      const hibCondTrue =
        cluster.status?.conditions?.some(
          (c) => c.type === 'Hibernated' && c.status === 'True',
        ) ?? false;

      let powerState: ClusterPowerState = 'running';
      if (hibAnnot === 'on') {
        powerState =
          hibCondTrue || clusterPods.length === 0
            ? 'hibernated'
            : 'hibernating';
      } else if (hibCondTrue) {
        powerState = 'waking';
      }

      const hibernated =
        powerState === 'hibernated' || powerState === 'hibernating';
      const healthy =
        !hibernated &&
        powerState === 'running' &&
        phase.toLowerCase().includes('healthy');

      const primaryPod =
        clusterPods.find((p) => p.role === 'primary') ??
        clusterPods.find((p) => p.name === currentPrimary);
      const replicas = clusterPods.filter((p) => p !== primaryPod);

      const pvcs = allPvcs
        .filter(
          (pvc) =>
            pvc.metadata.namespace === namespace &&
            pvc.metadata.labels?.['cnpg.io/cluster'] === name,
        )
        .map((pvc) => pvc.metadata.name);

      return {
        name,
        namespace,
        instances,
        readyInstances,
        phase,
        healthy,
        hibernated,
        powerState,
        currentPrimary,
        primaryNode: primaryPod?.nodeName ?? '—',
        replicas,
        pods: clusterPods,
        pvcs,
        nodeSelector,
        labelId,
        imageName: cluster.spec?.imageName ?? '',
        storageSize: cluster.spec?.storage?.size ?? '',
        storageClass: cluster.spec?.storage?.storageClass ?? '',
      };
    })
    .sort((a, b) =>
      a.namespace === b.namespace
        ? a.name.localeCompare(b.name)
        : a.namespace.localeCompare(b.namespace),
    );
}

export function getAgentNodes(nodes: NodeInfo[]): NodeInfo[] {
  return nodes.filter((n) => !n.isControlPlane);
}

interface RawNamespaceList {
  items: Array<{
    metadata: {
      name: string;
      labels?: Record<string, string>;
    };
    status?: {
      phase?: string;
    };
  }>;
}

export async function getNamespaces(): Promise<NamespaceInfo[]> {
  const raw = await runKubectlJson<RawNamespaceList>(['get', 'namespaces']);

  return (raw.items ?? [])
    .map((ns) => {
      const name = ns.metadata.name;
      const status = ns.status?.phase ?? 'Active';
      const labels = ns.metadata.labels ?? {};
      const customLabels: Record<string, string> = {};
      const otherToolLabels: Record<string, string> = {};

      for (const [k, v] of Object.entries(labels)) {
        if (!isSystemLabel(k)) {
          customLabels[k] = v;
          if (k !== KPG_NS_USAGE_LABEL) {
            otherToolLabels[k] = v;
          }
        }
      }

      return {
        name,
        status,
        isSystem: isSystemNamespace(name),
        isDefault: isDefaultNamespace(name),
        labels,
        customLabels,
        usedByKpg: labels[KPG_NS_USAGE_LABEL] === 'true',
        otherToolLabels,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getSelectableNamespaces(
  namespaces: NamespaceInfo[],
): NamespaceInfo[] {
  return namespaces
    .filter((ns) => !ns.isSystem && !ns.isDefault && ns.status === 'Active')
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function labelNamespaceInUse(namespace: string): Promise<void> {
  if (!namespace || isDefaultNamespace(namespace) || isSystemNamespace(namespace)) {
    return;
  }
  const res = await runKubectl(
    ['label', 'namespace', namespace, `${KPG_NS_USAGE_LABEL}=true`, '--overwrite'],
    { timeoutMs: 15000 },
  );
  if (res.code !== 0) {
    throw new Error(
      res.stderr.trim() ||
        `No se pudo etiquetar el namespace "${namespace}" con ${KPG_NS_USAGE_LABEL}=true.`,
    );
  }
}

export async function unlabelNamespaceInUse(namespace: string): Promise<void> {
  if (!namespace || isDefaultNamespace(namespace) || isSystemNamespace(namespace)) {
    return;
  }
  const res = await runKubectl(
    ['label', 'namespace', namespace, `${KPG_NS_USAGE_LABEL}-`],
    { timeoutMs: 15000 },
  );
  if (
    res.code !== 0 &&
    !res.stderr.includes('not found') &&
    !res.stderr.includes('NotFound')
  ) {
    throw new Error(
      res.stderr.trim() ||
        `No se pudo quitar el label ${KPG_NS_USAGE_LABEL} del namespace "${namespace}".`,
    );
  }
}

export async function syncNamespaceUsageLabel(
  namespace: string,
  existingDbs?: ClusterDBInfo[],
): Promise<boolean> {
  if (!namespace || isDefaultNamespace(namespace) || isSystemNamespace(namespace)) {
    return false;
  }
  const dbs = existingDbs ?? (await listClusterDBs());
  const hasDbs = dbs.some((d) => d.namespace === namespace);
  if (hasDbs) {
    await labelNamespaceInUse(namespace);
    return true;
  }
  await unlabelNamespaceInUse(namespace);
  return false;
}

export async function syncAllNamespaceUsageLabels(): Promise<{
  labeled: string[];
  unlabeled: string[];
}> {
  const [namespaces, dbs] = await Promise.all([
    getNamespaces(),
    listClusterDBs(),
  ]);
  const selectable = getSelectableNamespaces(namespaces);
  const labeled: string[] = [];
  const unlabeled: string[] = [];

  for (const ns of selectable) {
    const hasDbs = dbs.some((d) => d.namespace === ns.name);
    if (hasDbs && !ns.usedByKpg) {
      await labelNamespaceInUse(ns.name);
      labeled.push(ns.name);
    } else if (!hasDbs && ns.usedByKpg) {
      await unlabelNamespaceInUse(ns.name);
      unlabeled.push(ns.name);
    }
  }

  return { labeled, unlabeled };
}

export async function getClusterSnapshot(): Promise<ClusterSnapshot> {
  const [nodes, namespaces, dbs, operator] = await Promise.all([
    getNodes(),
    getNamespaces().catch(() => [] as NamespaceInfo[]),
    listClusterDBs(),
    checkCnpgOperator(),
  ]);

  return {
    nodes,
    namespaces,
    dbs,
    operator,
    fetchedAt: new Date(),
  };
}

export function generateUniqueLabelId(nodes: NodeInfo[]): LabelSelectorEntry {
  const usedKeys = new Set<string>();
  for (const node of nodes) {
    for (const k of Object.keys(node.labels)) {
      if (k.startsWith(KPG_LABEL_PREFIX)) {
        usedKeys.add(k);
      }
    }
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    const shortId = crypto.randomBytes(3).toString('hex');
    const key = `${KPG_LABEL_PREFIX}${shortId}`;
    if (!usedKeys.has(key)) {
      return {
        key,
        value: 'true',
        shortId,
        display: key,
      };
    }
  }

  const fallback = `${Date.now().toString(36).slice(-6)}`;
  const key = `${KPG_LABEL_PREFIX}${fallback}`;
  return {
    key,
    value: 'true',
    shortId: fallback,
    display: key,
  };
}

export async function labelNode(
  nodeName: string,
  key: string,
  value: string,
): Promise<void> {
  const res = await runKubectl(
    ['label', 'node', nodeName, `${key}=${value}`, '--overwrite'],
    { timeoutMs: 15000 },
  );
  if (res.code !== 0) {
    throw new Error(
      res.stderr.trim() || `No se pudo etiquetar el agente ${nodeName} con ${key}=${value}.`,
    );
  }
}

export async function unlabelNode(
  nodeName: string,
  key: string,
): Promise<void> {
  const res = await runKubectl(['label', 'node', nodeName, `${key}-`], {
    timeoutMs: 15000,
  });
  if (res.code !== 0 && !res.stderr.includes('not found')) {
    throw new Error(
      res.stderr.trim() || `No se pudo quitar el label ${key} del agente ${nodeName}.`,
    );
  }
}

interface RawStorageClassList {
  items: Array<{
    metadata: {
      name: string;
      annotations?: Record<string, string>;
    };
  }>;
}

export async function getDefaultStorageClass(): Promise<string> {
  try {
    const raw = await runKubectlJson<RawStorageClassList>(['get', 'storageclass']);
    const def = raw.items.find(
      (sc) =>
        sc.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] ===
        'true',
    );
    return def?.metadata.name ?? raw.items[0]?.metadata.name ?? 'local-path';
  } catch {
    return 'local-path';
  }
}

export interface CreateClusterDBParams {
  name: string;
  namespace: string;
  agentNode: string;
  storageSize: string;
  storageClass: string;
  imageName: string;
  labelId: LabelSelectorEntry;
  pgHba?: string[];
  skipNodeLabelRollback?: boolean;
}

export async function createClusterDB(
  params: CreateClusterDBParams,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const namespace = params.namespace;

  if (!isDefaultNamespace(namespace) && !isSystemNamespace(namespace)) {
    onProgress?.(
      `Registrando uso de kpg en namespace "${namespace}" (${KPG_NS_USAGE_LABEL}=true)...`,
    );
    await labelNamespaceInUse(namespace);
  }

  onProgress?.(
    `Etiquetando agente ${params.agentNode} con ${params.labelId.key}=${params.labelId.value}...`,
  );
  await labelNode(params.agentNode, params.labelId.key, params.labelId.value);

  const specObj: Record<string, unknown> = {
    instances: 1,
    imageName: params.imageName,
    storage: {
      size: params.storageSize,
      storageClass: params.storageClass,
    },
    affinity: {
      enablePodAntiAffinity: true,
      podAntiAffinityType: 'required',
      topologyKey: 'kubernetes.io/hostname',
      nodeSelector: {
        [params.labelId.key]: params.labelId.value,
      },
    },
  };

  if (params.pgHba && params.pgHba.length > 0) {
    specObj.postgresql = { pg_hba: params.pgHba };
  }

  const manifestObj = {
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    metadata: {
      name: params.name,
      namespace,
      labels: {
        'kpg.io/managed': 'true',
        'kpg.io/id': params.labelId.shortId,
      },
    },
    spec: specObj,
  };

  const manifestYaml = yaml.dump(manifestObj, { lineWidth: -1, noRefs: true });

  onProgress?.(`Creando Cluster CNPG "${params.name}" en namespace ${namespace}...`);
  const applyRes = await runKubectl(['apply', '-f', '-'], {
    stdin: manifestYaml,
    timeoutMs: 30000,
  });

  if (applyRes.code !== 0) {
    // Rollback node label (if safe) and namespace usage label if cluster creation failed
    if (!params.skipNodeLabelRollback) {
      try {
        await unlabelNode(params.agentNode, params.labelId.key);
      } catch {
        // ignore rollback error
      }
    }
    try {
      await syncNamespaceUsageLabel(namespace);
    } catch {
      // ignore rollback error
    }
    throw new Error(
      applyRes.stderr.trim() ||
        applyRes.stdout.trim() ||
        'Falló la creación del Cluster CNPG.',
    );
  }

  onProgress?.(`Cluster "${params.name}" aplicado correctamente (instances: 1).`);
}

export async function patchClusterInstances(
  name: string,
  namespace: string,
  instances: number,
): Promise<void> {
  const patchPayload = JSON.stringify({ spec: { instances } });
  const res = await runKubectl(
    [
      'patch',
      'cluster.postgresql.cnpg.io',
      name,
      '-n',
      namespace,
      '--type=merge',
      '-p',
      patchPayload,
    ],
    { timeoutMs: 20000 },
  );

  if (res.code !== 0) {
    throw new Error(
      res.stderr.trim() ||
        res.stdout.trim() ||
        `No se pudo actualizar spec.instances a ${instances}.`,
    );
  }
}

export async function destroyClusterInstance(
  name: string,
  namespace: string,
  instanceNumber: number,
  keepPvc: boolean,
): Promise<string> {
  const args = ['cnpg', 'destroy', name, String(instanceNumber), '-n', namespace];
  if (keepPvc) {
    args.push('--keep-pvc');
  }
  const res = await runKubectl(args, { timeoutMs: 30000 });
  if (res.code !== 0) {
    throw new Error(
      res.stderr.trim() ||
        res.stdout.trim() ||
        `No se pudo destruir la instancia ${name}-${instanceNumber}.`,
    );
  }
  return res.stdout.trim();
}

function isLabelSharedByOtherDB(
  allDbs: ClusterDBInfo[],
  currentDb: ClusterDBInfo,
  key: string,
  value: string,
): boolean {
  return allDbs.some(
    (other) =>
      !(other.name === currentDb.name && other.namespace === currentDb.namespace) &&
      other.nodeSelector[key] === value,
  );
}

export interface ScaleReplicasParams {
  db: ClusterDBInfo;
  targetReplicas: number;
  addLabelToAgents: string[];
  replicasToDestroy: ReplicaPodInfo[];
  allDbs: ClusterDBInfo[];
  allNodes: NodeInfo[];
}

export async function scaleClusterReplicas(
  params: ScaleReplicasParams,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const { db, targetReplicas, addLabelToAgents, replicasToDestroy, allDbs, allNodes } =
    params;
  const targetInstances = targetReplicas + 1;
  const label = db.labelId;

  if (targetInstances > db.instances) {
    // Scaling UP
    if (label) {
      for (const agent of addLabelToAgents) {
        onProgress?.(`Añadiendo label ${label.key}=${label.value} al agente ${agent}...`);
        await labelNode(agent, label.key, label.value);
      }
    }

    onProgress?.(
      `Escalando "${db.name}" de ${db.instances} a ${targetInstances} instancias (${targetReplicas} réplica${targetReplicas === 1 ? '' : 's'})...`,
    );
    await patchClusterInstances(db.name, db.namespace, targetInstances);
    onProgress?.(
      'Cambio aplicado. El operador CNPG está creando y sincronizando las réplicas.',
    );
    return;
  }

  if (targetInstances < db.instances) {
    // Scaling DOWN safely: verify currentPrimary first, destroy selected non-primary replicas, then patch instances
    const freshDbs = await listClusterDBs();
    const freshDb = freshDbs.find(
      (d) => d.name === db.name && d.namespace === db.namespace,
    );
    const currentPrimary = freshDb?.currentPrimary || db.currentPrimary;

    const nodesToPotentiallyUnlabel = new Set<string>();

    for (const replica of replicasToDestroy) {
      if (replica.name === currentPrimary) {
        throw new Error(
          `Bloqueo de seguridad: ${replica.name} es el primario actual y no se destruirá.`,
        );
      }
      if (replica.instanceNumber === null) {
        throw new Error(
          `No se pudo determinar el número de instancia de ${replica.name}.`,
        );
      }
      onProgress?.(
        `Eliminando réplica ${replica.name} (agente ${replica.nodeName}) con kubectl cnpg destroy...`,
      );
      await destroyClusterInstance(
        db.name,
        db.namespace,
        replica.instanceNumber,
        false,
      );
      if (replica.nodeName && replica.nodeName !== 'Pending') {
        nodesToPotentiallyUnlabel.add(replica.nodeName);
      }
    }

    onProgress?.(`Actualizando spec.instances a ${targetInstances}...`);
    await patchClusterInstances(db.name, db.namespace, targetInstances);

    if (label && nodesToPotentiallyUnlabel.size > 0) {
      const shared = isLabelSharedByOtherDB(allDbs, db, label.key, label.value);
      if (shared) {
        onProgress?.(
          `Label ${label.key}=${label.value} compartido por otra BD: se conserva en los agentes.`,
        );
      } else {
        for (const nodeName of nodesToPotentiallyUnlabel) {
          // Never unlabel the primary node
          if (nodeName === (freshDb?.primaryNode ?? db.primaryNode)) continue;
          const node = allNodes.find((n) => n.name === nodeName);
          if (node && node.labels[label.key] === label.value) {
            onProgress?.(`Quitando label ${label.key} del agente ${nodeName}...`);
            await unlabelNode(nodeName, label.key);
          }
        }
      }
    }

    onProgress?.(
      `Réplicas ajustadas a ${targetReplicas} (${targetInstances} instancia${targetInstances === 1 ? '' : 's'}).`,
    );
  }
}

export async function setClusterPowerState(
  db: ClusterDBInfo,
  target: 'on' | 'off',
  onProgress?: (msg: string) => void,
): Promise<void> {
  const action = target === 'off' ? 'on' : 'off'; // hibernate on = power off, hibernate off = power on
  onProgress?.(
    target === 'off'
      ? `Enviando orden de apagado (hibernación) a "${db.name}"...`
      : `Enviando orden de encendido a "${db.name}"...`,
  );

  const res = await runKubectl(
    ['cnpg', 'hibernate', action, db.name, '-n', db.namespace],
    { timeoutMs: 30000 },
  );

  if (res.code === 0) {
    onProgress?.(
      target === 'off'
        ? `Hibernación activada en "${db.name}" (cnpg.io/hibernation=on).`
        : `Hibernación desactivada en "${db.name}" (cnpg.io/hibernation=off).`,
    );
    return;
  }

  // Fallback to direct annotation if kubectl-cnpg hibernate fails due to missing plugin
  const annotRes = await runKubectl(
    [
      'annotate',
      'cluster.postgresql.cnpg.io',
      db.name,
      '-n',
      db.namespace,
      `cnpg.io/hibernation=${action}`,
      '--overwrite',
    ],
    { timeoutMs: 20000 },
  );

  if (annotRes.code !== 0) {
    throw new Error(
      res.stderr.trim() ||
        annotRes.stderr.trim() ||
        `No se pudo cambiar el estado de energía de "${db.name}".`,
    );
  }

  onProgress?.(
    target === 'off'
      ? `Anotación cnpg.io/hibernation=on aplicada a "${db.name}".`
      : `Anotación cnpg.io/hibernation=off aplicada a "${db.name}".`,
  );
}

export async function deleteClusterDB(
  db: ClusterDBInfo,
  allDbs: ClusterDBInfo[],
  allNodes: NodeInfo[],
  onProgress?: (msg: string) => void,
): Promise<void> {
  // 1. Delete any associated kpg NodePort services and credential secrets
  onProgress?.(`Buscando recursos kpg asociados a "${db.name}"...`);
  const svcListRes = await runKubectl(
    [
      'get',
      'svc',
      '-n',
      db.namespace,
      '-l',
      `kpg.io/cluster=${db.name}`,
      '-o',
      'jsonpath={.items[*].metadata.name}',
    ],
    { timeoutMs: 10000 },
  );
  if (svcListRes.code === 0 && svcListRes.stdout.trim()) {
    const svcNames = svcListRes.stdout.trim().split(/\s+/).filter(Boolean);
    for (const svcName of svcNames) {
      onProgress?.(`Eliminando Service NodePort ${svcName}...`);
      await runKubectl(['delete', 'svc', svcName, '-n', db.namespace], {
        timeoutMs: 15000,
      });
    }
  }

  const secretListRes = await runKubectl(
    [
      'get',
      'secret',
      '-n',
      db.namespace,
      '-l',
      `kpg.io/cluster=${db.name}`,
      '-o',
      'jsonpath={.items[*].metadata.name}',
    ],
    { timeoutMs: 10000 },
  );
  if (secretListRes.code === 0 && secretListRes.stdout.trim()) {
    const secretNames = secretListRes.stdout.trim().split(/\s+/).filter(Boolean);
    for (const secretName of secretNames) {
      onProgress?.(`Eliminando Secret de credenciales ${secretName}...`);
      await runKubectl(['delete', 'secret', secretName, '-n', db.namespace], {
        timeoutMs: 15000,
      });
    }
  }

  // 2. Delete CNPG Cluster resource
  onProgress?.(`Eliminando Cluster CNPG "${db.name}" en namespace ${db.namespace}...`);
  const delRes = await runKubectl(
    [
      'delete',
      'cluster.postgresql.cnpg.io',
      db.name,
      '-n',
      db.namespace,
      '--wait=true',
      '--timeout=120s',
    ],
    { timeoutMs: 130000 },
  );
  if (delRes.code !== 0 && !delRes.stderr.includes('NotFound')) {
    throw new Error(
      delRes.stderr.trim() ||
        delRes.stdout.trim() ||
        `No se pudo eliminar el Cluster "${db.name}".`,
    );
  }

  // 3. Clean up any lingering PVCs belonging to this cluster
  onProgress?.('Verificando PVCs residuales...');
  const pvcRes = await runKubectl(
    [
      'get',
      'pvc',
      '-n',
      db.namespace,
      '-l',
      `cnpg.io/cluster=${db.name}`,
      '-o',
      'jsonpath={.items[*].metadata.name}',
    ],
    { timeoutMs: 10000 },
  );
  if (pvcRes.code === 0 && pvcRes.stdout.trim()) {
    const pvcs = pvcRes.stdout.trim().split(/\s+/).filter(Boolean);
    for (const pvc of pvcs) {
      onProgress?.(`Eliminando PVC residual ${pvc}...`);
      await runKubectl(['delete', 'pvc', pvc, '-n', db.namespace], {
        timeoutMs: 30000,
      });
    }
  }

  // 4. Clean up node labels if not shared with another DB
  if (db.labelId) {
    const { key, value } = db.labelId;
    const shared = isLabelSharedByOtherDB(allDbs, db, key, value);
    if (shared) {
      onProgress?.(
        `Label ${key}=${value} está en uso por otra BD: no se remueve de los agentes.`,
      );
    } else {
      const labeledAgents = getAgentNodes(allNodes).filter(
        (n) => n.labels[key] === value,
      );
      for (const agent of labeledAgents) {
        onProgress?.(`Quitando label ${key} del agente ${agent.name}...`);
        await unlabelNode(agent.name, key);
      }
    }
  }

  // 5. Reconcile namespace usage label (skip default & system namespaces)
  if (!isDefaultNamespace(db.namespace) && !isSystemNamespace(db.namespace)) {
    try {
      const freshDbs = await listClusterDBs();
      const stillInUse = await syncNamespaceUsageLabel(db.namespace, freshDbs);
      onProgress?.(
        stillInUse
          ? `Namespace "${db.namespace}" aún tiene otras BDs: se conserva ${KPG_NS_USAGE_LABEL}=true.`
          : `Label ${KPG_NS_USAGE_LABEL} retirado del namespace "${db.namespace}" (sin BDs activas).`,
      );
    } catch {
      // Best-effort namespace usage label sync
    }
  }

  onProgress?.(`Base de datos "${db.name}" eliminada completamente.`);
}

