// A10 — Настройки. Брендинг, значения по умолчанию, шаблон и параметры безопасности.

import { useState } from 'react';
import type { AppSettings, UserProtocol } from '@novpn/shared';
import { RU_WHITELIST_ROUTES } from '@novpn/shared';
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
  // Имя бренда/сервиса (метка конфигов #<бренд>-устройство и Profile-Title подписки).
  // Пусто → фолбэк на APP_NAME на бэке (по умолчанию «NoVPN»).
  const [brandName, setBrandName] = useState(s?.brandName ?? '');
  // Отсутствие поля трактуем как ВКЛ (старые панели): продвинутый X-Ray по умолчанию включён.
  const [xrayWhitelist, setXrayWhitelist] = useState(s?.xrayWhitelist !== false);
  // Доступ клиента в локальную сеть сервера через туннель. По умолчанию ВЫКЛ.
  const [lanAccess, setLanAccess] = useState(s?.lanAccess === true);
  // Уведомления администратору в Telegram (по adminTelegramChatId — свой ID из /id).
  const [adminChatId, setAdminChatId] = useState(s?.adminTelegramChatId ?? '');
  const [notifyErrors, setNotifyErrors] = useState(s?.notifyErrors !== false);
  const [dailyDigest, setDailyDigest] = useState(s?.dailyDigest !== false);
  // Редактируемый список доменов обхода (по строке на домен). Если у панели он ещё не
  // задан явно — префилл встроенным дефолтом (146 доменов), чтобы админ видел и правил их.
  const wlDefaultText = RU_WHITELIST_ROUTES.join('\n');
  const wlInitial = (s?.whitelistDomains?.length ? s.whitelistDomains : RU_WHITELIST_ROUTES).join('\n');
  const [whitelistText, setWhitelistText] = useState(wlInitial);
  // Список совпадает со встроенным дефолтом → сохраняем как «пусто» (панель продолжит
  // получать обновления списка из кода, а не заморозит текущие 146 доменов). Иначе —
  // кастомный список пользователя (findings #6).
  const wlLines = whitelistText.split('\n').map((l) => l.trim()).filter(Boolean);
  const wlIsBuiltin = wlLines.join('\n') === wlDefaultText;
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
    if (bkPass.length < 8) {
      showToast('Пароль бэкапа — минимум 8 символов');
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
    codeLoginDays !== (s.codeLoginDays ?? 15) ||
    xrayWhitelist !== (s.xrayWhitelist !== false) ||
    brandName !== (s.brandName ?? '') ||
    lanAccess !== (s.lanAccess === true) ||
    adminChatId !== (s.adminTelegramChatId ?? '') ||
    notifyErrors !== (s.notifyErrors !== false) ||
    dailyDigest !== (s.dailyDigest !== false) ||
    whitelistText !== wlInitial;

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
        xrayWhitelist,
        brandName: brandName.trim(),
        lanAccess,
        adminTelegramChatId: adminChatId.trim(),
        notifyErrors,
        dailyDigest,
        // Совпадает со встроенным → пусто (не морозим список, ловим обновления из кода).
        whitelistDomains: wlIsBuiltin ? [] : wlLines,
      };
      await saveSettings(input);
      showToast('Настройки сохранены');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось сохранить настройки');
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
          {domain.trim() !== (s.domain ?? '').trim() ? (
            <div className="notice notice-amber small" style={{ marginTop: 8 }}>
              <b>Внимание:</b> уже разосланные пользователям личные ссылки и подписки со старым
              адресом после смены перестанут открываться — их придётся выдать заново.
            </div>
          ) : null}
        </Panel>

        {/* Брендинг — имя сервиса в клиентах и подписке */}
        <Panel title="Название сервиса (бренд)">
          <div className="body small muted" style={{ marginBottom: 10 }}>
            Как ваш сервис называется в приложении пользователя: метка каждого конфига
            (<span className="mono">бренд-Устройство</span>) и название подписки (Profile-Title).
            Имя <b>сервера</b> (🇫🇮 Finland и т. п.) задаётся отдельно в разделе «Серверы» —
            это не оно. Задаётся один раз; на уже выданные ссылки старая метка останется.
          </div>
          <Field label="Название сервиса">
            <input
              className="input"
              placeholder="NoVPN"
              maxLength={32}
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
            />
          </Field>
          {!brandName.trim() ? (
            <div className="body small muted" style={{ marginTop: 6 }}>
              Пусто → используется значение по умолчанию («NoVPN»).
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

        {/* Продвинутый режим X-Ray: обход белых списков + аварийный фоллбэк */}
        <Panel title="Продвинутый режим X-Ray">
          <div className="body small muted" style={{ marginBottom: 10 }}>
            Подписка X-Ray отдаётся как полный конфиг с <b>обходом «белых списков»</b>
            (российские домены — напрямую, мимо VPN) и <b>аварийным фоллбэком</b>: если
            X-Ray заблокируют, трафик сам переключается на прокси (HTTPS → HTTP → SOCKS).
            Выключите — пользователи получат обычную подписку (только ссылки, без обхода);
            приложения подтянут её при следующем обновлении.
          </div>
          <div className="chip-row" style={{ marginBottom: 10 }}>
            <Chip label={xrayWhitelist ? 'Включён' : 'Выключен'} active={xrayWhitelist} onClick={() => setXrayWhitelist((v) => !v)} />
          </div>
          {xrayWhitelist ? (
            <div className="body small" style={{ background: 'var(--amber-bg)', color: 'var(--amber-fg)', padding: '10px 12px', borderRadius: 10 }}>
              ⚠️ Аварийный фоллбэк работает через прокси, установленные на сервере
              (HTTP / SOCKS / HTTPS). Если прокси не установлены — обход «белых списков»
              всё равно работает, но резервных каналов не будет (только X-Ray). HTTPS-прокси
              требует домена. Установить прокси можно в разделе «Серверы» → сервер → «Прокси».
            </div>
          ) : null}
          {xrayWhitelist ? (
            <Field
              label="Домены обхода (по одному в строке)"
              hint="Идут напрямую, мимо VPN. Просто «ya.ru» = поддомены; «full:go.yandex» = точное совпадение. Меняется сразу, без деплоя. Пусто → встроенный список."
            >
              <textarea
                className="textarea mono"
                style={{ minHeight: 180, fontSize: 12 }}
                spellCheck={false}
                placeholder={'ya.ru\nmail.ru\nvk.com\nozon.ru\naliexpress.ru'}
                value={whitelistText}
                onChange={(e) => setWhitelistText(e.target.value)}
              />
              <div className="body small muted" style={{ marginTop: 6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>Строк: {wlLines.length}</span>
                {wlIsBuiltin ? (
                  <span style={{ color: 'var(--ok-fg, #2a9d3c)' }}>✓ встроенный список (обновляется с приложением)</span>
                ) : (
                  <>
                    <span style={{ color: 'var(--amber-fg)' }}>● свой список (обновления из кода не применяются)</span>
                    <button type="button" className="btn btn-sec btn-sm" onClick={() => setWhitelistText(wlDefaultText)}>
                      Сбросить к встроенному
                    </button>
                  </>
                )}
              </div>
            </Field>
          ) : null}
        </Panel>

        {/* Доступ в локальную сеть сервера */}
        <Panel title="Доступ в локальную сеть">
          <div className="body small muted" style={{ marginBottom: 10 }}>
            Пропускать ли через туннель приватные адреса (192.168.x, 10.x и т. п.). По
            умолчанию <b>закрыт</b> — в продвинутом X-Ray-конфиге приватные адреса идут мимо
            VPN (клиент держит свою локалку сам, безопаснее). Включите, если ставите конфиг
            себе <b>домой</b> и хотите через VPN добираться до устройств локальной сети
            вашего сервера. Влияет на продвинутый X-Ray; AmneziaWG и так тоннелит все
            диапазоны (доступ к локалке зависит от маршрутизации на сервере).
          </div>
          <div className="chip-row">
            <Chip label={lanAccess ? 'Разрешён' : 'Закрыт'} active={lanAccess} onClick={() => setLanAccess((v) => !v)} />
          </div>
        </Panel>

        {/* Уведомления администратору в Telegram */}
        <Panel title="Уведомления администратору (Telegram)">
          <div className="body small muted" style={{ marginBottom: 10 }}>
            Бот будет присылать вам уведомления об ошибках и ежедневную сводку (трафик,
            пользователи, серверы). Управление панелью — только здесь, в вебе; в Telegram
            приходят <b>только уведомления</b>. Узнать свой Telegram-ID: напишите боту
            команду <span className="mono">/id</span>. Нужно, чтобы бот был включён в разделе «Telegram».
          </div>
          <Field label="Ваш Telegram-ID">
            <input
              className="input mono"
              placeholder="напр. 123456789"
              inputMode="numeric"
              value={adminChatId}
              onChange={(e) => setAdminChatId(e.target.value)}
            />
          </Field>
          <div className="chip-row" style={{ marginTop: 8 }}>
            <Chip label={notifyErrors ? 'Ошибки: вкл' : 'Ошибки: выкл'} active={notifyErrors} onClick={() => setNotifyErrors((v) => !v)} />
            <Chip label={dailyDigest ? 'Сводка за сутки: вкл' : 'Сводка за сутки: выкл'} active={dailyDigest} onClick={() => setDailyDigest((v) => !v)} />
          </div>
          {!adminChatId.trim() ? (
            <div className="body small muted" style={{ marginTop: 6 }}>
              Пусто — уведомления не отправляются.
            </div>
          ) : null}
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
            Файл содержит данные доступа ВСЕХ пользователей (личные токены, коды, привязки)
            — храните его как секрет, вместе с паролем, в надёжном месте (например, в
            менеджере паролей). Файл самодостаточен: его можно развернуть на новой панели.
            Восстановление тоже работает — но всё, что вы делали после снятия бэкапа, будет
            потеряно.
          </div>

          <Field label="Пароль для шифрования бэкапа">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input
                className="input"
                type="password"
                placeholder="минимум 8 символов"
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
