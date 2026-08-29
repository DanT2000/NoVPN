// A6 — Серверы. Список серверов с метриками, редактированием и управлением выдачей.

import type React from 'react';
import { useEffect, useState } from 'react';
import type { Server } from '@novpn/shared';
import { PROTOCOL_LABELS } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import type { ServerProxyConfig, EndpointConfigView } from '../api/types';
import { copyText } from '../lib/clipboard';
import { Chip, Dot, EmptyState, Field, ScreenHeader, Toggle } from '../components/ui';
import { serverAgentView, serverEndpointView } from '../lib/status';
import { gb, plural, rel } from '../lib/format';
import { COUNTRIES, countryValue } from '../lib/countries';

type Proto = 'xray' | 'amneziawg' | 'http' | 'https' | 'socks5';

// HTTPS-прокси выпускает TLS-сертификат через certbot по HTTP-01 — это работает
// только для ДОМЕНА (не голого IP). Чип HTTPS доступен лишь когда адрес сервера — домен.
const isIpLike = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h.trim()) || h.includes(':');
const hostIsDomain = (h: string) => {
  const t = (h || '').trim();
  return !!t && !isIpLike(t) && /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(t);
};

function ProxyBox({ proxy }: { proxy: ServerProxyConfig }) {
  const { showToast } = useApp();
  const line = (label: string, val: string) => (
    <div className="row-between" style={{ gap: 8 }}>
      <span className="small muted">{label}</span>
      <span className="mono small" style={{ wordBreak: 'break-all' }}>{val}</span>
    </div>
  );
  return (
    <div className="notice notice-green" style={{ display: 'grid', gap: 4 }}>
      <div style={{ fontWeight: 700 }}>Прокси установлены</div>
      {line('Логин', proxy.user)}
      {line('Пароль', proxy.pass)}
      {proxy.httpPort ? line('HTTP', `${proxy.user}:${proxy.pass}@host:${proxy.httpPort}`) : null}
      {proxy.socksPort ? line('SOCKS5', `${proxy.user}:${proxy.pass}@host:${proxy.socksPort}`) : null}
      {proxy.httpsPort ? line('HTTPS', `${proxy.user}:${proxy.pass}@${proxy.httpsHost}:${proxy.httpsPort}`) : null}
      <button
        className="btn btn-outline btn-sm"
        style={{ marginTop: 6, justifySelf: 'start' }}
        onClick={async () => {
          await copyText(`login: ${proxy.user}\npassword: ${proxy.pass}` +
            (proxy.httpPort ? `\nHTTP: host:${proxy.httpPort}` : '') +
            (proxy.socksPort ? `\nSOCKS5: host:${proxy.socksPort}` : '') +
            (proxy.httpsPort ? `\nHTTPS: ${proxy.httpsHost}:${proxy.httpsPort}` : ''));
          showToast('Скопировано');
        }}
      >
        Копировать
      </button>
    </div>
  );
}

const FB_TYPES: Array<{ v: 'https' | 'http' | 'socks'; label: string }> = [
  { v: 'https', label: 'HTTPS' },
  { v: 'http', label: 'HTTP' },
  { v: 'socks', label: 'SOCKS5' },
];

/** Гибкий разбор времени автосброса → часы (дробное). Разделитель часы/минуты
 *  (двоеточие, пробел, дефис, слэш) → «Ч М» = Ч часов М минут; точка/запятая →
 *  десятичные часы. Примеры: «1:30» / «1 30» → 1.5; «1,5» / «1.5» → 1.5; «2» → 2;
 *  пусто / «0» → 0 (таймер не запускается). */
export function parseTimeoutHours(raw: string): number {
  const s = raw.trim();
  if (!s) return 0;
  const hm = s.match(/^(\d+)\s*[:\s\-/]\s*(\d{1,2})$/);
  if (hm) {
    const h = parseInt(hm[1]!, 10);
    const m = Math.min(59, parseInt(hm[2]!, 10));
    return h + m / 60;
  }
  const dec = parseFloat(s.replace(',', '.'));
  return Number.isFinite(dec) && dec > 0 ? dec : 0;
}

/** Часы (дробное) → «Ч:ММ» для показа. Ровные часы — без минут («2»). 0 → «0». */
export function formatTimeoutHours(hours: number | null | undefined): string {
  if (!hours || hours <= 0) return '0';
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? String(h) : `${h}:${String(m).padStart(2, '0')}`;
}

/** Пер-серверные настройки генерации конфига (маршрутизация НА УСТРОЙСТВЕ). У каждого
 *  сервера могут быть свои обход-домены, LAN-доступ и набор запасных прокси. */
