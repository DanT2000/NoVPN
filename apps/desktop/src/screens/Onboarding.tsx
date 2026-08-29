/* Первый запуск. Два шага и ничего лишнего: вставить подписку и отметить
   галочки. Технических подробностей на этих экранах нет намеренно. */

import { useState } from 'react';
import { useStore } from '../state/store';
import { Check } from '../components/ui';
import { IconCheck } from '../components/icons';
import { SUGGESTED } from '../mock/data';

export function Onboarding() {
  const { nav } = useStore();
  return nav.onboardingStep === 0 ? <StepSubscription /> : <StepSetup />;
}

/** Быстрая настройка, вызванная повторно из настроек: тот же экран галочек, но
    поверх уже настроенного приложения — подписку и правила не трогает. */
export function QuickSetup() {
  return <StepSetup quick />;
}

function Logo() {
  return (
    <div style={{ textAlign: 'center', marginBottom: 26 }}>
      <div className="wordmark" style={{ fontSize: 34, letterSpacing: '0' }}>
        no<span>vpn</span>
      </div>
      <div className="eyebrow" style={{ marginTop: 5 }}>
        доступ без лишних вопросов
      </div>
    </div>
  );
}

function StepSubscription() {
  const { s, checkSubscription, resetSubscription, setOnboardingStep, error } = useStore();
  const [url, setUrl] = useState('');
  const st = s.subscription.status;

  if (st === 'checking') {
    return (
      <div className="viewport onboarding">
        <Logo />
        <div style={{ textAlign: 'center', marginTop: 40 }}>
          <div className="spinner" style={{ margin: '0 auto 14px' }} />
          <div className="t-strong">Проверяем подписку…</div>
        </div>
      </div>
    );
  }

  if (st === 'active') {
    return (
      <div className="viewport onboarding">
        <Logo />
        <div style={{ textAlign: 'center', marginTop: 26 }}>
          <div
            style={{
              width: 46,
              height: 46,
              margin: '0 auto 14px',
              borderRadius: '50%',
              background: 'var(--green-bg)',
              color: 'var(--green-fg)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <IconCheck size={22} />
          </div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Подписка подключена</div>
          <div className="t-meta" style={{ marginTop: 8 }}>
            Доступно серверов: {s.subscription.servers}
          </div>
        </div>
        <button
          className="btn btn-primary btn-lg btn-block"
          style={{ marginTop: 30 }}
          onClick={() => setOnboardingStep(1)}
        >
          Продолжить
        </button>
      </div>
    );
  }

  return (
    <div className="viewport onboarding">
      <Logo />
      <div style={{ fontSize: 19, fontWeight: 700, textAlign: 'center' }}>Подключите вашу подписку</div>
      <div className="t-meta" style={{ textAlign: 'center', marginTop: 8, lineHeight: 1.5 }}>
        Вставьте ссылку, которую вам выдали. Остальное настроится само.
      </div>

      <input
        className="input mono"
        style={{ marginTop: 22 }}
        placeholder="https://..."
        value={url}
        autoFocus
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && url.trim()) checkSubscription(url.trim());
        }}
      />

      {st === 'invalid' ? (
        <div className="notice notice-red" style={{ marginTop: 14 }}>
          {error ?? 'Ссылка не подошла. Проверьте, что скопировали её целиком.'}
        </div>
      ) : null}

      <button
        className="btn btn-primary btn-lg btn-block"
        style={{ marginTop: 14 }}
        disabled={!url.trim()}
        onClick={() => {
          if (st === 'invalid') resetSubscription();
          checkSubscription(url.trim());
        }}
      >
        Продолжить
      </button>
    </div>
  );
}

