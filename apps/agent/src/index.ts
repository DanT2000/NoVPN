// Точка входа агента: аудит → регистрация (если нужно) → локальный health →
// циклы heartbeat и обработки заданий. Все сетевые вызовы — исходящие.

import http from 'node:http';
import { config } from './config.js';
import { loadIdentity, saveIdentity, type Identity } from './identity.js';
import { enroll, heartbeat, pollJobs, reportJob, reportTraffic } from './controlPlane.js';
import { runAudit } from './audit.js';
import { runJob, readOutbox, writeOutbox, enqueueResult } from './jobs.js';
import { xrayDriver } from './drivers/xray.js';
import { amneziawgDriver } from './drivers/amneziawg.js';

const log = (...a: unknown[]) => console.log('[novpn-agent]', ...a);

async function collectHealth() {
  const [xray, awg] = await Promise.all([
    xrayDriver.healthcheck().catch(() => ({ installed: false, healthy: false, note: 'ошибка' })),
    amneziawgDriver.healthcheck().catch(() => ({ installed: false, healthy: false, note: 'ошибка' })),
  ]);
  return { xray, amneziawg: awg };
}

/** Локальный read-only health (не даёт браузеру произвольный shell). */
function startHealthServer() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const health = await collectHealth();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'novpn-agent', version: config.version, health }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(config.healthPort, () => log(`health на :${config.healthPort}`));
}

async function flushOutbox(id: Identity) {
  const pending = readOutbox();
  if (!pending.length) return;
  const still: typeof pending = [];
  for (const e of pending) {
    try {
      await reportJob(id, e.jobId, e.result, e.error);
    } catch {
      still.push(e);
    }
  }
  writeOutbox(still);
}

async function processJobs(id: Identity) {
  let jobs;
  try {
    jobs = await pollJobs(id);
  } catch {
    return; // панель недоступна — попробуем позже (очередь сохранится)
  }
  for (const job of jobs) {
    try {
      const result = await runJob(job);
      try {
        await reportJob(id, job.id, result, null);
      } catch {
        enqueueResult({ jobId: job.id, result, error: null });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : 'ошибка задания';
      try {
        await reportJob(id, job.id, null, error);
      } catch {
        enqueueResult({ jobId: job.id, result: null, error });
      }
    }
  }
}

async function main() {
  let id = loadIdentity();
  log(`версия ${config.version}, control plane ${config.controlPlaneUrl}`);

  const audit = await runAudit().catch((e) => {
    log('аудит не удался:', e instanceof Error ? e.message : e);
    return null;
  });
  if (audit) log('аудит:', JSON.stringify(audit.detected), 'контейнеры:', audit.containers.join(',') || '—');

  if (!id.agentId && config.enrollmentToken) {
    try {
      id = await enroll(id, audit ?? ({} as never));
      log('зарегистрирован как', id.agentId, 'сервер', id.serverId);
    } catch (e) {
      log('регистрация не удалась (повтор при перезапуске):', e instanceof Error ? e.message : e);
    }
  } else if (!id.agentId) {
    log('нет enrollment token и агент не зарегистрирован — работаю в локальном режиме (только health/аудит)');
  }
  saveIdentity(id);

  startHealthServer();

  setInterval(() => {
    if (!id.agentId) return;
    void (async () => {
      try {
        await heartbeat(id, await collectHealth());
        await flushOutbox(id);
      } catch {
        /* панель недоступна */
      }
    })();
  }, config.heartbeatSec * 1000);

  setInterval(() => {
    if (!id.agentId) return;
    void processJobs(id);
  }, config.jobPollSec * 1000);

  // периодическая отправка трафика
  setInterval(() => {
    if (!id.agentId) return;
    void (async () => {
      try {
        const t = await runJob({ id: 'traffic', type: 'traffic', payload: {} });
        await reportTraffic(id, t);
      } catch {
        /* ignore */
      }
    })();
  }, Math.max(60, config.heartbeatSec * 3) * 1000);
}

void main();
