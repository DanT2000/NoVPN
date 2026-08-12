// Подключение устройства: имя → сервер → протокол → готовая конфигурация.
//
// Шаги, где выбирать не из чего, пропускаются: один сервер — не спрашиваем
// сервер, один разрешённый протокол — не спрашиваем протокол.
//
// Результат зависит от протокола:
//   Xray      — показываем ССЫЛКУ-ПОДПИСКУ: она разом даёт все конфигурации
//               и обновляется сама. Отдельная ссылка конфига — второстепенно.
//   AmneziaWG — ссылка vpn:// (открывает приложение AmneziaVPN) и файл .conf
//               (для отдельного приложения AmneziaWG, ссылку оно не понимает).

import { useMemo, useState } from 'react';
import type { AppClient, IssueDeviceResult, PublicServerView } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { BackButton, Dot, EmptyState } from '../components/ui';
import { Qr } from '../components/Qr';
import { copyText, downloadText, openUrl, normalizeUrl } from '../lib/clipboard';

const PLATFORMS = ['Android', 'iOS', 'Windows', 'macOS', 'Linux'] as const;
type Platform = (typeof PLATFORMS)[number];
type Proto = 'xray' | 'amneziawg';

function detectPlatform(): Platform {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Android';
}

/** Ссылка «добавить подписку одним нажатием» из схемы каталога. */
function oneTap(app: AppClient, subUrl: string): string | null {
  const sc = app.urlScheme;
  if (!sc || !subUrl) return null;
  return sc.endsWith('=') ? sc + encodeURIComponent(subUrl) : sc + subUrl;
}

