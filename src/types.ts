export interface SupportEvent {
  id: string;
  source: 'chatwoot' | 'openphone';
  channel: 'chat' | 'call' | 'sms';
  externalId: string;
  contactName: string;
  content: string;
  status: 'open' | 'pending' | 'resolved';
  receivedAt: Date;
  clusterId: string | null;
  clusterLabel: string | null;
  severity: 'high' | 'medium' | 'low' | null;
}

export interface Cluster {
  id: string;
  label: string;
  slug: string;
  centroid: number[] | null;
  conversationCount: number;
  severity: 'high' | 'medium' | 'low' | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClusterWithEvents extends Cluster {
  events: SupportEvent[];
}

export interface DashboardState {
  clusters: ClusterWithEvents[];
  metrics: {
    openConversations: number;
    activeClusters: number;
    criticalClusters: number;
    avgFirstResponseMinutes: number;
  };
  recentEvents: SupportEvent[];
  clusteringStatus: {
    model: string;
    threshold: number;
    avgEmbedLatencyMs: number;
    clusteredToday: number;
    labelsAppliedToday: number;
  };
}

export type WsMessage =
  | { type: 'state'; payload: DashboardState }
  | { type: 'event'; payload: SupportEvent }
  | { type: 'cluster_update'; payload: Cluster };