function EndpointConfigPanel({ server }: { server: Server }) {
  const { showToast } = useApp();
  const [cfg, setCfg] = useState<EndpointConfigView | null>(null);
  const [wl, setWl] = useState('');
  const [busy, setBusy] = useState(false);
  // Поле времени автосброса — свободный текст («1:30», «1,5»…), приводим при сохранении.
  const [timeoutText, setTimeoutText] = useState('0');

  useEffect(() => {
    let alive = true;
    api.getEndpointProfile(server.host).then((r) => {
      if (!alive) return;
      setCfg(r.config);
      setWl((r.config.whitelistDomains ?? []).join('\n'));
    }).catch(() => { if (alive) setCfg({ xrayWhitelist: true, profiles: 'both', smartDirection: 'match-vpn', smartSource: 'autoroute', whitelistDomains: undefined, lanAccess: false, fakeDns: false, fullTimeoutHours: 0, fallbackTypes: null }); });
    return () => { alive = false; };
  }, [server.host]);

  // Показ поля синхронизируем с сохранённым значением («1.5» → «1:30»).
  useEffect(() => {
    if (cfg) setTimeoutText(formatTimeoutHours(cfg.fullTimeoutHours));
  }, [cfg?.fullTimeoutHours]);

  if (!cfg) return <div className="small muted">Загрузка настроек…</div>;

  const save = async (patch: Partial<EndpointConfigView>) => {
    setBusy(true);
    try {
      const r = await api.saveEndpointConfig(server.id, patch);
      setCfg(r.config);
      showToast('Настройки сервера сохранены');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };
  const fb = cfg.fallbackTypes; // null = все
  const toggleFb = (v: 'https' | 'http' | 'socks') => {
    const cur = fb ?? ['https', 'http', 'socks'];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    void save({ fallbackTypes: next.length === 3 ? null : next });
  };

  return (
    <div className="field" style={{ borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}>
      <span className="field-label">Настройки конфига (этот сервер)</span>
      <div className="body small muted" style={{ marginBottom: 10 }}>
        Это параметры, которые уходят <b>в конфиг на устройство</b> пользователя (маршрутизация
        для стабильного соединения) — не серверная служба. У каждого сервера свои: например,
        в одной стране один список обхода, в другой — другой.
      </div>

      <div className="body small muted" style={{ margin: '0 0 4px' }}>Что получает пользователь этого сервера:</div>
      <div className="chip-row" style={{ marginBottom: 6 }}>
        <Chip label="Умный профиль + полный VPN" active={cfg.profiles === 'both'} disabled={busy} onClick={() => void save({ profiles: 'both' })} />
        <Chip label="Только полный VPN" active={cfg.profiles === 'full'} disabled={busy} onClick={() => void save({ profiles: 'full' })} />
        <Chip label="Только умный профиль" active={cfg.profiles === 'smart'} disabled={busy} onClick={() => void save({ profiles: 'smart' })} />
      </div>
      <div className="body small muted" style={{ marginBottom: 10 }}>
        {cfg.profiles === 'both'
          ? 'Два профиля: умный первым (рекомендуемый — что не работает в России идёт через VPN, остальное напрямую) и полный VPN вторым (весь трафик в туннель). Выбирает сам человек; лишний трафик — его лимиты.'
          : cfg.profiles === 'smart'
            ? 'Один профиль — умный. Полный VPN человек получить не сможет: весь трафик через туннель этот сервер не отдаёт.'
            : 'Один профиль: весь трафик через VPN без исключений. Список доменов ниже не применяется.'}
      </div>

      {cfg.profiles === 'both' ? (
        <div className="field" style={{ marginBottom: 10 }}>
          <span className="field-label">Авто-сброс на умную маршрутизацию</span>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              style={{ maxWidth: 110 }}
              type="text"
              inputMode="text"
              placeholder="0"
              value={timeoutText}
              disabled={busy}
              onChange={(e) => setTimeoutText(e.target.value)}
              onBlur={() => {
                const hours = parseTimeoutHours(timeoutText);
                setTimeoutText(formatTimeoutHours(hours));
                if (hours !== (cfg.fullTimeoutHours ?? 0)) void save({ fullTimeoutHours: hours });
              }}
            />
            <span className="small muted">
              {parseTimeoutHours(timeoutText) > 0
                ? `= ${formatTimeoutHours(parseTimeoutHours(timeoutText))} (ч:мм) · 0 — не сбрасывать`
                : '0 — не сбрасывать (человек сам решает)'}
            </span>
          </div>
          <div className="body small muted" style={{ marginTop: 6 }}>
            Это <b>не лимит сессии</b>, а напоминание: если человек включил полный VPN «на разок»
            и забыл, приложение само вернёт его на умную маршрутизацию через это время (умная —
            рекомендуемый режим). <b>0 — таймер не запускается</b>: переключаться между умной и
            полной можно сколько угодно.
            <br />
            Формат гибкий: <b>1:30</b>, <b>1 30</b> — час тридцать; <b>1.5</b> или <b>1,5</b> —
            тоже полтора часа; <b>2</b> — два часа. Показываем как <b>ч:мм</b>.
            <br />
            <b>Работает в приложении NoVPN</b>: другие клиенты (Happ, v2rayNG) выбирают профиль
            сами, заставить их сервер не может.
          </div>
        </div>
      ) : null}

      {cfg.profiles !== 'full' ? (
        <>
          <div className="body small muted" style={{ margin: '6px 0 4px' }}>Как работает умный профиль:</div>
          <div className="chip-row" style={{ marginBottom: 4 }}>
            <Chip
              label="Умная маршрутизация: база AutoRoute → в VPN, остальное напрямую"
              active={cfg.smartDirection === 'match-vpn'}
              disabled={busy}
              onClick={() => void save({ smartSource: 'autoroute', smartDirection: 'match-vpn' })}
            />
            <Chip
              label="Свой список → напрямую, остальное через VPN"
              active={cfg.smartDirection === 'match-direct'}
              disabled={busy}
              onClick={() => void save({ smartSource: 'local', smartDirection: 'match-direct' })}
            />
          </div>
          <div className="body small muted" style={{ marginBottom: 10 }}>
            {cfg.smartDirection === 'match-direct'
              ? 'Через VPN идёт всё, кроме списка ниже: он остаётся напрямую. Подходит, когда проще перечислить исключения, чем то, что нужно туннелировать.'
              : 'Основной режим. База собирается в разделе AutoRoute, свои домены ниже дополняют её.'}
          </div>
        </>
      ) : null}

      <div className="chip-row" style={{ marginBottom: 6 }}>
        <Chip label={cfg.lanAccess ? 'Доступ в локалку: вкл' : 'Доступ в локалку: выкл'} active={cfg.lanAccess} disabled={busy} onClick={() => void save({ lanAccess: !cfg.lanAccess })} />
        {cfg.profiles !== 'full' ? (
          <Chip label={cfg.fakeDns ? 'Подмена DNS: вкл' : 'Подмена DNS: выкл'} active={cfg.fakeDns} disabled={busy} onClick={() => void save({ fakeDns: !cfg.fakeDns })} />
        ) : null}
      </div>
      {cfg.profiles !== 'full' ? (
        <div className="body small muted" style={{ marginBottom: 10 }}>
          По умолчанию выключена и в обычной ситуации не нужна. Нужна там, где домена в трафике не видно: TLS
          с зашифрованным именем сайта (ECH) и не-HTTP протоколы — без неё такие соединения распределяются только
          по IP. Имена продолжает разрешать DNS самого устройства, подменённые адреса живут 1 секунду и в кэшах
          не оседают. Приложения со своим DNS-over-HTTPS подмену обходят. Полного VPN не касается: там весь трафик
          и так в туннеле.
        </div>
      ) : null}

      <div className="body small muted" style={{ margin: '10px 0 4px' }}>Запасные каналы (если Xray заблокируют) — только то, что реально работает на этом сервере:</div>
      <div className="chip-row" style={{ marginBottom: 6 }}>
        {FB_TYPES.map((t) => {
          const on = !fb || fb.includes(t.v);
          return <Chip key={t.v} label={t.label} size="sm" active={on} disabled={busy} onClick={() => toggleFb(t.v)} />;
        })}
      </div>

      <Field
        label="Свои домены этого сервера (по одному в строке)"
        hint={
          cfg.smartDirection === 'match-direct'
            ? 'Идут напрямую, мимо VPN. Просто «ya.ru» = и поддомены; «full:go.yandex» = точное совпадение. Пусто → глобальный/встроенный список. Меняется без переустановки.'
            : 'Дополняют список «в VPN»: просто «example.com» = и поддомены; «full:x.y» = точное совпадение. В полном профиле не применяются. Меняется без переустановки.'
        }
      >
        <textarea
          className="textarea mono"
          style={{ minHeight: 120, fontSize: 12 }}
          spellCheck={false}
          placeholder={'ya.ru\nmail.ru\nvk.com\nozon.ru\ngosuslugi.ru'}
          value={wl}
          onChange={(e) => setWl(e.target.value)}
          onBlur={() => {
            const lines = wl.split('\n').map((l) => l.trim()).filter(Boolean);
            void save({ whitelistDomains: lines.length ? lines : null } as Partial<EndpointConfigView>);
          }}
        />
      </Field>
    </div>
  );
}

/** Безопасный перевод сервера на вход по SSH-ключу: ставим ключ → тест-вход → только
 *  потом отключаем пароль (никогда не отключаем пароль до подтверждённого входа ключом). */
function SshHardenPanel({ server }: { server: Server }) {
  const { showToast, reload } = useApp();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  if (server.sshKeyAuth) {
    return (
      <div className="field" style={{ borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}>
        <span className="field-label">SSH-доступ</span>
        <div className="body small" style={{ color: 'var(--ok-fg, #2a9d3c)' }}>✓ Вход по ключу включён, парольная аутентификация отключена.</div>
      </div>
    );
  }
  return (
    <div className="field" style={{ borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}>
      <span className="field-label">SSH-доступ (вход по ключу)</span>
      <div className="body small muted" style={{ marginBottom: 8 }}>
        Перевод на вход <b>только по ключу</b>: панель поставит публичный ключ, сделает тест-вход
        и <b>только при успехе</b> отключит пароль. Если тест не пройдёт — пароль останется, ничего
        не сломается. Приватный ключ шифруется и наружу не отдаётся.
      </div>
      {!open ? (
        <button className="btn btn-outline btn-sm" onClick={() => setOpen(true)}>Перевести на вход по ключу</button>
      ) : (
        <>
          <Field label="Приватный SSH-ключ (OpenSSH/PEM)" hint="Вставьте содержимое приватного ключа целиком. Публичный ключ панель выведет сама.">
            <textarea className="textarea mono" style={{ minHeight: 120, fontSize: 12 }} spellCheck={false} placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----'} value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy || !key.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.hardenServerSsh(server.id, key.trim());
                  showToast('Готово: вход по ключу включён, пароль отключён');
                  setOpen(false);
                  setKey('');
                  await reload();
                } catch (e) {
                  showToast(e instanceof Error ? e.message : 'Не удалось перевести на ключ');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Проверяем ключ…' : 'Проверить и включить'}
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => { setOpen(false); setKey(''); }}>Отмена</button>
          </div>
        </>
      )}
    </div>
  );
}

function ServerEditForm({ server, onClose }: { server: Server; onClose: () => void }) {
  const { editServer, showToast, reload, showConfirm, deleteServer } = useApp();
  const [provBusy, setProvBusy] = useState<string | null>(null);

  function reinstall() {
    showConfirm({
      title: 'Установить / переустановить ПО?',
      text:
        'Установит по SSH xray/AmneziaWG (и прокси, если включены). Операция занимает несколько минут. ' +
        'Если ключи сервера сохранены в панели — ранее выданные конфиги продолжат работать; иначе их придётся перевыпустить.',
      confirmLabel: 'Установить',
      onConfirm: () => runReinstall(),
    });
  }
  async function runReinstall() {
    setProvBusy('install');
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const comps = server.protocols.length ? (server.protocols as string[]) : ['xray', 'amneziawg'];
      await api.provisionServer(server.id, comps);
      const started = Date.now();
      for (;;) {
        await sleep(5000);
        if (Date.now() - started > 8 * 60 * 1000) throw new Error('Установка заняла слишком долго.');
        const st = await api.provisionStatus(server.id);
        if (st.state === 'done') {
          await reload();
          showToast(st.restored ? 'Переустановлено, ключи восстановлены' : 'Установка завершена');
          return;
        }
        if (st.state === 'error') throw new Error(st.message);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Ошибка установки');
    } finally {
      setProvBusy(null);
    }
  }
  function uninstall(purge: boolean) {
    showConfirm({
      title: purge ? 'Удалить ПО и ключи?' : 'Удалить ПО с сервера?',
      text: purge
        ? 'С сервера будут удалены xray/awg/прокси И забыты ключи домена — восстановление по домену станет невозможным. Пользователи и коды в панели остаются.'
        : 'С сервера будет удалено ПО (xray/awg/прокси). Ключи домена сохранятся — можно переустановить с восстановлением. Пользователи и коды остаются.',
      confirmLabel: 'Удалить',
      danger: true,
      onConfirm: async () => {
        setProvBusy('uninstall');
        try {
          await api.uninstallServer(server.id, purge);
          await reload();
          showToast('ПО удалено с сервера');
        } catch (e) {
          showToast(e instanceof Error ? e.message : 'Ошибка удаления');
        } finally {
          setProvBusy(null);
        }
      },
    });
  }

  const [pxHttp, setPxHttp] = useState(server.protocols.includes('http'));
  const [pxHttps, setPxHttps] = useState((server.protocols as string[]).includes('https'));
  const [pxSocks, setPxSocks] = useState(server.protocols.includes('socks5'));
  const [pxBusy, setPxBusy] = useState(false);
  const [pxResult, setPxResult] = useState<ServerProxyConfig | null>(null);
  const [pxErr, setPxErr] = useState<string | null>(null);
  // HTTPS доступен только на домене (certbot). Гейтим по СОХРАНЁННОМУ адресу — именно
  // его использует certbot на бэке; впишешь домен и сохранишь — опция включится.
  const httpsOk = hostIsDomain(server.host);

  function installProxies() {
    if (!pxHttp && !(pxHttps && httpsOk) && !pxSocks) {
      setPxErr('Отметьте хотя бы один тип прокси.');
      return;
    }
    if (pxHttps && !httpsOk) {
      setPxErr('HTTPS-прокси требует домен сервера (не IP). Впишите домен и сохраните сервер.');
      return;
    }
    setPxErr(null);
    showConfirm({
      title: 'Установить прокси на сервере?',
      text:
        'Панель по SSH соберёт на сервере 3proxy и настроит выбранные типы.' +
        (pxHttps ? ' Для HTTPS дополнительно поставит certbot/stunnel и выпустит TLS-сертификат (нужен домен и свободный порт 80).' : '') +
        ' Операция занимает несколько минут.',
      confirmLabel: 'Установить',
      onConfirm: () => runInstallProxies(),
    });
  }
  async function runInstallProxies() {
    setPxBusy(true);
    setPxErr(null);
    try {
      const r = await api.installServerProxies(server.id, { http: pxHttp, https: pxHttps && httpsOk, socks: pxSocks });
      setPxResult(r.proxy);
      await reload();
      showToast('Прокси установлены');
    } catch (e) {
      setPxErr(e instanceof Error ? e.message : 'Не удалось установить прокси');
    } finally {
      setPxBusy(false);
    }
  }
  async function showExisting() {
    try {
      const r = await api.getServerProxy(server.id);
      if (r.proxy) setPxResult(r.proxy);
      else setPxErr('Прокси ещё не установлены на этом сервере.');
    } catch {
      setPxErr('Не удалось получить данные прокси.');
    }
  }
  const [name, setName] = useState(server.name);
  const [country, setCountry] = useState(server.country ?? '');
  const [flagEmoji, setFlagEmoji] = useState(server.flagEmoji ?? '');
  const [vpnHost, setVpnHost] = useState(server.host);
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [sshAuth, setSshAuth] = useState<'password' | 'key'>('password');
  const [secret, setSecret] = useState('');
  const [protocols, setProtocols] = useState<Proto[]>(server.protocols as Proto[]);
  const [xPub, setXPub] = useState('');
  const [xSid, setXSid] = useState('');
  const [xSni, setXSni] = useState('');
  const [awgPub, setAwgPub] = useState('');
  const [saving, setSaving] = useState(false);

  const toggle = (p: Proto) => setProtocols((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  async function save() {
    setSaving(true);
    try {
      const serverKeys =
        xPub || xSid || xSni || awgPub
          ? { xrayRealityPubKey: xPub || undefined, xrayShortId: xSid || undefined, xraySni: xSni || undefined, awgServerPubKey: awgPub || undefined }
          : undefined;
      await editServer(server.id, {
        name: name.trim() || server.name,
        country: country.trim() || null,
        flagEmoji: flagEmoji || null,
        vpnHost: vpnHost.trim() || server.host,
        sshPort: parseInt(sshPort, 10) || 22,
        sshUser: sshUser.trim() || 'root',
        authMethod: sshAuth,
        secret: secret.trim() || undefined,
        components: protocols,
        serverKeys,
      });
      showToast('Сервер изменён');
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось сохранить сервер');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 12, borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}>
      <div className="grid-2">
        <Field label="Название"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Страна (флаг)">
          <select className="select" value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">— не указана —</option>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={countryValue(c)}>
                {c.flag} {c.name}
              </option>
            ))}
            {country && !COUNTRIES.some((c) => countryValue(c) === country) ? (
              <option value={country}>{country}</option>
            ) : null}
          </select>
        </Field>
        <Field label="Значок в подписке" hint="Свой значок вместо флага страны (напр. 🏠). Пусто = флаг.">
          <div className="chip-row">
            {['', '🏠', '⭐', '🚀', '🔒', '🌐', '⚡', '🛡️'].map((e) => (
              <Chip key={e || 'none'} label={e || 'флаг'} size="sm" active={flagEmoji === e} onClick={() => setFlagEmoji(e)} />
            ))}
          </div>
        </Field>
      </div>

      {/* Маршрутизация — то, ради чего открывают сервер: сразу под названием, без прокрутки. */}
      <EndpointConfigPanel server={server} />

      {/* Техническая часть — свёрнута: домен и SSH, протоколы, ключи, прокси, установка ПО,
          порты. Меняется редко; всё, что нужно каждый день, выше. */}
      <details className="card" style={{ padding: '10px 14px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
          Техническая часть — домен и SSH, протоколы, ключи, прокси, установка ПО, порты
        </summary>
      <div className="grid-2" style={{ marginTop: 10 }}>
        <Field label="Домен или IP (VPN-endpoint)"><input className="input mono" value={vpnHost} onChange={(e) => setVpnHost(e.target.value)} /></Field>
        <Field label="SSH-порт"><input className="input" inputMode="numeric" value={sshPort} onChange={(e) => setSshPort(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="SSH-пользователь"><input className="input" value={sshUser} onChange={(e) => setSshUser(e.target.value)} /></Field>
        <Field label="Способ входа по SSH">
          <div className="chip-row">
            <Chip label="Пароль" size="sm" active={sshAuth === 'password'} onClick={() => setSshAuth('password')} />
            <Chip label="Приватный ключ" size="sm" active={sshAuth === 'key'} onClick={() => setSshAuth('key')} />
          </div>
        </Field>
      </div>
      <Field label={sshAuth === 'key' ? 'Новый приватный ключ (пусто = не менять)' : 'Новый SSH-пароль (пусто = не менять)'}>
        {sshAuth === 'key' ? (
          <textarea className="textarea mono" rows={4} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
        ) : (
          <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••" />
        )}
      </Field>

      <div className="field">
        <span className="field-label">VPN-протоколы этого сервера</span>
        <div className="chip-row">
          {(['xray', 'amneziawg'] as Proto[]).map((p) => (
            <Chip key={p} label={PROTOCOL_LABELS[p]} size="sm" active={protocols.includes(p)} onClick={() => toggle(p)} />
          ))}
        </div>
        <span className="small muted">
          Для нового сервера просто нажмите «Установить / переустановить ПО» ниже — панель сама поставит
          отмеченные протоколы. Отмечать вручную нужно, только если регистрируете УЖЕ установленный сервер
          (тогда впишите его серверные ключи ниже). Прокси настраиваются отдельным блоком.
        </span>
      </div>

      <details>
        <summary className="small muted" style={{ cursor: 'pointer' }}>Серверные ключи (заполните при добавлении протокола; пусто = не менять)</summary>
        <div className="grid-2" style={{ marginTop: 10 }}>
          <Field label="Xray Reality pubkey"><input className="input mono" value={xPub} onChange={(e) => setXPub(e.target.value)} placeholder="pbk…" /></Field>
          <Field label="Xray shortId"><input className="input mono" value={xSid} onChange={(e) => setXSid(e.target.value)} placeholder="sid…" /></Field>
          <Field label="Xray SNI"><input className="input mono" value={xSni} onChange={(e) => setXSni(e.target.value)} placeholder="www.microsoft.com" /></Field>
          <Field label="AmneziaWG server pubkey"><input className="input mono" value={awgPub} onChange={(e) => setAwgPub(e.target.value)} placeholder="awg pubkey…" /></Field>
        </div>
      </details>

      {/* Прокси-комплект — реальная установка по SSH */}
      <div className="field" style={{ borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}>
        <span className="field-label">Прокси на сервере (устанавливаются реально по SSH)</span>
        <div className="chip-row">
          <Chip label="HTTP" size="sm" active={pxHttp} onClick={() => setPxHttp((v) => !v)} />
          <Chip
            label="HTTPS"
            size="sm"
            active={pxHttps && httpsOk}
            disabled={!httpsOk}
            onClick={() => { if (httpsOk) setPxHttps((v) => !v); }}
          />
          <Chip label="SOCKS5" size="sm" active={pxSocks} onClick={() => setPxSocks((v) => !v)} />
        </div>
        <span className="small muted">
          3proxy (HTTP/SOCKS5) + certbot/stunnel (HTTPS).
        </span>
        {!httpsOk ? (
          <div className="body small muted" style={{ marginTop: 6 }}>
            HTTPS-прокси доступен только когда адрес сервера — <b>домен</b> (сейчас указан
            IP). Впишите домен в поле «{'Домен или IP'}» выше, сохраните сервер — и опция
            включится. HTTP/SOCKS5 работают и на IP.
          </div>
        ) : pxHttps ? (
          <div className="notice notice-amber small" style={{ marginTop: 6 }}>
            <b>Для HTTPS-прокси нужен свободный порт 80.</b> По домену сервера certbot
            выпустит TLS-сертификат; на время выпуска порт <b>80</b> должен быть свободен
            (панель откроет его в файрволе автоматически). HTTPS-прокси слушает порт 8443.
          </div>
        ) : null}
        {pxErr ? <div className="notice notice-red small">{pxErr}</div> : null}
        {pxResult ? <ProxyBox proxy={pxResult} /> : null}
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn btn-secondary btn-sm" disabled={pxBusy} onClick={() => void installProxies()}>
            {pxBusy ? 'Устанавливаем… (до нескольких минут)' : 'Установить / обновить прокси'}
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => void showExisting()}>
            Показать текущие
          </button>
        </div>
      </div>

      {/* Установка/переустановка ПО по SSH */}
      <div className="field" style={{ borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}>
        <span className="field-label">Установка ПО на сервере (по SSH)</span>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" disabled={!!provBusy} onClick={() => void reinstall()}>
            {provBusy === 'install' ? 'Устанавливаем… (до нескольких минут)' : 'Установить / переустановить ПО'}
          </button>
          <button className="btn btn-outline btn-sm" disabled={!!provBusy} onClick={() => uninstall(false)}>
            Удалить ПО (ключи сохранить)
          </button>
          <button className="btn btn-danger-outline btn-sm" disabled={!!provBusy} onClick={() => uninstall(true)}>
            Удалить ПО и ключи
          </button>
          <button
            className="btn btn-outline btn-sm"
            disabled={!!provBusy}
            title="Залить на сервер все выданные конфиги из панели. Лечит случай «в панели конфиг есть, а подключиться нельзя» (пир потерялся на сервере)."
            onClick={async () => {
              setProvBusy('resync');
              try {
                const r = await api.resyncDevices(server.id);
                showToast(r.message ?? `Синхронизировано: Xray ${r.xray}, AmneziaWG ${r.awg}`);
              } catch (e) {
                showToast(e instanceof Error ? e.message : 'Не удалось синхронизировать');
              } finally {
                setProvBusy(null);
              }
            }}
          >
            {provBusy === 'resync' ? 'Синхронизирую…' : 'Синхронизировать конфиги'}
          </button>
        </div>
        <span className="small muted">
          Ставит xray + AmneziaWG (+ отмеченные прокси) прямо на сервер. Если ключи домена сохранены — переустановка
          восстанавливает их, и ранее выданные конфиги продолжают работать.
        </span>
      </div>

      {/* Публичные порты endpoint'а */}
      {server.ports ? (
        <div className="field" style={{ borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}>
          <span className="field-label">Публичные порты</span>
          <div className="body small mono" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span>Xray: <b>{server.ports.xray}</b></span>
            <span>AmneziaWG: <b>{server.ports.awg}</b> UDP</span>
          </div>
          {server.legacyPorts && server.legacyPorts.length > 0 ? (
            <div className="body small muted" style={{ marginTop: 6 }}>
              Совместимость (старые порты, работают через alias): {server.legacyPorts.map((l) => `${l.proto}:${l.port}`).join(', ')}
            </div>
          ) : null}
          <div className="body small muted" style={{ marginTop: 6 }}>
            Порт задаётся при установке. Смена порта — через переустановку с указанием порта;
            старый порт можно оставить для совместимости, чтобы уже выданные конфиги не сломались.
          </div>
        </div>
      ) : null}

      {/* SSH hardening: перевод на вход по ключу */}
      <SshHardenPanel server={server} />

        {/* Отвязать — редкое действие: бокс уходит, endpoint (домен, порты, ключи, конфиги) остаётся. */}
        <div className="field" style={{ borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}>
          <span className="field-label">Отвязать физический сервер</span>
          <span className="small muted">Домен, порты, ключи и все выданные конфиги сохранятся; SSH-доступ будет очищен. Для переезда на другой бокс используйте «Перенести».</span>
          <div>
            <button
              className="btn btn-outline btn-sm"
              onClick={() =>
                showConfirm({
                  title: 'Отвязать сервер?',
                  text: `«${server.name}» будет отвязан, но endpoint (домен ${server.host}, порты, ключи) и все выданные конфиги СОХРАНЯТСЯ. Позже можно подключить новый сервер на тот же домен — старые конфиги снова заработают.`,
                  confirmLabel: 'Отвязать',
                  onConfirm: async () => {
                    await deleteServer(server.id, false);
                    showToast('Сервер отвязан (endpoint сохранён)');
                  },
                })
              }
            >
              Отвязать
            </button>
          </div>
        </div>
      </details>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Сохраняем…' : 'Сохранить сервер'}
        </button>
        <button className="btn btn-outline btn-sm" onClick={onClose}>Отмена</button>
      </div>
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: color ?? 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </div>
    </div>
  );
}

export function Servers() {
  const { data, isMobile, goAdmin, setServerAutoIssue, deleteServer, showToast, showConfirm } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  // Синхронизация конфигов вынесена в футер строки: раньше она жила только внутри
  // формы «Изменить», ниже прокси и серверных ключей, и там её никто не находил.
  const [syncing, setSyncing] = useState<string | null>(null);
  if (!data) return null;

  const servers = data.servers;
  const n = servers.length;
  const statCols = isMobile ? '1fr 1fr' : 'repeat(auto-fit, minmax(130px, 1fr))';

  return (
    <>
      <ScreenHeader
        eyebrow="Серверы"
        title={`${n} ${plural(n, 'сервер', 'сервера', 'серверов')}`}
        right={
          <button className="btn btn-primary" onClick={() => goAdmin('server-wizard')}>
            + Добавить сервер
          </button>
        }
      />

      {n === 0 ? (
        <EmptyState
          title="Серверов пока нет"
          text="Добавьте первый сервер, чтобы выдавать конфиги пользователям."
          action={
            <button className="btn btn-primary" onClick={() => goAdmin('server-wizard')}>
              + Добавить сервер
            </button>
          }
        />
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {servers.map((s) => {
            const agentV = serverAgentView(s);
            const endpointV = serverEndpointView(s);
            const dotColor = s.detached ? 'var(--text-faint, #888)' : s.agent === 'online' ? 'var(--green-dot)' : 'var(--red-fg)';
            const title = s.country ? `${s.name} · ${s.country}` : s.name;
            const protocols = s.protocols.length
              ? s.protocols.map((p) => PROTOCOL_LABELS[p]).join(', ')
              : '—';

            return (
              <div key={s.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Заголовок карточки */}
                <div className="row-between" style={{ gap: 12, alignItems: 'center' }}>
                  <div className="row" style={{ gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
                    <Dot color={dotColor} />
                    <span style={{ fontWeight: 700, fontSize: 15 }}>{s.flagEmoji ? `${s.flagEmoji} ` : ''}{title}</span>
                    {s.detached ? <span className="badge" style={{ background: 'var(--surface-btn-2, #333)', color: 'var(--text-muted-2)' }} title="Физический сервер отвязан. Endpoint (домен/порты/ключи/конфиги) сохранён — подключите новый сервер на тот же домен.">endpoint сохранён</span> : null}
                  </div>
                  <span
                    className="mono small"
                    style={{ color: 'var(--text-muted)', textAlign: 'right', wordBreak: 'break-all' }}
                  >
                    {s.host}
                  </span>
                </div>

                {/* Метрики */}
                <div style={{ display: 'grid', gridTemplateColumns: statCols, gap: 12 }}>
                  <Metric label="Связь с сервером" value={agentV.label} color={agentV.fg} />
                  <Metric label="VPN-адрес" value={endpointV.label} color={endpointV.fg} />
                  <Metric label="Протоколы" value={protocols} />
                  <Metric label="Трафик" value={gb(s.trafficGb)} />
                  <Metric label="Пользователи" value={String(s.users)} />
                  <Metric label="Синхронизация" value={rel(s.lastSyncAt)} />
                </div>

                {/* Сводка маршрутизации: видна сразу, без захода в «Изменить» —
                    именно эти настройки раньше терялись в глубине формы. */}
                {s.routing ? (
                  <div
                    className="row-between"
                    style={{ gap: 12, flexWrap: 'wrap', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-inner)' }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div className="eyebrow" style={{ marginBottom: 4 }}>Маршрутизация</div>
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                        <b style={{ fontSize: 14, color: s.routing.profiles === 'full' ? 'var(--amber-fg)' : 'var(--text-primary)' }}>
                          {s.routing.profiles === 'both'
                            ? 'Умная маршрутизация + Полный VPN'
                            : s.routing.profiles === 'smart'
                              ? 'Только умная маршрутизация'
                              : 'Только полный VPN'}
                        </b>
                        <span className="small muted">
                          {s.routing.profiles !== 'full'
                            ? s.routing.direction === 'match-direct'
                              ? 'свой список — напрямую'
                              : s.routing.source === 'autoroute'
                                ? 'база AutoRoute'
                                : 'свой список'
                            : 'без исключений'}
                          {s.routing.ownExceptions > 0 ? ` · своих доменов: ${s.routing.ownExceptions}` : ''}
                          {' · '}LAN: {s.routing.lanAccess ? 'вкл' : 'выкл'}
                          {' · '}запасные: {s.routing.fallbackTypes === null ? 'все' : s.routing.fallbackTypes.length ? s.routing.fallbackTypes.join(', ').toUpperCase() : 'нет'}
                        </span>
                      </div>
                    </div>
                    <button className="btn btn-outline btn-sm" onClick={() => setEditing(s.id)}>Настроить</button>
                  </div>
                ) : null}

                {/* Футер */}
                <div
                  className="row-between"
                  style={{ gap: 12, flexWrap: 'wrap', borderTop: '1px solid var(--border-inner)', paddingTop: 12 }}
                >
                  <div className="row" style={{ gap: 10 }}>
                    <Toggle
                      on={s.autoIssue}
                      onChange={(v) => void setServerAutoIssue(s.id, v)}
                      ariaLabel="Автоматическая выдача"
                    />
                    <span className="small">Автоматическая выдача</span>
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => setEditing((cur) => (cur === s.id ? null : s.id))}
                    >
                      {editing === s.id ? 'Скрыть' : 'Изменить'}
                    </button>
                    <button
                      className="btn btn-outline btn-sm"
                      title="Перенести этот сервер на новый бокс: домен/ключи/конфиги сохраняются, меняется только машина"
                      onClick={() => goAdmin('server-migrate', { serverId: s.id })}
                    >
                      Перенести
                    </button>
                    <button
                      className="btn btn-outline btn-sm"
                      disabled={syncing === s.id}
                      title="Залить на сервер все выданные конфиги из панели. Лечит «в панели конфиг есть, а подключиться нельзя»."
                      onClick={async () => {
                        setSyncing(s.id);
                        try {
                          const r = await api.resyncDevices(s.id);
                          showToast(r.message ?? `Синхронизировано: Xray ${r.xray}, AmneziaWG ${r.awg}`);
                        } catch (e) {
                          showToast(e instanceof Error ? e.message : 'Не удалось синхронизировать');
                        } finally {
                          setSyncing(null);
                        }
                      }}
                    >
                      {syncing === s.id ? 'Синхронизирую…' : 'Синхронизировать'}
                    </button>
                    <button
                      className="btn btn-danger-outline btn-sm"
                      onClick={() =>
                        showConfirm({
                          title: 'Удалить полностью?',
                          text: `ОПАСНО: «${s.name}», его ключи endpoint'а и ВСЕ выданные на него конфиги будут удалены безвозвратно. Старые конфиги перестанут работать навсегда. Обычно нужно «Отвязать».`,
                          confirmLabel: 'Удалить полностью',
                          danger: true,
                          onConfirm: async () => {
                            await deleteServer(s.id, true);
                            showToast('Сервер и endpoint удалены');
                          },
                        })
                      }
                    >
                      Удалить
                    </button>
                  </div>
                </div>

                {editing === s.id ? <ServerEditForm server={s} onClose={() => setEditing(null)} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
