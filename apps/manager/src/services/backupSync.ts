// Фоновое обновление резервных подписок (внешние провайдеры).
//
// Раз в час (и по кнопке в админке) тянем каждую включённую резервную подписку
// её User-Agent'ом, читаем статистику из заголовка Subscription-Userinfo,
// разбираем список серверов и складываем в пул. Ошибку фетча сохраняем в
// last_error, но прежний список серверов не стираем — резерв должен пережить
// разовый сбой провайдера. Опирается на паттерн services/routingSync.ts.
import * as repo from '../backupRepo.js';
import { parseSubUserinfo, parseSubscription } from '../lib/subParse.js';
import { addJobError } from '../repo.js';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;
/** UA по умолчанию: многие провайдеры отдают конфиги только «клиентским» агентам. */
const DEFAULT_UA = 'v2rayNG/1.9.5';

let running = false;

async function fetchOne(row: any): Promise<void> {
  const id = row.id as string;
  const url = String(row.url || '').trim();
  if (!url) {
    repo.setBackupFetchResult(id, { servers: [], error: 'пустой URL' });
    return;
  }
  const headers: Record<string, string> = {
    'User-Agent': (row.user_agent && String(row.user_agent).trim()) || DEFAULT_UA,
    Accept: 'text/plain, application/json, */*',
  };
  if (row.hwid) headers['X-HWID'] = String(row.hwid);
  if (row.etag) headers['If-None-Match'] = String(row.etag);
  if (row.last_modified) headers['If-Modified-Since'] = String(row.last_modified);

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    repo.setBackupFetchResult(id, { servers: [], error: `сеть: ${e instanceof Error ? e.message : 'ошибка'}` });
    return;
  }

  // 304 — у провайдера ничего не поменялось: список оставляем, только помечаем время.
  if (res.status === 304) {
    repo.setBackupFetchResult(id, {
      servers: repo.listBackupServers(id).map((s) => ({ name: s.name, link: '', host: s.host, port: s.port, protocol: s.protocol })),
      etag: row.etag ?? null,
      lastModified: row.last_modified ?? null,
      error: null,
    });
    return;
  }
  if (res.status < 200 || res.status >= 300) {
    repo.setBackupFetchResult(id, { servers: [], error: `провайдер ответил ${res.status}` });
    return;
  }

  const clen = Number(res.headers.get('content-length') || 0);
  if (Number.isFinite(clen) && clen > MAX_BYTES) {
    try {
      await res.body?.cancel();
    } catch {
      /* уже закрыто */
    }
    repo.setBackupFetchResult(id, { servers: [], error: 'ответ слишком большой' });
    return;
  }

  const provider = parseSubUserinfo(res.headers.get('subscription-userinfo'));
  const body = await res.text();
  const parsed = parseSubscription(body);
  if (parsed.nodes.length === 0) {
    repo.setBackupFetchResult(id, { servers: [], provider, error: 'не удалось разобрать ни одного сервера' });
    return;
  }
  repo.setBackupFetchResult(id, {
    format: parsed.format,
    servers: parsed.nodes.map((n) => ({ name: n.name, link: n.link, host: n.host, port: n.port, protocol: n.protocol })),
    provider,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    error: null,
  });
}

/** Обновить одну подписку по id (кнопка «Обновить» в админке). */
export async function refreshBackup(id: string): Promise<void> {
  const row = repo.getBackupSubscriptionRow(id);
  if (!row) return;
  await fetchOne(row);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const row of repo.listBackupSubscriptionRows()) {
      if (!row.enabled) continue;
      try {
        await fetchOne(row);
      } catch (e) {
        addJobError('backup-sync', e instanceof Error ? e.message : 'ошибка', 'error');
      }
    }
  } finally {
    running = false;
  }
}

export function startBackupSyncLoop(intervalMs = 3_600_000): void {
  const t = setInterval(() => void tick(), intervalMs);
  t.unref?.();
  setTimeout(() => void tick(), 20_000).unref?.();
}
