import { useEffect, useRef, useState } from 'react';
import type { DesktopMode, DesktopStatus } from '../api/types';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import { Chip, Field, Loading, Panel } from '../components/ui';

function fmtSize(b: number): string {
  return b < 1048576 ? `${(b / 1024).toFixed(0)} КБ` : `${(b / 1048576).toFixed(2)} МБ`;
}
function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}
const MODE_LABEL: Record<DesktopMode, string> = {
  auto: 'Авто-обновление',
  pin: 'Закрепить версию',
  manual: 'Ручная загрузка',
};
const MODE_HINT: Record<DesktopMode, string> = {
  auto: 'Панель раз в час проверяет центральный источник и сама раздаёт свежую версию.',
  pin: 'Раздаётся выбранная версия из локального архива; авто-обновление отключено.',
  manual: 'Автоматизм выключен — версия меняется только вашей загрузкой релиза.',
};

export function DesktopUpdates() {
  const { showToast, data, saveSettings } = useApp();
  const s = data?.settings;
  const [st, setSt] = useState<DesktopStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [chrome, setChrome] = useState('');
  const [firefox, setFirefox] = useState('');
  const [savingExt, setSavingExt] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      setSt(await api.getDesktop());
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось загрузить.');
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (s) {
      setChrome(s.extChromeUrl ?? '');
      setFirefox(s.extFirefoxUrl ?? '');
    }
  }, [s?.extChromeUrl, s?.extFirefoxUrl]);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  if (!st) return <Loading text="Загрузка…" />;
  const cur = st.current;
  const cfg = st.config;

  const applyMode = async (mode: DesktopMode, pinnedVersion?: string | null) => {
    setBusy(true);
    try {
      const r = await api.saveDesktopConfig({ mode, ...(pinnedVersion !== undefined ? { pinnedVersion } : {}) });
      setSt({ current: r.current, config: r.config, versions: r.versions });
      if (r.applied && !r.applied.ok && r.applied.error) showToast(r.applied.error);
      else showToast('Режим применён');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось сохранить.');
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    try {
      const r = await api.checkDesktopUpdate();
      showToast(!r.ok ? r.error ?? 'Ошибка' : r.action === 'nochange' ? 'Обновлений нет' : `Обновлено: ${r.version ?? ''}`);
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось проверить.');
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const r = await api.uploadDesktopRelease(file);
      setSt((prev) => ({ current: r.current, config: prev?.config ?? cfg, versions: r.versions }));
      showToast(`Опубликована версия ${r.version}`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось загрузить релиз.');
    } finally {
      setBusy(false);
    }
  };

  const saveExt = async () => {
    if (!s) return;
    setSavingExt(true);
    try {
      await saveSettings({ ...s, extChromeUrl: chrome.trim(), extFirefoxUrl: firefox.trim() });
      showToast('Ссылки на расширение сохранены');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось сохранить.');
    } finally {
      setSavingExt(false);
    }
  };

  const link = (path: string) => (
    <a className="mono" href={`${origin}${path}`} target="_blank" rel="noreferrer" style={{ color: 'var(--link)', wordBreak: 'break-all' }}>
      {origin}
      {path}
    </a>
  );

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <div className="eyebrow" style={{ marginBottom: 4 }}>Приложение</div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>Обновления приложения</div>
        <div className="body small muted" style={{ marginTop: 6, maxWidth: 640 }}>
          Управление версией NoVPN Desktop, которую раздаёт эта панель. Приложение обновляется само с вашего домена.
        </div>
      </div>

      <div className="stack" style={{ gap: 16, maxWidth: 720 }}>
        <Panel title="Текущая версия">
          {cur ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 13 }}>
              <span className="muted">Версия</span>
              <span><b>{cur.version}</b></span>
              <span className="muted">Размер</span>
              <span>{fmtSize(cur.sizeBytes)}</span>
              {cur.releasedAt ? (<><span className="muted">Дата</span><span>{fmtDate(cur.releasedAt)}</span></>) : null}
              {cur.notes ? (<><span className="muted">Что нового</span><span>{cur.notes}</span></>) : null}
              <span className="muted">Манифест</span>
              {link('/desktop/latest.json')}
              <span className="muted">Установщик</span>
              {link('/desktop/novpn.exe')}
              <span className="muted">Страница «Скачать»</span>
              {link('/download')}
            </div>
          ) : (
            <div className="notice notice-amber">Версия ещё не опубликована.</div>
          )}
        </Panel>

        <Panel title="Режим обновления">
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {(['auto', 'pin', 'manual'] as DesktopMode[]).map((m) => (
              <Chip key={m} label={MODE_LABEL[m]} active={cfg.mode === m} disabled={busy} onClick={() => void applyMode(m)} size="sm" />
            ))}
          </div>
          <div className="body small muted">{MODE_HINT[cfg.mode]}</div>
          {cfg.mode === 'pin' ? (
            <Field label="Закреплённая версия" hint="Из локального архива. Чтобы версия появилась в архиве, она должна была скачаться в режиме «Авто».">
              <select
                className="select"
                value={cfg.pinnedVersion ?? ''}
                disabled={busy}
                onChange={(e) => void applyMode('pin', e.target.value || null)}
              >
                <option value="">— выбрать —</option>
                {st.versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.version} · {fmtSize(v.sizeBytes)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {cfg.mode !== 'manual' ? (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => void check()}>
                {busy ? 'Проверяем…' : 'Проверить обновление сейчас'}
              </button>
            </div>
          ) : null}
        </Panel>

        <Panel title="Версии в архиве">
          {st.versions.length ? (
            <div className="stack" style={{ gap: 8 }}>
              {st.versions.map((v) => (
                <div key={v.version} className="row-between" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <span>
                    <b>{v.version}</b> <span className="muted small">· {fmtSize(v.sizeBytes)}</span>
                    {cur?.version === v.version ? <span className="small" style={{ color: 'var(--green-fg)', marginLeft: 8 }}>раздаётся сейчас</span> : null}
                  </span>
                  <button className="btn btn-outline btn-sm" disabled={busy || cfg.pinnedVersion === v.version} onClick={() => void applyMode('pin', v.version)}>
                    Закрепить
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="body small muted">Архив пуст.</div>
          )}
        </Panel>

        <Panel title="Загрузить релиз (для разработчика)">
          <div className="body small muted">
            ZIP-архив с релизом (<span className="mono">latest.json</span> + <span className="mono">novpn.exe</span>). Проверяется размер,
            sha256 и подпись Ed25519 — публикуется только валидный.
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? 'Загрузка…' : 'Выбрать zip и опубликовать'}
            </button>
            <input ref={fileRef} type="file" accept=".zip,application/zip" style={{ display: 'none' }} onChange={(e) => void onFile(e)} />
          </div>
        </Panel>

        <Panel title="Расширение для браузера">
          <div className="body small muted">Ссылки на страницу расширения. Пусто → на странице «Скачать» кнопка показывается неактивной («скоро»).</div>
          <Field label="Chrome / Edge / Яндекс (Chrome Web Store)">
            <input className="input mono" style={{ fontSize: 12 }} placeholder="https://chromewebstore.google.com/detail/…" value={chrome} onChange={(e) => setChrome(e.target.value)} />
          </Field>
          <Field label="Firefox (Add-ons)">
            <input className="input mono" style={{ fontSize: 12 }} placeholder="https://addons.mozilla.org/…" value={firefox} onChange={(e) => setFirefox(e.target.value)} />
          </Field>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary btn-sm" disabled={savingExt} onClick={() => void saveExt()}>
              {savingExt ? 'Сохраняем…' : 'Сохранить ссылки'}
            </button>
            <a className="btn btn-outline btn-sm" href={`${origin}/download`} target="_blank" rel="noreferrer">Открыть «Скачать»</a>
          </div>
        </Panel>
      </div>
    </>
  );
}
