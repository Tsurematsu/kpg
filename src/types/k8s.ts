export interface KubectlConnectionStatus {
  installed: boolean;
  connected: boolean;
  context: string;
  serverUrl: string;
  clientVersion: string;
  serverVersion: string;
  error?: string;
}

export interface CnpgPluginStatus {
  installed: boolean;
  path?: string;
}

export interface OperatorStatus {
  installed: boolean;
  ready: boolean;
  podName?: string;
  nodeName?: string;
  phase?: string;
  replicas: number;
  readyReplicas: number;
  version?: string;
}

export interface NodeInfo {
  name: string;
  isControlPlane: boolean;
  ready: boolean;
  roles: string[];
  internalIp: string;
  labels: Record<string, string>;
  customLabels: Record<string, string>;
}

export interface ReplicaPodInfo {
  name: string;
  instanceNumber: number | null;
  nodeName: string;
  role: 'primary' | 'replica' | 'unknown';
  phase: string;
  ready: boolean;
  restarts: number;
  podIp: string;
}

export interface LabelSelectorEntry {
  key: string;
  value: string;
  shortId: string;
  display: string;
}

export type ClusterPowerState = 'running' | 'hibernating' | 'hibernated' | 'waking';

export interface ClusterDBInfo {
  name: string;
  namespace: string;
  instances: number;
  readyInstances: number;
  phase: string;
  healthy: boolean;
  hibernated: boolean;
  powerState: ClusterPowerState;
  currentPrimary: string;
  primaryNode: string;
  replicas: ReplicaPodInfo[];
  pods: ReplicaPodInfo[];
  pvcs: string[];
  nodeSelector: Record<string, string>;
  labelId: LabelSelectorEntry | null;
  imageName: string;
  storageSize: string;
  storageClass: string;
}

export interface NamespaceInfo {
  name: string;
  status: string;
  isSystem: boolean;
  isDefault: boolean;
  labels: Record<string, string>;
  customLabels: Record<string, string>;
  usedByKpg: boolean;
  otherToolLabels: Record<string, string>;
}

export interface ClusterSnapshot {
  nodes: NodeInfo[];
  namespaces: NamespaceInfo[];
  dbs: ClusterDBInfo[];
  operator: OperatorStatus;
  fetchedAt: Date;
}
