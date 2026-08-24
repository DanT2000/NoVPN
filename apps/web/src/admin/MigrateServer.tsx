import { useState } from 'react';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import { Chip, Field, ProgressBar, ScreenHeader } from '../components/ui';

type Audit = Awaited<ReturnType<typeof api.testServerConnection>>;

type Proto = 'xray' | 'amneziawg' | 'http' | 'https' | 'socks5';

/** Мастер «Перенести сервер»: тот же endpoint (домен/ключи/конфиги сохраняются), новый
 *  физический бокс. Под капотом — editServer(новый SSH) + provision в режиме восстановления
 *  + DNS-сверка. Домен НЕ меняется (на него завязаны выданные конфиги). */
export function MigrateServer() {
  const { data, nav, goAdmin, showToast, reload } = useApp();
  const server = data?.servers.find((s) => s.id === nav.params.serverId);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [host, setHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [auth, setAuth] = useState<'key' | 'password'>('password');
  const [secret, setSecret] = useState('');
  const [testing, setTesting] = useState(false);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [compsOverride, setCompsOverride] = useState<Proto[] | null>(null);
  const [pct, setPct] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [dns, setDns] = useState<{ resolved: string[]; boxIp: string | null; match: boolean } | null>(null);
  const [dnsBusy, setDnsBusy] = useState(false);

  if (!server) {
    return (
      <div>
        <ScreenHeader back={() => goAdmin('servers')} title="Перенести сервер" />
        <div className="card">Сервер не найден. <button className="btn btn-outline btn-sm" onClick={() => goAdmin('servers')}>К серверам</button></div>
      </div>
    );
  }

  const protos = server.protocols as Proto[];
  const comps = compsOverride ?? protos;
  const toggleComp = (p: Proto) =>
    setCompsOverride((cur) => {
      const base = cur ?? protos;
      return base.includes(p) ? base.filter((x) => x !== p) : [...base, p];
    });
  const PROTO_LABEL: Record<Proto, string> = { xray: 'Xray', amneziawg: 'AmneziaWG', http: 'HTTP-прокси', https: 'HTTPS-прокси', socks5: 'SOCKS5' };
  const canTest = !!host.trim() && !!secret.trim();
  const sshOk = !!audit && (audit.audit.find((a) => a.name?.includes('Вход'))?.ok ?? audit.ok);

  const test = async () => {
    setTesting(true);
    setAudit(null);
    try {
      setAudit(
        await api.testServerConnection({
          name: server.name, host: host.trim(), sshPort: Number(sshPort) || 22, sshUser: sshUser.trim() || 'root',
          authMethod: auth, secret: secret.trim(), components: protos,
          country: server.country ?? null, flagEmoji: server.flagEmoji ?? null,
        }),
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Ошибка проверки');
    } finally {
      setTesting(false);
    }
  };

  const checkDns = async () => {
    setDnsBusy(true);
    try {
      const r = await api.dnsCheck(server.id);
      setDns({ resolved: r.resolved, boxIp: r.boxIp, match: r.match });
    } catch {
      setDns(null);
    } finally {
      setDnsBusy(false);
    }
  };

  const migrate = async () => {
    if (!confirmed || !sshOk) return;
    setErr(null);
    setLog([]);
    setPct(5);
    setStep(2);
    try {
      await api.editServer(server.id, { sshHost: host.trim(), sshPort: Number(sshPort) || 22, sshUser: sshUser.trim() || 'root', secret: secret.trim() });
      await api.provisionServer(server.id, comps);
      const poll = async (): Promise<void> => {
        const st = await api.provisionStatus(server.id);
        setLog((l) => (l[l.length - 1] === st.message ? l : [...l, st.message]));
        if (st.state === 'running') {
          setPct((p) => Math.min(90, p + 6));
          setTimeout(() => void poll(), 2500);
          return;
        }
        if (st.state === 'error') {
          setErr(st.message || 'Ошибка установки');
          return;
        }
        setPct(100);
        setStep(3);
        void reload();
        void checkDns();
      };
      void poll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка переноса');
    }
  };

  return (
    <div>
      <ScreenHeader back={() => goAdmin('servers')} eyebrow="Серверы" title={`Перенести «${server.name}»`} />

      {step === 1 && (
        <div className="card" style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
          <div className="small muted">
            Ты переносишь этот сервер на <b>новый бокс</b>: домен, ключи и все выданные конфиги сохраняются, меняется только физическая машина.
            Введи доступ к новому боксу — панель зальёт на него те же ключи и вернёт всех пользователей. Предыдущий бокс будет заменён.
          </div>
          <Field label="Домен (не меняется — на него завязаны выданные конфиги)">
            <input className="input" value={server.host} disabled />
          </Field>
          <Field label="IP нового бокса">
            <input className="input" placeholder="напр. 95.182.88.4" value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
          <div className="row" style={{ gap: 8 }}>
            <Field label="SSH-порт"><input className="input" value={sshPort} onChange={(e) => setSshPort(e.target.value)} style={{ width: 90 }} /></Field>
            <Field label="Пользователь"><input className="input" value={sshUser} onChange={(e) => setSshUser(e.target.value)} /></Field>
          </div>
          <div className="chip-row">
            <Chip label="Пароль" size="sm" active={auth === 'password'} onClick={() => setAuth('password')} />
            <Chip label="Приватный ключ" size="sm" active={auth === 'key'} onClick={() => setAuth('key')} />
          </div>
          <Field label={auth === 'password' ? 'Пароль root' : 'Приватный ключ'}>
            {auth === 'password' ? (
              <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
            ) : (
              <textarea className="input mono" rows={4} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
            )}
          </Field>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-secondary btn-sm" disabled={!canTest || testing} onClick={() => void test()}>{testing ? 'Проверяю…' : 'Проверить SSH'}</button>
          </div>
          {audit && (
            <div className="small" style={{ display: 'grid', gap: 3 }}>
              {audit.audit.map((a, i) => (<div key={i}>{a.ok ? '✅' : '⚠️'} {a.name}{a.note ? ` — ${a.note}` : ''}</div>))}
            </div>
          )}
          {sshOk && (
            <div>
              <div className="small muted" style={{ marginBottom: 6 }}>Что перенести на новый бокс (по умолчанию — всё как было; можно, например, без прокси):</div>
              <div className="chip-row">
                {protos.map((p) => (
                  <Chip key={p} label={PROTO_LABEL[p]} size="sm" active={comps.includes(p)} onClick={() => toggleComp(p)} />
                ))}
              </div>
            </div>
          )}
          <label className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span className="small">Понимаю: предыдущий бокс заменяется, все конфиги переезжают на новый.</span>
          </label>
          <button className="btn btn-primary" disabled={!sshOk || !confirmed} onClick={() => void migrate()}>Перенести на новый бокс</button>
        </div>
      )}

      {step === 2 && (
        <div className="card" style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
          <div className="body">Переношу на новый бокс… (обычно 3–6 минут)</div>
          <ProgressBar pct={pct} />
          <div className="small mono muted" style={{ display: 'grid', gap: 2 }}>{log.map((l, i) => (<div key={i}>{l}</div>))}</div>
          {err && (
            <div className="small" style={{ color: 'var(--red-fg)' }}>
              Ошибка: {err} <button className="btn btn-outline btn-sm" onClick={() => setStep(1)}>Назад к доступам</button>
            </div>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="card" style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
          <div className="body">✅ Перенос завершён — ключи и все конфиги восстановлены на новом боксе.</div>
          <div className="small muted">Теперь домен <b>{server.host}</b> должен указывать на новый IP. Если ещё не сделал — обнови A-запись у DNS-провайдера. Пропагация до ~10 минут.</div>
          <div className="card" style={{ background: 'var(--surface-btn-2, #1e1e1e)' }}>
            <div className="small" style={{ marginBottom: 4 }}>DNS-сверка:</div>
            {dnsBusy ? (
              <div className="small muted">Проверяю…</div>
            ) : dns ? (
              <div className="small" style={{ display: 'grid', gap: 2 }}>
                <div>Домен резолвится в: <b>{dns.resolved.length ? dns.resolved.join(', ') : '—'}</b></div>
                <div>Новый бокс: <b>{dns.boxIp ?? '—'}</b></div>
                <div>{dns.match ? '✅ DNS сошёлся — трафик идёт на новый бокс.' : '⏳ DNS ещё не догнал. Подожди ~10 минут и проверь ещё раз.'}</div>
              </div>
            ) : (
              <div className="small muted">—</div>
            )}
            <button className="btn btn-outline btn-sm" style={{ marginTop: 8 }} disabled={dnsBusy} onClick={() => void checkDns()}>Проверить ещё раз</button>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => goAdmin('servers')}>К серверам</button>
        </div>
      )}
    </div>
  );
}
