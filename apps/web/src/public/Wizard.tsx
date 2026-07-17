import { useMemo, useState } from 'react';
import type { AppClient, IssueDeviceResult, PublicServerView } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { BackButton, Dot, EmptyState, ProgressBar } from '../components/ui';
import { Qr } from '../components/Qr';
import { dateShort } from '../lib/format';
import { copyText, downloadText, shareText } from '../lib/clipboard';

const PLATFORMS = ['Android', 'iOS', 'Windows', 'macOS', 'Linux'] as const;
type Platform = (typeof PLATFORMS)[number];

function detectPlatform(): Platform {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Android';
}

/** Протокол, который выдаст приложение по его совместимости. */
function appProtocol(a: AppClient): 'xray' | 'amneziawg' {
  return a.compat.includes('xray') ? 'xray' : 'amneziawg';
}
function appKind(a: AppClient): 'xray' | 'amnezia-app' | 'amneziawg' {
  if (a.compat.includes('xray')) return 'xray';
  if (a.compat.includes('amnezia-app')) return 'amnezia-app';
  return 'amneziawg';
}

export function Wizard() {
  const { publicUser: user, publicData: data, nav, goPublic, showToast, issueDevice } = useApp();
  const mode = nav.params.wizardMode ?? 'issue';
  const viewDeviceId = nav.params.deviceId;

  const [step, setStep] = useState(mode === 'view' ? 4 : 1);
  const [name, setName] = useState('');
  const [serverId, setServerId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform>(detectPlatform());
  const [appId, setAppId] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [result, setResult] = useState<(IssueDeviceResult & { appId: string | null }) | null>(null);

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

  const allowedServers = data.servers.filter((s) => user.allowedServers.includes(s.id));
  const chosenServer: PublicServerView | undefined =
    (mode === 'view' && viewDevice ? data.servers.find((s) => s.id === viewDevice.serverId) : undefined) ??
    data.servers.find((s) => s.id === serverId);

  const chosenApp = data.apps.find((a) => a.id === appId) ?? null;

  const availableApps = data.apps.filter((a) => {
    if (!a.enabled || !a.platforms.some((p) => p.platform === platform)) return false;
    const proto = appProtocol(a);
    const userOk = (user.allowedProtocols as string[]).includes(proto);
    const serverOk = chosenServer ? (chosenServer.protocols as string[]).includes(proto) : true;
    return userOk && serverOk;
  });

  const back = () => {
    if (mode === 'view') return goPublic('devices');
    // Шаг 4 — конфиг уже выпущен. Возврат в форму дал бы повторный выпуск и
    // дубликат устройства, поэтому уводим к списку устройств.
    if (step >= 4) return goPublic('devices');
    if (step <= 1) return goPublic('cabinet');
    setStep(step - 1);
  };

  const doIssue = async () => {
    if (!chosenServer || !chosenApp || issuing) return;
    setIssuing(true);
    try {
      const finalName = name.trim() || `Устройство ${data.devices.filter((d) => d.userId === user.id).length + 1}`;
      const res = await issueDevice({ userId: user.id, name: finalName, serverId: chosenServer.id, protocol: appProtocol(chosenApp) });
      setResult({ ...res, appId: chosenApp.id });
      setStep(4);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось создать конфигурацию');
    } finally {
      setIssuing(false);
    }
  };

  // config payload for step 4 (view or freshly issued)
  const cfgLink = result?.link ?? viewDevice?.link ?? null;
  const cfgConf = result?.conf ?? viewDevice?.conf ?? null;
  const cfgName = result?.device.name ?? viewDevice?.name ?? name;
  const protoLabelFull = (() => {
    const proto = result?.device.protocol ?? viewDevice?.protocol;
    if (proto === 'xray') return 'Xray (VLESS Reality)';
    const kind = chosenApp ? appKind(chosenApp) : null;
    return kind === 'amnezia-app' ? 'AmneziaWG (для AmneziaVPN)' : 'AmneziaWG';
  })();

  const stepLabel = mode === 'view' || step === 4 ? null : `Шаг ${step} из 4`;
  const title = mode === 'view' ? cfgName || 'Конфигурация' : step === 4 ? cfgName || 'Готово' : 'Новое устройство';

  const copyCfg = async () => {
    const text = cfgLink ?? cfgConf ?? '';
    showToast((await copyText(text)) ? (cfgLink ? 'Ссылка скопирована' : 'Конфигурация скопирована') : 'Не удалось скопировать');
  };
  const downloadCfg = () => {
    if (cfgLink) downloadText(`novpn-${cfgName}.txt`, cfgLink);
    else if (cfgConf) downloadText(`novpn-${cfgName}.conf`, cfgConf);
  };
  const shareCfg = async () => {
    const text = cfgLink ?? cfgConf ?? '';
    if (!(await shareText(text))) {
      await copyText(text);
      showToast('Скопировано (Web Share недоступен)');
    }
  };

  return (
    <div className="stack" style={{ gap: 16, paddingTop: 12 }}>
      <div className="row-between">
        <div className="row" style={{ gap: 12, minWidth: 0 }}>
          <BackButton onClick={back} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
            {stepLabel ? <div className="small muted">{stepLabel}</div> : null}
          </div>
        </div>
      </div>

      {mode === 'issue' && step < 4 ? (
        <div className="row" style={{ gap: 6 }}>
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="progress" style={{ flex: 1, height: 4 }}>
              <span style={{ width: n <= step ? '100%' : '0%' }} />
            </div>
          ))}
        </div>
      ) : null}

      {/* STEP 1 — name */}
      {mode === 'issue' && step === 1 ? (
        <div className="stack" style={{ gap: 14 }}>
          <p className="body small" style={{ margin: 0 }}>Назовите устройство, чтобы потом было проще его узнать.</p>
          <input className="input" placeholder="Например, Телефон" aria-label="Название устройства" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="chip-row">
            {['Телефон', 'Ноутбук', 'Планшет', 'ПК'].map((q) => (
              <button key={q} type="button" className="chip chip-sm" onClick={() => setName(q)}>{q}</button>
            ))}
          </div>
          <button className="btn btn-primary btn-lg" onClick={() => setStep(2)}>Далее</button>
        </div>
      ) : null}

      {/* STEP 2 — server */}
      {mode === 'issue' && step === 2 ? (
        <div className="stack" style={{ gap: 12 }}>
          <p className="body small" style={{ margin: 0 }}>Выберите сервер подключения.</p>
          <div className="stack" style={{ gap: 8 }}>
            {allowedServers.map((s) => {
              const online = s.online;
              const selected = serverId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={!online}
                  onClick={() => setServerId(s.id)}
                  className="card"
                  style={{
                    textAlign: 'left', cursor: online ? 'pointer' : 'not-allowed', opacity: online ? 1 : 0.5,
                    border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`, display: 'flex', alignItems: 'center', gap: 10,
                  }}
                >
                  <Dot color={online ? 'var(--green-dot)' : 'var(--red-fg)'} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span style={{ fontWeight: 700 }}>{s.name}</span>
                      {s.recommended ? <span className="badge">Рекомендуемый</span> : s.isDefault ? <span className="badge">По умолчанию</span> : null}
                    </div>
                    <div className="small muted">{online ? s.host : 'временно недоступен'}</div>
                  </div>
                </button>
              );
            })}
          </div>
          <button className="btn btn-primary btn-lg" disabled={!serverId} onClick={() => setStep(3)}>Далее</button>
        </div>
      ) : null}

      {/* STEP 3 — platform + app */}
      {mode === 'issue' && step === 3 ? (
        <div className="stack" style={{ gap: 14 }}>
          <div className="stack" style={{ gap: 8 }}>
            <span className="eyebrow">1 · Ваша система</span>
            <div className="chip-row">
              {PLATFORMS.map((p) => (
                <button key={p} type="button" className={`chip chip-sm ${platform === p ? 'active' : ''}`} onClick={() => { setPlatform(p); setAppId(null); }}>{p}</button>
              ))}
            </div>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <span className="eyebrow">2 · Приложение</span>
            <p className="small muted" style={{ margin: 0 }}>Протокол и формат конфигурации подберутся автоматически под выбранное приложение.</p>
            {availableApps.length === 0 ? (
              <EmptyState title="Нет приложений для этой платформы" text="Выберите другую платформу выше." />
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {availableApps.map((a) => {
                  const selected = appId === a.id;
                  const kindLabel = appKind(a) === 'xray' ? 'Xray' : appKind(a) === 'amnezia-app' ? 'AmneziaVPN' : 'AmneziaWG';
                  return (
                    <button key={a.id} type="button" onClick={() => setAppId(a.id)} className="card"
                      style={{ textAlign: 'left', cursor: 'pointer', border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 34, height: 34, borderRadius: 'var(--r-ctrl)', background: 'var(--surface-btn-2)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, color: 'var(--accent-light)' }}>
                        {a.icon ? <img src={a.icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : a.client.charAt(0)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row" style={{ gap: 8 }}><span style={{ fontWeight: 700 }}>{a.client}</span><span className="badge">{kindLabel}</span></div>
                        <div className="small muted">{platform}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <button className="btn btn-primary btn-lg" disabled={!appId || issuing} onClick={doIssue}>
            {issuing ? 'Создаём конфигурацию…' : 'Создать конфигурацию'}
          </button>
        </div>
      ) : null}

      {/* STEP 4 — result */}
      {step === 4 ? (
        <div className="stack" style={{ gap: 14 }}>
          {result ? (
            <div className="notice notice-green">
              <div style={{ fontWeight: 700 }}>Конфигурация готова</div>
              <div className="small" style={{ marginTop: 2 }}>Импортируйте её в приложение — инструкция ниже.</div>
            </div>
          ) : null}

          <div className="card" style={{ padding: '4px 16px' }}>
            {[
              ['Устройство', cfgName],
              ['Сервер', chosenServer?.name ?? '—'],
              ['Приложение', chosenApp?.client ?? '—'],
              ['Протокол', protoLabelFull],
              ['Создано', dateShort(result?.device.createdAt ?? viewDevice?.createdAt ?? new Date().toISOString())],
            ].map(([k, v]) => (
              <div key={k} className="divide-row">
                <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted-2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{k}</span>
                <span style={{ fontWeight: 600, textAlign: 'right' }}>{v}</span>
              </div>
            ))}
          </div>

          {cfgConf && result ? (
            <div className="notice notice-amber">
              <div className="row" style={{ gap: 8 }}><span style={{ fontWeight: 700 }}>Официальный ключ vpn://</span><span className="badge" style={{ color: 'var(--amber-fg)', background: 'var(--amber-bg)' }}>недоступно</span></div>
              <div className="small" style={{ marginTop: 4 }}>Выдача официального ключа появится позже. Пока AmneziaVPN импортирует конфигурацию AmneziaWG (.conf) — используйте кнопки ниже.</div>
            </div>
          ) : null}

          {cfgLink || cfgConf ? (
            <div className="card stack" style={{ gap: 12, alignItems: 'stretch' }}>
              {/* QR — только для Xray-ссылки: её приложения читают сканированием.
                  Сырой .conf AmneziaWG через QR не импортируется, поэтому для него
                  QR не показываем — там основной способ «Скачать .conf». */}
              {cfgLink ? (
                <Qr text={cfgLink} caption="Отсканируйте в приложении" />
              ) : (
                <div className="notice small">
                  Скачайте файл <b>.conf</b> и откройте его в приложении AmneziaWG или AmneziaVPN
                  («Добавить из файла»). QR для AmneziaWG не используется — приложение его не читает.
                </div>
              )}
              <div className="field-label">{cfgLink ? 'Ссылка подключения' : 'Конфигурация AmneziaWG (.conf)'}</div>
              <pre className="mono" style={{ background: 'var(--bg-app)', border: '1px solid var(--border-input)', borderRadius: 'var(--r-ctrl)', padding: 12, margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', overflowX: 'auto', wordBreak: 'break-all', maxHeight: 220 }}>
                {cfgLink ?? cfgConf}
              </pre>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" onClick={copyCfg}>{cfgLink ? 'Копировать' : 'Копировать .conf'}</button>
                <button className="btn btn-outline btn-sm" onClick={downloadCfg}>{cfgLink ? 'Скачать' : 'Скачать .conf'}</button>
                <button className="btn btn-outline btn-sm" onClick={shareCfg}>Поделиться</button>
              </div>
            </div>
          ) : null}

          {chosenApp && result ? (
            <div className="card stack" style={{ gap: 6 }}>
              <span className="eyebrow">Подключение и использование</span>
              <p className="small body" style={{ margin: 0, lineHeight: 1.5 }}>
                {chosenApp.instruction || 'Откройте приложение, выберите добавленный профиль и включите подключение.'}
              </p>
            </div>
          ) : null}

          <div className="notice notice-amber small">Не передавайте конфигурацию посторонним — она привязана к вашему коду и лимитам.</div>

          <button className="btn btn-primary btn-lg" onClick={() => goPublic(mode === 'view' ? 'devices' : 'cabinet')}>
            {mode === 'view' ? 'К устройствам' : 'Готово'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
