import type { AgentSummary } from '@emucat/contracts';

export function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Never';
}

const PLATFORM_NAMES: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

export function describePlatform(platform: string | null, architecture: string | null): string {
  if (!platform) return 'Not reported yet';
  const name = PLATFORM_NAMES[platform] ?? platform;
  return architecture ? `${name}, ${architecture}` : name;
}

export function AgentOnlineBadge({ agent }: { agent: AgentSummary }) {
  return agent.online ? (
    <span className="badge text-bg-success">Online</span>
  ) : (
    <span className="badge text-bg-secondary">Offline</span>
  );
}

export function AgentPairingBadge({ agent }: { agent: AgentSummary }) {
  return agent.pairingStatus === 'revoked' ? (
    <span className="badge text-bg-danger">Revoked</span>
  ) : (
    <span className="badge text-bg-primary">Paired</span>
  );
}

export function AgentFacts({ agent }: { agent: AgentSummary }) {
  return (
    <dl className="settings-facts small">
      <dt>Platform</dt>
      <dd>{describePlatform(agent.platform, agent.architecture)}</dd>
      <dt>Version</dt>
      <dd>{agent.agentVersion ?? 'Not reported yet'}</dd>
      <dt>Last seen</dt>
      <dd>{formatTime(agent.lastSeenAt)}</dd>
    </dl>
  );
}
