import { Fragment, useEffect, useRef, useState } from 'react';
import type { RoutingCheckResult, RoutingFileMeta, RoutingFileName, RoutingSourceStats } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import { Chip, Field, Loading, Panel, Toggle } from '../components/ui';
import { JsonEditor } from '../components/JsonEditor';
import type { JsonValidity } from '../components/JsonEditor';
import { downloadText } from '../lib/clipboard';

const FILES: { name: RoutingFileName; title: string; blurb: string }[] = [
  // Upstream сюда не входит: им управляет AutoRoute (отдельный редактор, сборка из
  // многих источников). Sites убран — список сайтов пользователь ведёт локально в
  // NoVPN Desktop. Остаётся только каталог приложений.
  { name: 'apps', title: 'Apps JSON', blurb: 'Каталог приложений: имена процессов, пути установки, иконки, рекомендуемый маршрут.' },
];

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}
function editorHeight(): number {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
  return Math.round(Math.min(640, Math.max(420, vh * 0.6)));
}

const STATUS_COLOR: Record<RoutingFileMeta['status'], string> = {
  ok: 'var(--green-fg)',
  nochange: 'var(--green-fg)',
  idle: 'var(--text-muted)',
  error: 'var(--red-fg)',
  rejected: 'var(--amber-fg)',
};
const STATUS_LABEL: Record<RoutingFileMeta['status'], string> = {
  ok: '✓ Обновлено',
  nochange: '✓ Актуально',
  idle: 'Не проверялось',
  error: '✕ Ошибка',
  rejected: '⚠ Отклонено проверкой',
};
const FORMAT_LABEL: Record<RoutingSourceStats['format'], string> = {
  json: 'JSON',
  lst: 'LST',
  txt: 'TXT',
  srs: 'SRS (sing-box binary)',
};

// Строки статистики конвертации источника — раскладываются в родительскую grid `auto 1fr`.
function StatsRows({ stats }: { stats: RoutingSourceStats | null | undefined }) {
  if (!stats) return null;
  const rows: [string, string][] = [['Исходный формат', FORMAT_LABEL[stats.format] ?? stats.format]];
  if (stats.lines != null) rows.push(['Строк получено', stats.lines.toLocaleString('ru-RU')]);
  if (stats.valid != null) rows.push(['Валидных элементов', stats.valid.toLocaleString('ru-RU')]);
  if (stats.skipped != null) rows.push(['Пропущено', stats.skipped.toLocaleString('ru-RU')]);
  if (stats.dups != null) rows.push(['Дубликатов удалено', stats.dups.toLocaleString('ru-RU')]);
  return (
    <>
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <span className="muted">{k}</span>
          <span>{v}</span>
        </Fragment>
      ))}
    </>
  );
}

export function SmartRouting() {
  const { goAdmin } = useApp();
  const [files, setFiles] = useState<RoutingFileMeta[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.getRoutingFiles();
      setFiles(r.files);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось загрузить.');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <div className="eyebrow" style={{ marginBottom: 4 }}>Маршрутизация</div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>Умная маршрутизация</div>
        <div className="body small muted" style={{ marginTop: 6, maxWidth: 620 }}>
          Конфигурация для NoVPN Desktop. Клиентам всегда отдаётся стабильный URL этой панели — даже когда
          содержимое собирается из внешних источников.
        </div>
      </div>

      {err ? <div className="notice notice-red" style={{ marginBottom: 14 }}>{err}</div> : null}
      <div className="stack" style={{ gap: 16, maxWidth: 760 }}>
        {/* Основная база — в отдельном редакторе AutoRoute; здесь только вход в него. */}
        <Panel title="AutoRoute — основная база">
          <div className="body small muted" style={{ marginTop: -2 }}>
            Что не работает в России — идёт через VPN, остальное напрямую. Источники, приоритеты, версии и откат,
            публичные DAT/JSON-ссылки и проверка домена — всё в отдельном редакторе.
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" onClick={() => goAdmin('autoroute')}>Открыть AutoRoute</button>
            <a className="btn btn-outline btn-sm" href={`${origin}/routing/autoroute/geosite.dat`} target="_blank" rel="noreferrer">geosite.dat</a>
            <a className="btn btn-outline btn-sm" href={`${origin}/routing/autoroute/geoip.dat`} target="_blank" rel="noreferrer">geoip.dat</a>
            <a className="btn btn-outline btn-sm" href={`${origin}/routing/upstream.json`} target="_blank" rel="noreferrer">upstream.json</a>
          </div>
        </Panel>
        {!files ? (
          <Loading text="Загрузка…" />
        ) : (
          FILES.map((f) => {
            const meta = files.find((x) => x.name === f.name);
            return meta ? <RoutingCard key={f.name} spec={f} meta={meta} origin={origin} onChanged={load} /> : null;
          })
        )}
      </div>
    </>
  );
}

