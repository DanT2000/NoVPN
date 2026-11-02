// Автовыдача Xray на разрешённые серверы (03.11.2026): владелец разрешил себе Францию,
// нажал «Обновить» — а Франции нет: конфиг выдавался только по кнопке.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `novpn-autoissue-${process.pid}-${Math.floor(process.hrtime()[1])}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, 'database.sqlite');
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-secret';

const repo = await import('../src/repo.js');
const { saveServerKeys } = await import('../src/services/keyvault.js');
const { ensureXrayOnAllowedServers } = await import('../src/services/issue.js');

let seq = 0;
function server(name: string, opts: { keys?: boolean; autoIssue?: boolean } = {}) {
  seq++;
  const s = repo.insertServer({ name, country: 'XX', host: `${seq}.vpn.example.com`, protocols: ['xray', 'amneziawg'], endpointOk: true });
  if (opts.keys !== false) saveServerKeys(s.host, { xrayRealityPubKey: 'pbk', xrayShortId: 'sid', xraySni: 'www.asus.com' });
  if (opts.autoIssue === false) repo.updateServerFields(s.id, { auto_issue: 0 });
  return repo.getServer(s.id)!;
}
function user(allowed: string[], withXrayOn?: string) {
  seq++;
  const u = repo.insertUser({
    name: `Человек ${seq}`, comment: '', category: null, tags: [], code: `ai${seq}`,
    deviceLimit: 3, expiresAt: null, trafficLimitGb: null, resetPolicy: 'never',
    allowedServers: allowed, allowedProtocols: ['xray', 'amneziawg'],
  });
  if (withXrayOn) repo.insertDevice({ userId: u.id, name: 'Подписка', serverId: withXrayOn, protocol: 'xray', uuid: `u${seq}`, publicKey: 'k', link: 'vless://x' });
  return repo.getUser(u.id)!;
}
const errorsFor = (serverName: string) => repo.listJobErrors().filter((e: { server: string; text: string }) => e.server === serverName);

test('разрешён новый сервер без конфига — панель пытается выдать Xray, сбой виден в ошибках', async () => {
  const fin = server('Финляндия');
  const fr = server('Франция-1');
  const u = user([fin.id, fr.id], fin.id);
  const n = await ensureXrayOnAllowedServers(u);
  assert.equal(n, 0, 'в тесте SSH нет — выдача не проходит');
  const errs = errorsFor('Франция-1');
  assert.equal(errs.length, 1, 'попытка была именно на Францию');
  assert.match(errs[0]!.text, new RegExp(`Автовыдача Xray для «${u.name}»`));
  assert.equal(errorsFor('Финляндия').length, 0, 'где конфиг уже есть — не трогаем');
});

test('повторное обновление подписки сразу — без новой попытки (не долбим сервер)', async () => {
  const fin = server('Финляндия-2');
  const fr = server('Франция-2');
  const u = user([fin.id, fr.id], fin.id);
  await ensureXrayOnAllowedServers(u);
  await ensureXrayOnAllowedServers(u);
  assert.equal(errorsFor('Франция-2').length, 1);
});

test('не выдаём: сервер не разрешён, без ключей, с выключенной самовыдачей, человек без Xray', async () => {
  const fin = server('Финляндия-3');
  const notAllowed = server('Чужой');
  const noKeys = server('Без ключей', { keys: false });
  const noAuto = server('Без самовыдачи', { autoIssue: false });
  await ensureXrayOnAllowedServers(user([fin.id, noKeys.id, noAuto.id], fin.id));
  await ensureXrayOnAllowedServers(user([fin.id, notAllowed.id]));
  for (const s of ['Чужой', 'Без ключей', 'Без самовыдачи']) assert.equal(errorsFor(s).length, 0, s);
});