export function Wizard() {
  const { publicUser: user, publicData: data, nav, goPublic, showToast, issueDevice } = useApp();
  const mode = nav.params.wizardMode ?? 'issue';
  const viewDeviceId = nav.params.deviceId;

  const [name, setName] = useState('');
  const [serverId, setServerId] = useState<string | null>(null);
  const [proto, setProto] = useState<Proto | null>(null);
  const [platform, setPlatform] = useState<Platform>(detectPlatform());
  // Стартовый шаг (без отдельного шага имени): сервер(2), если их несколько; иначе
  // протокол(3), если их несколько; иначе сразу результат(4). Имя спрашиваем только
  // для AmneziaWG уже на шаге результата — Xray это одна общая подписка без имени.
  const [rawStep, setRawStep] = useState<1 | 2 | 3 | 4>(() => {
    if (!user || !data) return 2;
    const online = data.servers.filter((s) => user.allowedServers.includes(s.id) && s.online);
    if (online.length !== 1) return 2;
    const protos = (['xray', 'amneziawg'] as Proto[]).filter(
      (p) => (user.allowedProtocols as string[]).includes(p) && (online[0]!.protocols as string[]).includes(p),
    );
    // Ровно один протокол → сразу результат(4). Ноль (сервер не делит с пользователем
    // ни одного протокола) → шаг 3 с пустым состоянием, а НЕ мёртвый экран результата
    // без выбранного протокола. Несколько → шаг 3 (выбор).
    return protos.length === 1 ? 4 : 3;
  });
  const [issuing, setIssuing] = useState(false);
  const [result, setResult] = useState<IssueDeviceResult | null>(null);

  const viewDevice = useMemo(
    () => (mode === 'view' && viewDeviceId ? data?.devices.find((d) => d.id === viewDeviceId) ?? null : null),
    [mode, viewDeviceId, data],
  );

  if (!user || !data) return null;
  if (mode === 'view' && !viewDevice) {
    return (
      <div style={{ paddingTop: 40 }}>
        <EmptyState
          title="Конфигурация не найдена"
          action={<button className="btn btn-primary" onClick={() => goPublic('devices')}>К устройствам</button>}
        />
      </div>
    );
  }

  // Серверы, доступные пользователю и живые.
  const servers = data.servers.filter((s) => user.allowedServers.includes(s.id));
  const onlineServers = servers.filter((s) => s.online);
  // Один сервер — выбирать нечего.
  const autoServer = onlineServers.length === 1 ? onlineServers[0]! : null;
  const effServerId = serverId ?? autoServer?.id ?? null;
  const chosenServer: PublicServerView | undefined =
    (mode === 'view' && viewDevice ? data.servers.find((s) => s.id === viewDevice.serverId) : undefined) ??
    data.servers.find((s) => s.id === effServerId);

  // Протоколы: и пользователю разрешены, и на сервере установлены.
  const protosOf = (srv?: PublicServerView): Proto[] =>
    (['xray', 'amneziawg'] as Proto[]).filter(
      (p) => (user.allowedProtocols as string[]).includes(p) && (srv?.protocols as string[] | undefined)?.includes(p),
    );
  const protoOptions = protosOf(chosenServer);
  const autoProto = protoOptions.length === 1 ? protoOptions[0]! : null;
  const effProto: Proto | null = proto ?? autoProto;

  const step: 1 | 2 | 3 | 4 = mode === 'view' || result ? 4 : rawStep;

  // Имя нужно только для AmneziaWG (у каждого устройства своё). По умолчанию — «Устройство N».
  const defaultName = `Устройство ${data.devices.filter((d) => d.userId === user.id && d.protocol === 'amneziawg').length + 1}`;

  const doIssue = async () => {
    if (!chosenServer || !effProto || issuing) return;
    setIssuing(true);
    try {
      const res = await issueDevice({ userId: user.id, name: name.trim() || defaultName, serverId: chosenServer.id, protocol: effProto });
      setResult(res);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось создать конфигурацию');
    } finally {
      setIssuing(false);
    }
  };

  const back = () => {
    if (mode === 'view' || result) return goPublic('devices');
    // Назад: результат(4) → протокол(3), если он был; иначе сервер(2), если был; иначе кабинет.
    if (rawStep === 4) return autoProto ? (autoServer ? goPublic('cabinet') : setRawStep(2)) : setRawStep(3);
    if (rawStep === 3) return autoServer ? goPublic('cabinet') : setRawStep(2);
    goPublic('cabinet');
  };

  // ── данные результата ──
  const dev = result?.device ?? viewDevice;
  const cfgProto = (dev?.protocol ?? effProto) as Proto | undefined;
  const cfgLink = result?.link ?? viewDevice?.link ?? null;
  const cfgConf = result?.conf ?? viewDevice?.conf ?? null;
  const vpnKey = result?.vpnKey ?? viewDevice?.vpnKey ?? null;
  const cfgName = dev?.name ?? name;
  const subUrl = data.subLink ?? '';

  const apps = data.apps.filter(
    (a) =>
      a.enabled &&
      a.platforms.some((p) => p.platform === platform) &&
      (cfgProto === 'xray' ? a.compat.includes('xray') : a.compat.includes('amneziawg') || a.compat.includes('amnezia-app')),
  );

  const title =
    step === 4
      ? mode === 'view'
        ? cfgName || 'Конфигурация'
        : dev
          ? 'Готово'
          : 'Проверьте и создайте' // ещё не выпущено — «Готово» было бы неправдой
      : 'Новое устройство';

  return (
    <div className="stack" style={{ gap: 16, paddingTop: 12 }}>
      <div className="row" style={{ gap: 12, minWidth: 0 }}>
        <BackButton onClick={back} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        </div>
      </div>

      {/* ШАГ 2 — сервер (только если их несколько) */}
      {step === 2 ? (
        <div className="stack" style={{ gap: 12 }}>
          <p className="body small" style={{ margin: 0 }}>Выберите сервер.</p>
          {onlineServers.length === 0 ? (
            <EmptyState title="Нет доступных серверов" text="Все серверы сейчас недоступны. Попробуйте позже." />
          ) : (
            onlineServers.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setServerId(s.id);
                  // Протоколы берём у выбранного сервера, а не у прежнего.
                  const ps = protosOf(s);
                  if (ps.length === 1) setProto(ps[0]!);
                  setRawStep(ps.length === 1 ? 4 : 3);
                }}
                className="card"
                style={{ textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
              >
                <Dot color="var(--green-dot)" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span style={{ fontWeight: 700 }}>{s.country ? `${s.country} ` : ''}{s.name}</span>
                    {s.recommended ? <span className="badge">Рекомендуемый</span> : null}
                  </div>
                  <div className="small muted">{s.host}</div>
                </div>
              </button>
            ))
          )}
        </div>
      ) : null}

      {/* ШАГ 3 — протокол (только если их несколько) */}
      {step === 3 ? (
        <div className="stack" style={{ gap: 12 }}>
          <p className="body small" style={{ margin: 0 }}>Выберите способ подключения.</p>
          {protoOptions.includes('xray') ? (
            <button className="card stack" style={{ gap: 6, textAlign: 'left', cursor: 'pointer' }} onClick={() => { setProto('xray'); setRawStep(4); }}>
              <div className="row-between">
                <span style={{ fontWeight: 700, fontSize: 16 }}>Xray</span>
                <span className="badge">рекомендуем</span>
              </div>
              <span className="body small muted">
                Одна ссылка-подписка на все устройства, конфигурации обновляются сами.
              </span>
            </button>
          ) : null}
          {protoOptions.includes('amneziawg') ? (
            <button className="card stack" style={{ gap: 6, textAlign: 'left', cursor: 'pointer' }} onClick={() => { setProto('amneziawg'); setRawStep(4); }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>AmneziaWG</div>
              <span className="body small muted">
                Отдельная конфигурация на устройство. Берите, если Xray блокируют.
              </span>
            </button>
          ) : null}
          {protoOptions.length === 0 ? (
            <EmptyState title="Нет доступных протоколов" text="На этом сервере нет протоколов, разрешённых вам." />
          ) : null}
        </div>
      ) : null}

      {/* ШАГ 4 — результат */}
      {step === 4 ? (
        <div className="stack" style={{ gap: 14 }}>
          {/* ещё не выпущено — кнопка выпуска. Имя спрашиваем ТОЛЬКО для AmneziaWG:
              Xray — одна общая подписка на все устройства, имя ей не нужно. */}
          {!dev ? (
            <>
              {effProto === 'amneziawg' ? (
                <div className="stack" style={{ gap: 10 }}>
                  <p className="body small" style={{ margin: 0 }}>Назовите устройство, чтобы узнавать его в списке (необязательно).</p>
                  <input className="input" placeholder={defaultName} aria-label="Название устройства" value={name} onChange={(e) => setName(e.target.value)} />
                  <div className="chip-row">
                    {['Телефон', 'Ноутбук', 'Планшет', 'ПК'].map((q) => (
                      <button key={q} type="button" className="chip chip-sm" onClick={() => setName(q)}>{q}</button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="card stack" style={{ gap: 6 }}>
                <div className="row-between"><span className="muted">Сервер</span><b>{chosenServer?.name ?? '—'}</b></div>
                <div className="row-between"><span className="muted">Способ</span><b>{effProto === 'xray' ? 'Xray — общая подписка' : 'AmneziaWG'}</b></div>
              </div>
              <button className="btn btn-primary btn-lg btn-block" disabled={issuing || !effProto} onClick={() => void doIssue()}>
                {issuing ? 'Создаём…' : effProto === 'xray' ? 'Получить подписку' : 'Создать конфигурацию'}
              </button>
            </>
          ) : null}

          {/* Xray → подписка */}
          {dev && cfgProto === 'xray' && subUrl ? (
            <div className="card stack" style={{ gap: 10 }}>
              <div>
                <div className="eyebrow" style={{ marginBottom: 4 }}>Ваша ссылка-подписка</div>
                <div className="body small muted">
                  Добавьте её в приложение — все ваши конфигурации появятся сразу и будут обновляться.
                </div>
              </div>
              <Qr text={subUrl} caption="Или отсканируйте" />
              <input className="input mono" readOnly value={subUrl} style={{ fontSize: 12 }} />
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => showToast((await copyText(subUrl)) ? 'Ссылка скопирована' : 'Не удалось скопировать')}
              >
                Копировать ссылку
              </button>
            </div>
          ) : null}

          {/* AmneziaWG → vpn:// и файл */}
          {dev && cfgProto === 'amneziawg' ? (
            <div className="card stack" style={{ gap: 10 }}>
              <div>
                <div className="eyebrow" style={{ marginBottom: 4 }}>Конфигурация «{cfgName}»</div>
                <div className="body small muted">
                  Кнопка ниже открывает приложение AmneziaVPN и добавляет конфигурацию.
                  Для отдельного приложения AmneziaWG скачайте файл .conf — ссылку оно не понимает.
                </div>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {vpnKey ? (
                  <button className="btn btn-primary btn-sm" onClick={() => openUrl(vpnKey)}>Открыть в AmneziaVPN</button>
                ) : null}
                {cfgConf ? (
                  <button className="btn btn-outline btn-sm" onClick={() => downloadText(`novpn-${cfgName}.conf`, cfgConf)}>
                    Скачать .conf
                  </button>
                ) : null}
                {vpnKey ? (
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={async () => showToast((await copyText(vpnKey)) ? 'Ссылка скопирована' : 'Не удалось скопировать')}
                  >
                    Копировать vpn://
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Xray без подписки (её ещё нет) — отдельная ссылка конфига */}
          {dev && cfgProto === 'xray' && !subUrl && cfgLink ? (
            <div className="card stack" style={{ gap: 10 }}>
              <div className="eyebrow">Ссылка подключения</div>
              <Qr text={cfgLink} caption="Отсканируйте в приложении" />
              <input className="input mono" readOnly value={cfgLink} style={{ fontSize: 12 }} />
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => showToast((await copyText(cfgLink)) ? 'Скопировано' : 'Не удалось скопировать')}
              >
                Копировать
              </button>
            </div>
          ) : null}

          {/* Приложения под выбранный способ */}
          {dev ? (
            <div className="stack" style={{ gap: 10 }}>
              <div className="chip-row">
                {PLATFORMS.map((p) => (
                  <button key={p} type="button" className={`chip chip-sm ${platform === p ? 'active' : ''}`} onClick={() => setPlatform(p)}>{p}</button>
                ))}
              </div>
              {apps.length === 0 ? (
                <EmptyState title="Нет приложений для этой системы" text="Выберите другую систему выше." />
              ) : (
                apps.map((a) => {
                  const entry = a.platforms.find((p) => p.platform === platform)!;
                  const tap = cfgProto === 'xray' ? oneTap(a, subUrl) : null;
                  return (
                    <div key={a.id} className="card" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                      {a.icon ? (
                        <img src={a.icon} alt="" width={40} height={40} style={{ borderRadius: 11, flex: 'none' }} />
                      ) : null}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{a.client}</div>
                        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                          {entry.downloadName ? (
                            <a className="btn btn-primary btn-sm" href={`/apps/file/${a.id}/${encodeURIComponent(entry.platform)}`}>⬇ Скачать</a>
                          ) : entry.url ? (
                            <button className="btn btn-outline btn-sm" onClick={() => openUrl(normalizeUrl(entry.url!))}>
                              {/play\.google\.com/i.test(entry.url) ? 'Google Play' : /apps\.apple\.com|itunes\.apple/i.test(entry.url) ? 'App Store' : 'Установить'}
                            </button>
                          ) : null}
                          {entry.downloadName && entry.url ? (
                            <button className="btn btn-outline btn-sm" onClick={() => openUrl(normalizeUrl(entry.url!))}>
                              {/play\.google\.com/i.test(entry.url) ? 'Google Play' : /apps\.apple\.com|itunes\.apple/i.test(entry.url) ? 'App Store' : 'Сайт'}
                            </button>
                          ) : null}
                          {tap ? (
                            <button className="btn btn-primary btn-sm" onClick={() => openUrl(tap)}>Добавить подписку</button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : null}

          {dev ? (
            <button className="btn btn-outline btn-block" onClick={() => goPublic('devices')}>К моим устройствам</button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