function StepSetup({ quick = false }: { quick?: boolean }) {
  const { s, finishOnboarding, setOnboardingStep, closeQuickSetup } = useStore();
  // При повторном проходе показываем текущие значения, а не значения по
  // умолчанию — человек видит, как настроено сейчас, и меняет точечно.
  const [prefs, setPrefs] = useState(
    quick
      ? {
          autostart: s.settings.autostart,
          smart: s.smartRouting,
          autoUpdate: s.settings.autoUpdateLists,
          bypassLocal: s.settings.bypassLocal,
        }
      : { autostart: true, smart: true, autoUpdate: true, bypassLocal: false },
  );
  const [apps, setApps] = useState<Record<string, boolean>>(
    Object.fromEntries(
      SUGGESTED.map((a) => [a.id, quick ? (s.apps.find((x) => x.id === a.id)?.enabled ?? true) : true]),
    ),
  );
  // Предлагаем к включению только найденные на машине приложения, которым нужен VPN.
  const found = s.apps.filter((a) => a.found && a.route === 'vpn').slice(0, 8);
  const [useList, setUseList] = useState(
    quick ? (s.lists.find((l) => l.id === 'sites')?.enabled ?? true) : true,
  );

  return (
    <div className="viewport onboarding">
      <h1 className="screen-title">Быстрая настройка</h1>
      <p className="screen-sub">
        {quick
          ? 'Пройдите настройку заново. Подписку и ваши правила это не затронет.'
          : 'Настроим NoVPN под вас. Всё это можно поменять позже.'}
      </p>

      <Check
        on={prefs.autostart}
        onChange={(v) => setPrefs((p) => ({ ...p, autostart: v }))}
        title="Запускать вместе с Windows"
      />
      <Check
        on={prefs.smart}
        onChange={(v) => setPrefs((p) => ({ ...p, smart: v }))}
        title="Использовать умную маршрутизацию"
        note="Через VPN пойдёт только то, чему это нужно"
      />
      <Check
        on={prefs.autoUpdate}
        onChange={(v) => setPrefs((p) => ({ ...p, autoUpdate: v }))}
        title="Обновлять списки автоматически"
      />
      <Check
        on={prefs.bypassLocal}
        onChange={(v) => setPrefs((p) => ({ ...p, bypassLocal: v }))}
        title="Локальная сеть — напрямую"
        note="Роутер, NAS и внутренние сайты в обход VPN. Домашние подсети и так идут напрямую всегда."
      />

      <div className="section-label">Приложения на этом компьютере</div>
      {/* Показываем ТОЛЬКО то, что действительно установлено. Раньше список был
          статичным и всё в нём значилось найденным — человек видел «Android Studio:
          не найден, но включён» и справедливо спрашивал, зачем оно здесь. */}
      {found.length === 0 ? (
        <div className="hint">
          Знакомых приложений не нашли — ничего страшного. Маршруты для программ можно
          добавить позже в разделе «Маршрутизация».
        </div>
      ) : (
        found.map((a) => (
          <Check
            key={a.id}
            on={apps[a.id] ?? false}
            onChange={(v) => setApps((x) => ({ ...x, [a.id]: v }))}
            title={a.name}
            note="Найдено на компьютере"
          />
        ))
      )}

      <div className="section-label">Сайты и сервисы</div>
      <Check
        on={useList}
        onChange={setUseList}
        title="Использовать готовый список недоступных ресурсов"
        note="12 483 правила, обновляется автоматически"
      />

      <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
        <button
          className="btn btn-outline"
          style={{ flex: '0 0 auto' }}
          onClick={() => (quick ? closeQuickSetup() : setOnboardingStep(0))}
        >
          {quick ? 'Отмена' : 'Назад'}
        </button>
        <button
          className="btn btn-primary"
          style={{ flex: 1 }}
          onClick={() =>
            finishOnboarding({
              autostart: prefs.autostart,
              smart: prefs.smart,
              autoUpdateLists: prefs.autoUpdate,
              bypassLocal: prefs.bypassLocal,
              appIds: Object.entries(apps).filter(([, on]) => on).map(([id]) => id),
              useList,
            })
          }
        >
          {quick ? 'Сохранить' : 'Завершить настройку'}
        </button>
      </div>
    </div>
  );
}
