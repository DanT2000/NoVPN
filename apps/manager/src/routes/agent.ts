// Серверная сторона протокола агента. Соединения инициирует агент (исходящие).
// Взаимная аутентификация: агент подписывает `${ts}.${rawBody}` своим ключом,
// панель проверяет публичным ключом, сохранённым при регистрации.

import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import * as repo from '../repo.js';
import { decryptSecret } from '../lib/crypto.js';

export const agentRouter = Router();

const err = (type: string, message: string) => ({ error: { type, message } });

/** Проверка подписи. Возвращает serverId (agentId) или null. */
function verifyAgent(req: Request): string | null {
  const agentId = req.header('x-agent-id');
  const ts = req.header('x-agent-ts');
  const sign = req.header('x-agent-sign');
  if (!agentId || !ts || !sign) return null;
  // Защита от повторов: метка не старше 5 минут.
  if (Math.abs(Date.now() - Date.parse(ts)) > 5 * 60 * 1000) return null;
  const keyPem = repo.getServerAgentKey(agentId);
  if (!keyPem) return null;
  const raw = (req as Request & { rawBody?: string }).rawBody ?? '';
  try {
    const ok = crypto.verify(null, Buffer.from(`${ts}.${raw}`), crypto.createPublicKey(keyPem), Buffer.from(sign, 'base64'));
    return ok ? agentId : null;
  } catch {
    return null;
  }
}

// Регистрация: обмен одноразового enrollment-token на закрепление агента.
agentRouter.post('/api/agent/enroll', (req, res) => {
  const { enrollmentToken, publicKeyPem, version } = req.body ?? {};
  if (!enrollmentToken || !publicKeyPem) return res.status(400).json(err('validation', 'Нужны enrollmentToken и publicKeyPem.'));
  const result = repo.enrollAgent(
    (enc) => {
      try {
        return decryptSecret(enc) === String(enrollmentToken);
      } catch {
        return false;
      }
    },
    String(publicKeyPem),
    String(version ?? '0.0.0'),
  );
  if (!result) return res.status(401).json(err('unauthorized', 'Enrollment token недействителен или уже использован.'));
  repo.addLog(`Агент зарегистрирован на сервере ${result.serverId}`);
  // agentId = serverId (одна установка агента на сервер).
  res.json({ agentId: result.serverId, serverId: result.serverId });
});

agentRouter.post('/api/agent/heartbeat', (req, res) => {
  const agentId = verifyAgent(req);
  if (!agentId) return res.status(401).json(err('unauthorized', 'Подпись агента недействительна.'));
  const health = req.body?.health ?? {};
  const healthy = !!(health?.xray?.healthy || health?.amneziawg?.healthy);
  repo.agentHeartbeat(agentId, healthy, String(req.body?.version ?? '0.0.0'));
  res.json({ ok: true });
});

agentRouter.get('/api/agent/jobs/next', (req, res) => {
  const agentId = verifyAgent(req);
  if (!agentId) return res.status(401).json(err('unauthorized', 'Подпись агента недействительна.'));
  // TODO(jobs): выдача очереди заданий для сервера. Пока — пусто.
  res.json({ jobs: [] });
});

agentRouter.post('/api/agent/jobs/:id/report', (req, res) => {
  const agentId = verifyAgent(req);
  if (!agentId) return res.status(401).json(err('unauthorized', 'Подпись агента недействительна.'));
  // TODO(jobs): применить результат задания (create/import/...).
  res.json({ ok: true });
});

agentRouter.post('/api/agent/traffic', (req, res) => {
  const agentId = verifyAgent(req);
  if (!agentId) return res.status(401).json(err('unauthorized', 'Подпись агента недействительна.'));
  const samples = req.body?.samples ?? {};
  for (const list of Object.values(samples)) {
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      if (s && s.available && s.ref?.id) {
        repo.applyTrafficSample(agentId, String(s.ref.id), s.receivedBytes ?? null, s.sentBytes ?? null, s.lastHandshakeAt ?? null);
      }
    }
  }
  res.json({ ok: true });
});
