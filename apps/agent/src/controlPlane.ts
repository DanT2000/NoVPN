// Клиент control plane. Все соединения ИСХОДЯЩИЕ (работает за NAT).
// Запросы подписываются ключом агента (взаимная аутентификация).

import { config } from './config.js';
import { loadIdentity, saveIdentity, sign, type Identity } from './identity.js';
import type { AuditReport } from './audit.js';

export interface AgentJob {
  id: string;
  type: 'create' | 'revoke' | 'import' | 'audit' | 'traffic' | 'healthcheck';
  payload: Record<string, unknown>;
}

async function request<T>(method: string, pathname: string, body: unknown, id: Identity): Promise<T> {
  const ts = new Date().toISOString();
  const raw = body == null ? '' : JSON.stringify(body);
  const signature = id.agentId ? sign(id, `${ts}.${raw}`) : '';
  const res = await fetch(`${config.controlPlaneUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-agent-id': id.agentId ?? '',
      'x-agent-ts': ts,
      'x-agent-sign': signature,
    },
    body: method === 'GET' ? undefined : raw,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error?.message) || `control plane ${res.status}`);
  return data as T;
}

/** Регистрация: обмен enrollment-token на постоянную идентичность. */
export async function enroll(id: Identity, audit: AuditReport): Promise<Identity> {
  const out = await request<{ agentId: string; serverId: string }>(
    'POST',
    '/api/agent/enroll',
    { enrollmentToken: config.enrollmentToken, publicKeyPem: id.publicKeyPem, version: config.version, audit },
    id,
  );
  const next: Identity = { ...id, agentId: out.agentId, serverId: out.serverId, enrolledAt: new Date().toISOString() };
  saveIdentity(next);
  return next;
}

export async function heartbeat(id: Identity, health: Record<string, unknown>): Promise<void> {
  await request('POST', '/api/agent/heartbeat', { version: config.version, health }, id);
}

export async function pollJobs(id: Identity): Promise<AgentJob[]> {
  const out = await request<{ jobs: AgentJob[] }>('GET', '/api/agent/jobs/next', null, id);
  return out.jobs ?? [];
}

export async function reportJob(id: Identity, jobId: string, result: unknown, error: string | null): Promise<void> {
  await request('POST', `/api/agent/jobs/${jobId}/report`, { result, error }, id);
}

export async function reportTraffic(id: Identity, samples: unknown): Promise<void> {
  await request('POST', '/api/agent/traffic', { samples }, id);
}

export { loadIdentity };
