// A10 — Настройки. Брендинг, значения по умолчанию, шаблон и параметры безопасности.

import { useState } from 'react';
import type { AppSettings, UserProtocol } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import { Chip, Field, Panel } from '../components/ui';

const PROTO_OPTIONS: Array<{ value: UserProtocol; label: string }> = [
  { value: 'xray', label: 'Xray' },
  { value: 'amneziawg', label: 'Amnezia' },
];

function numOr(raw: string, fallback: number): number {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function Settings() {
  const { data, saveSettings, showToast, showConfirm } = useApp();
  const s = data?.settings;

  const [domain, setDomain] = useState(s?.domain ?? '');
  const [defaultServerId, setDefaultServerId] = useState<string | null>(s?.defaultServerId ?? null);
  const [defaultProtocols, setDefaultProtocols] = useState<UserProtocol[]>(s?.defaultProtocols ?? []);
  const [messageTemplate, setMessageTemplate] = useState(s?.messageTemplate ?? '');
  const [codeAttempts, setCodeAttempts] = useState(s?.codeAttempts ?? 5);
  const [codeCooldownMin, setCodeCooldownMin] = useState(s?.codeCooldownMin ?? 15);
  const [inactiveDisableDays, setInactiveDisableDays] = useState(s?.inactiveDisableDays ?? 0);
  const [codeLoginDays, setCodeLoginDays] = useState(s?.codeLoginDays ?? 15);
  const [saving, setSaving] = useState(false);

  // Пароль администратора
  const [pwCur, setPwCur] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  // Экстренная рассылка через бота
  const [bcText, setBcText] = useState('');
  const [bcBusy, setBcBusy] = useState(false);

  // Бэкап базы
  const [bkPass, setBkPass] = useState('');
  const [bkBusy, setBkBusy] = useState(false);
  const [restoreFile, setRestoreFile] = useState<string | null>(null);
  const [restorePass, setRestorePass] = useState('');

  if (!data || !s) return null;

  const toggleProtocol = (value: UserProtocol) =>
    setDefaultProtocols((prev) => (prev.includes(value) ? prev.filter((p) => p !== value) : [...prev, value]));

  const changePassword = async () => {
    if (pwNew.length < 6) {
      showToast('Новый пароль — минимум 6 символов');
      return;
    }
    setPwBusy(true);
    try {
      await api.changeAdminPassword(pwCur, pwNew);
      setPwCur('');
      setPwNew('');
      showToast('Пароль изменён');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось сменить пароль');
    } finally {
      setPwBusy(false);
    }
  };

  const restartPanel = () =>
    showConfirm({
      title: 'Перезапустить панель?',
      text: 'Панель будет недоступна несколько секунд. Подключения пользователей к VPN это не затрагивает.',
      confirmLabel: 'Перезапустить',
      onConfirm: async () => {
        await api.restartPanel();
        showToast('Перезапускаем… обновите страницу через несколько секунд');
      },
    });

  const sendBroadcast = () => {
    const text = bcText.trim();
    if (!text) {
      showToast('Введите текст сообщения');
      return;
    }
    showConfirm({
      title: 'Разослать всем?',
      text: 'Сообщение получат все пользователи с привязанным Telegram. Отменить рассылку нельзя.',
      confirmLabel: 'Отправить',
      onConfirm: async () => {
        setBcBusy(true);
        try {
          const r = await api.broadcast(text);
          setBcText('');
          showToast(r.total === 0 ? 'Нет пользователей с привязанным Telegram' : `Отправлено ${r.sent} из ${r.total}`);
        } catch (e) {
          showToast(e instanceof Error ? e.message : 'Не удалось разослать');
        } finally {
          setBcBusy(false);
        }
      },
    });
  };

  const downloadBackup = async () => {
    if (bkPass.length < 4) {
      showToast('Пароль бэкапа — минимум 4 символа');
      return;
    }
    setBkBusy(true);
    try {
      const blob = await api.exportBackup(bkPass);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = `novpn-backup-${stamp}.novpnbak`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('Бэкап скачан — сохраните файл и пароль');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось создать бэкап');
    } finally {
      setBkBusy(false);
    }
  };

  const pickRestoreFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result — data:...;base64,XXXX — берём часть после запятой.
      const res = String(reader.result);
      setRestoreFile(res.slice(res.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  };

  const doRestore = () => {
    if (!restoreFile) {
      showToast('Выберите файл бэкапа');
      return;
    }
    showConfirm({
      title: 'Восстановить базу из бэкапа?',
      text: 'Текущая база будет заменена содержимым бэкапа. Панель перезапустится. Все изменения, сделанные после этого бэкапа, будут потеряны.',
      confirmLabel: 'Восстановить',
      danger: true,
      onConfirm: async () => {
        const r = await api.restoreBackup(restoreFile, restorePass);
        showToast(`Восстановлено: ${r.users} пользователей. Панель перезапускается…`);
      },
    });
  };

  // Настройки изменены? Тогда показываем липкую панель сохранения.
  const dirty =
    domain !== (s.domain ?? '') ||
    defaultServerId !== (s.defaultServerId ?? null) ||
    JSON.stringify(defaultProtocols) !== JSON.stringify(s.defaultProtocols ?? []) ||
    messageTemplate !== (s.messageTemplate ?? '') ||
    codeAttempts !== (s.codeAttempts ?? 5) ||
    codeCooldownMin !== (s.codeCooldownMin ?? 15) ||
    inactiveDisableDays !== (s.inactiveDisableDays ?? 0) ||
    codeLoginDays !== (s.codeLoginDays ?? 15);

  const save = async () => {
    setSaving(true);
    try {
      // Сохраняем поверх s: неотредактированные поля сохраняют прежние значения.
      const input: AppSettings = {
        ...s,
        domain,
        defaultServerId,
        defaultProtocols,
        messageTemplate,
        codeAttempts,
        codeCooldownMin,
        inactiveDisableDays,
        codeLoginDays,
      };
      await saveSettings(input);
      showToast('Настройки сохранены');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <div className="eyebrow" style={{ marginBottom: 4 }}>Настройки</div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>Система</div>
      </div>

      <div className="stack" style={{ gap: 16, maxWidth: 640 }}>
        {/* Домен — отдельным заметным блоком: от него зависят все ссылки */}
        <Panel title="Адрес сайта (домен)">
          <div className="body small muted" style={{ marginBottom: 10 }}>
            Адрес, по которому открывается панель. От него строятся ВСЕ ссылки: личные
            ссылки пользователей, подписки Xray, привязка Telegram. Меняете домен — впишите
            новый здесь и нажмите «Перезапустить панель».
          </div>
          <Field label="Домен">
            <input
              className="input mono"
              placeholder={typeof window !== 'undefined' ? window.location.origin : 'https://vpn.example.ru'}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
          </Field>
          {!domain.trim() ? (
            <div className="body small muted" style={{ marginTop: 6 }}>
              Пока не задан — ссылки используют текущий адрес страницы.
            </div>
          ) : null}
        </Panel>

        {/* Значения по умолчанию */}
        <Panel title="Значения по умолчанию">
          <Field label="Сервер по умолчанию">
            {data.servers.length === 0 ? (
              <span className="small muted">Серверы ещё не добавлены.</span>
            ) : (
              <div className="chip-row">
                {data.servers.map((srv) => (
                  <Chip
                    key={srv.id}
                    label={srv.name}
                    size="sm"
                    active={defaultServerId === srv.id}
                    onClick={() => setDefaultServerId(srv.id)}
                  />
                ))}
              </div>
            )}
          </Field>
          <Field label="Протоколы по умолчанию">
            <div className="chip-row">
              {PROTO_OPTIONS.map((opt) => (
                <Chip
                  key={opt.value}
                  label={opt.label}
                  size="sm"
                  active={defaultProtocols.includes(opt.value)}
                  onClick={() => toggleProtocol(opt.value)}
                />
              ))}
            </div>
          </Field>
        </Panel>

        {/* Шаблон */}
        <Panel title="Шаблон сообщения пользователю">
          <Field label="Текст" hint="переменные: {link} — личная ссылка, {code} — код, {url} — адрес сайта, {expires} — срок">
            <textarea className="textarea" value={messageTemplate} onChange={(e) => setMessageTemplate(e.target.value)} />
          </Field>
        </Panel>

        {/* Защита входа по коду */}
        <Panel title="Защита входа по коду">
          <div className="body small muted" style={{ marginBottom: 10 }}>
            Сколько неудачных попыток ввода кода допускается с одного адреса,
            прежде чем он временно блокируется. Защищает от подбора.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, alignItems: 'end' }}>
            <Field label="Попыток ввода кода">
              <input
                className="input"
                type="number"
                min={1}
                value={codeAttempts}
                onChange={(e) => setCodeAttempts(numOr(e.target.value, 5))}
              />
            </Field>
            <Field label="Пауза после ошибок, минут">
              <input
                className="input"
                type="number"
                min={1}
                value={codeCooldownMin}
                onChange={(e) => setCodeCooldownMin(numOr(e.target.value, 15))}
              />
            </Field>
            <Field label="Авто-отключение кода, дней (0 — не отключать)">
              <input
                className="input"
                type="number"
                min={0}
                value={codeLoginDays}
                onChange={(e) => setCodeLoginDays(numOr(e.target.value, 15))}
              />
            </Field>
          </div>
          <div className="body small muted" style={{ marginTop: 8 }}>
            Когда вы включаете пользователю вход по коду, он автоматически отключится через
            указанное число дней. Основной способ — личная ссылка; код это временный запасной.
          </div>
        </Panel>

        {/* Автоотключение неактивных устройств */}
        <Panel title="Неактивные устройства">
          <Field label="Отключать после простоя, дней (0 — не отключать)">
            <input
              className="input"
              type="number"
              min={0}
              value={inactiveDisableDays}
              onChange={(e) => setInactiveDisableDays(numOr(e.target.value, 0))}
              style={{ maxWidth: 200 }}
            />
          </Field>
          <div className="body small muted" style={{ marginTop: 8 }}>
            Если устройство не выходит на связь дольше указанного срока, оно автоматически
            отключается. Отслеживается активность AmneziaWG (по рукопожатию). Xray работает
            одной подпиской на всех устройствах, поэтому авто-отключение к нему не применяется.
          </div>
        </Panel>

        {/* Пароль администратора и перезапуск */}
        <Panel title="Доступ в панель">
          <div className="body small muted" style={{ marginBottom: 10 }}>
            Логина нет — вход только по паролю. Смените стандартный пароль сразу после
            установки: панель доступна из интернета.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Field label="Текущий пароль">
              <input className="input" type="password" value={pwCur} onChange={(e) => setPwCur(e.target.value)} />
            </Field>
            <Field label="Новый пароль">
              <input className="input" type="password" placeholder="минимум 6 символов" value={pwNew} onChange={(e) => setPwNew(e.target.value)} />
            </Field>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            <button className="btn btn-primary btn-sm" disabled={pwBusy} onClick={() => void changePassword()}>
              {pwBusy ? 'Меняем…' : 'Сменить пароль'}
            </button>
            <button className="btn btn-outline btn-sm" onClick={restartPanel}>
              Перезапустить панель
            </button>
          </div>
          <div className="body small muted" style={{ marginTop: 8 }}>
            Перезапуск нужен, если меняли домен или переменные окружения. Занимает
            несколько секунд, выданные конфиги при этом не затрагиваются.
          </div>
        </Panel>

        {/* Экстренная рассылка через бота */}
        <Panel title="Экстренная рассылка">
          <div className="body small muted" style={{ marginBottom: 10 }}>
            Сообщение уйдёт в Telegram всем пользователям с привязанным ботом — например,
            если VPN временно недоступен и нужно всех предупредить. Нужен настроенный бот.
          </div>
          <Field label="Текст сообщения">
            <textarea
              className="input"
              rows={4}
              maxLength={4000}
              placeholder="Например: На сервере профилактика до 21:00, подключение временно недоступно."
              value={bcText}
              onChange={(e) => setBcText(e.target.value)}
              style={{ resize: 'vertical' }}
            />
          </Field>
          <div className="row" style={{ gap: 8, marginTop: 4 }}>
            <button className="btn btn-primary btn-sm" disabled={bcBusy || !bcText.trim()} onClick={sendBroadcast}>
              {bcBusy ? 'Отправляем…' : 'Отправить всем'}
            </button>
          </div>
        </Panel>

        {/* Бэкап базы */}
        <Panel title="Резервная копия базы">
          <div className="body small muted" style={{ marginBottom: 12 }}>
            Скачайте зашифрованный бэкап и храните его вместе с паролем в надёжном месте
            (например, в менеджере паролей). Файл самодостаточен: его можно развернуть на
            новой панели. Восстановление тоже работает — но всё, что вы делали после
            снятия бэкапа, будет потеряно.
          </div>

          <Field label="Пароль для шифрования бэкапа">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input
                className="input"
                type="password"
                placeholder="минимум 4 символа"
                value={bkPass}
                onChange={(e) => setBkPass(e.target.value)}
                style={{ maxWidth: 240 }}
              />
              <button className="btn btn-primary btn-sm" disabled={bkBusy} onClick={() => void downloadBackup()}>
                {bkBusy ? 'Готовим…' : 'Скачать бэкап'}
              </button>
            </div>
          </Field>

          <div style={{ height: 1, background: 'var(--border)', margin: '14px 0' }} />

          <Field label="Восстановить из бэкапа">
            <div className="stack" style={{ gap: 8 }}>
              <input
                type="file"
                accept=".novpnbak"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) pickRestoreFile(f);
                }}
              />
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input
                  className="input"
                  type="password"
                  placeholder="пароль бэкапа"
                  value={restorePass}
                  onChange={(e) => setRestorePass(e.target.value)}
                  style={{ maxWidth: 240 }}
                />
                <button className="btn btn-outline btn-sm" disabled={!restoreFile} onClick={doRestore}>
                  Восстановить
                </button>
              </div>
            </div>
          </Field>
        </Panel>
      </div>

      {/* Липкая панель сохранения: появляется, когда что-то изменено, и «едет»
          вместе с прокруткой — чтобы не пришлось искать кнопку внизу. */}
      {dirty ? (
        <div
          style={{
            position: 'sticky', bottom: 0, marginTop: 16, padding: '12px 0',
            background: 'var(--bg-app)', borderTop: '1px solid var(--border)',
            display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
          }}
        >
          <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Сохраняем…' : 'Сохранить настройки'}
          </button>
          <span className="body small muted">Есть несохранённые изменения.</span>
        </div>
      ) : null}
    </>
  );
}