function RoutingCard({
  spec,
  meta,
  origin,
  onChanged,
}: {
  spec: { name: RoutingFileName; title: string; blurb: string };
  meta: RoutingFileMeta;
  origin: string;
  onChanged: () => Promise<void> | void;
}) {
  const { showToast } = useApp();
  const name = spec.name;

  const [editor, setEditor] = useState<{ content: string; origin: 'edit' | 'upload' | 'source' } | null>(null);
  const [validity, setValidity] = useState<JsonValidity | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false); // скачивание/открытие

  const [mode, setMode] = useState(meta.mode);
  const [autoSync, setAutoSync] = useState(meta.autoSync);
  const [url, setUrl] = useState(meta.sourceUrl);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<RoutingCheckResult | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const urlDirty = url.trim() !== meta.sourceUrl;

  // Синхронизируем локальные поля источника, когда meta обновилась извне.
  useEffect(() => {
    setMode(meta.mode);
    setAutoSync(meta.autoSync);
    setUrl(meta.sourceUrl);
  }, [meta.mode, meta.autoSync, meta.sourceUrl]);

  const openEditorWith = (content: string, o: 'edit' | 'upload' | 'source') => {
    setValidity(null);
    setEditor({ content, origin: o });
  };

  const doDownload = async () => {
    setBusy(true);
    try {
      const full = await api.getRoutingFile(name);
      downloadText(`${name}.json`, full.content, 'application/json');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось скачать.');
    } finally {
      setBusy(false);
    }
  };

  const doEdit = async () => {
    setBusy(true);
    try {
      const full = await api.getRoutingFile(name);
      openEditorWith(full.content, 'edit');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось открыть.');
    } finally {
      setBusy(false);
    }
  };

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      openEditorWith(text, 'upload');
    } catch {
      showToast('Не удалось прочитать файл.');
    }
  };

  const doSave = async () => {
    if (!editor || !validity?.valid) return;
    setSaving(true);
    try {
      const r = await api.saveRoutingFile(name, editor.content);
      showToast(r.changed ? `Сохранено: ${name}.json v${r.meta.version}` : 'Изменений нет — версия прежняя');
      setEditor(null);
      setCheckResult(null);
      await onChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось сохранить.');
    } finally {
      setSaving(false);
    }
  };

  const persistSource = async (patch: { mode?: 'local' | 'mirror'; sourceUrl?: string; autoSync?: boolean }) => {
    try {
      await api.saveRoutingSource(name, patch);
      await onChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось сохранить источник.');
    }
  };

  const selectMode = (m: 'local' | 'mirror') => {
    setMode(m);
    void persistSource({ mode: m });
  };
  const toggleAuto = (v: boolean) => {
    setAutoSync(v);
    void persistSource({ autoSync: v });
  };
  const saveUrl = () => void persistSource({ sourceUrl: url.trim() });

  const doCheck = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const r = await api.checkRoutingSource(name);
      setCheckResult(r);
      if (!r.ok) showToast(r.reason);
      else if (!r.changed) showToast('Обновлений нет');
      await onChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось проверить.');
    } finally {
      setChecking(false);
    }
  };

  const publicUrl = `${origin}/routing/${name}.json`;

  return (
    <Panel title={spec.title}>
      <div className="body small muted" style={{ marginTop: -2 }}>{spec.blurb}</div>

      {/* Метаданные файла */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 13, marginTop: 4 }}>
        <span className="muted">Файл</span>
        <span className="mono">{name}.json</span>
        <span className="muted">Версия</span>
        <span>v{meta.version}</span>
        <span className="muted">Обновлено</span>
        <span>{fmtDate(meta.updatedAt)}</span>
        <span className="muted">Размер</span>
        <span>{fmtSize(meta.size)}</span>
        <span className="muted">Статус</span>
        <span style={{ color: 'var(--green-fg)' }}>✓ Валидный JSON</span>
        <span className="muted">Элементов</span>
        <span>{meta.entryCount == null ? '—' : meta.entryCount.toLocaleString('ru-RU')}</span>
        <span className="muted">Публичный URL</span>
        <a className="mono" href={publicUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--link)', wordBreak: 'break-all' }}>
          {publicUrl}
        </a>
      </div>

      {/* Действия с файлом */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => void doDownload()}>Скачать</button>
        <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>Загрузить</button>
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void doEdit()}>Редактировать</button>
        <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={(e) => void onFilePicked(e)} />
      </div>

      {/* Редактор (скрыт по умолчанию) */}
      {editor ? (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <b style={{ fontSize: 14 }}>Редактирование: {name}.json</b>
            {editor.origin !== 'edit' ? (
              <span className="small" style={{ color: 'var(--amber-fg)' }}>
                {editor.origin === 'upload' ? 'Загруженный файл — не сохранён' : 'Новая версия из источника — не сохранена'}
              </span>
            ) : null}
          </div>
          <JsonEditor value={editor.content} onChange={(v) => setEditor({ ...editor, content: v })} onValidityChange={setValidity} height={editorHeight()} />
          <div className="row" style={{ gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button className="btn btn-outline btn-sm" onClick={() => { setEditor(null); setValidity(null); }}>Отмена</button>
            <button className="btn btn-primary btn-sm" disabled={saving || !validity?.valid} onClick={() => void doSave()}>
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </div>
      ) : null}

      {/* Источник (зеркало) */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="field-label">Источник содержимого</div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Chip label="Локальное управление" active={mode === 'local'} onClick={() => selectMode('local')} size="sm" />
          <Chip label="Синхронизация с внешнего URL" active={mode === 'mirror'} onClick={() => selectMode('mirror')} size="sm" />
        </div>

        {mode === 'mirror' ? (
          <>
            <Field label="Внешний источник (URL)" hint="Прямой HTTPS-адрес. Форматы: .json, .lst, .txt (списки доменов), .srs (sing-box). NoVPN станет локальным зеркалом.">
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input
                  className="input mono"
                  style={{ flex: 1, minWidth: 240, fontSize: 12 }}
                  placeholder="https://raw.githubusercontent.com/…/sites.lst"
                  spellCheck={false}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <button className="btn btn-secondary btn-sm" disabled={!urlDirty} onClick={saveUrl}>Сохранить URL</button>
              </div>
            </Field>
            {meta.sourceUrl ? (
              <div className="small muted" style={{ marginTop: -4 }}>
                Формат источника: <b style={{ color: 'var(--text-secondary)' }}>{FORMAT_LABEL[meta.sourceFormat]}</b>
              </div>
            ) : null}

            <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
              <div className="row" style={{ gap: 10 }}>
                <Toggle on={autoSync} onChange={toggleAuto} ariaLabel="Автосинхронизация" />
                <span className="small">Автосинхронизация {autoSync ? 'вкл' : 'выкл'}</span>
              </div>
              <span className="small muted">Интервал: 1 час</span>
            </div>

            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-outline btn-sm" disabled={checking || !meta.sourceUrl || urlDirty} onClick={() => void doCheck()}>
                {checking ? 'Проверяем…' : 'Проверить сейчас'}
              </button>
              {urlDirty ? <span className="small muted" style={{ alignSelf: 'center' }}>Сначала сохраните URL.</span> : null}
            </div>

            {/* Состояние синхронизации */}
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', fontSize: 13 }}>
              <span className="muted">Последняя проверка</span>
              <span>{fmtDate(meta.lastCheckAt)}</span>
              <span className="muted">Последнее обновление</span>
              <span>{fmtDate(meta.lastOkAt)}</span>
              <span className="muted">Статус</span>
              <span style={{ color: STATUS_COLOR[meta.status] }}>{STATUS_LABEL[meta.status]}</span>
              {meta.lastAdded != null || meta.lastRemoved != null ? (
                <>
                  <span className="muted">Изменения</span>
                  <span>
                    <span style={{ color: 'var(--green-fg)' }}>+{meta.lastAdded ?? 0}</span>{' '}
                    <span style={{ color: 'var(--red-fg)' }}>−{meta.lastRemoved ?? 0}</span>
                  </span>
                </>
              ) : null}
              <StatsRows stats={meta.sourceStats} />
            </div>
            {meta.statusReason ? (
              <div className={`notice ${meta.status === 'rejected' ? 'notice-amber' : meta.status === 'error' ? 'notice-red' : 'notice-green'}`}>
                {meta.statusReason}
              </div>
            ) : null}

            {/* Результат ручной проверки */}
            {checkResult ? (
              checkResult.ok && checkResult.changed ? (
                <div className="notice notice-amber" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span>
                    Найдены изменения. Добавлено:{' '}
                    <b>{checkResult.added ?? '—'}</b>, удалено: <b>{checkResult.removed ?? '—'}</b>.
                    {' '}Автоматически не публикуется — просмотрите и сохраните.
                  </span>
                  {checkResult.stats && checkResult.stats.lines != null ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 14px', fontSize: 12 }}>
                      <StatsRows stats={checkResult.stats} />
                    </div>
                  ) : null}
                  {checkResult.content ? (
                    <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => openEditorWith(checkResult.content!, 'source')}>
                      Открыть в редакторе
                    </button>
                  ) : null}
                </div>
              ) : checkResult.ok ? (
                <div className="notice notice-green">Обновлений нет.</div>
              ) : (
                <div className="notice notice-red">{checkResult.reason}</div>
              )
            ) : null}
          </>
        ) : null}
      </div>
    </Panel>
  );
}
