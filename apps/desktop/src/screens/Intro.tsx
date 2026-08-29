/* Первичный мини-гайд по главному экрану. Показывается ОДИН раз — сразу после
   того, как человек ввёл конфиг и попал в приложение. Задача простая: за пару
   экранов показать, что где, и не мешать дальше. Флаг introSeen хранится в
   состоянии, поэтому второй раз не всплывёт. */

import { useState } from 'react';
import { useStore } from '../state/store';

interface Step {
  title: string;
  body: string;
}

export function Intro() {
  const { dismissIntro, fullAvailable } = useStore();
  const [i, setI] = useState(0);

  const steps: Step[] = [
    {
      title: 'Готово — вы подключены',
      body: 'Конфиг принят, всё настроено. Покажу за пару шагов, что где на главном экране, — это быстро.',
    },
    {
      title: 'Кнопка внизу',
      body: '«Запустить» поднимает VPN, «Отключить» (красная) — выключает. Над кнопкой видно состояние и к какому серверу вы подключены.',
    },
    {
      title: 'Умная маршрутизация',
      body: fullAvailable
        ? 'Включена по умолчанию: через VPN идёт только то, что не открывается в России, остальное — напрямую. Так быстрее и экономнее по трафику. Тумблером можно выключить — тогда весь трафик пойдёт через VPN (полный режим). Полный режим сам вернётся на умный, если это задал администратор сервера.'
        : 'Включена по умолчанию: через VPN идёт только то, что не открывается в России, остальное — напрямую. Так быстрее и экономнее по трафику.',
    },
    {
      title: 'Режим и вкладки',
      body: '«Прокси» защищает браузеры, «TUN + программы» — ещё и приложения (Discord, Telegram). Внизу вкладки: маршрутизация (что идёт через VPN), подключение и настройки.',
    },
  ];

  const last = i === steps.length - 1;
  const step = steps[i]!;

  return (
    <div className="scrim" style={{ zIndex: 80 }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Знакомство с приложением">
        <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.015em' }}>{step.title}</div>
        <div className="body" style={{ marginTop: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {step.body}
        </div>

        <div className="row-between" style={{ marginTop: 20, alignItems: 'center' }}>
          <div style={{ display: 'inline-flex', gap: 6 }}>
            {steps.map((_, k) => (
              <span
                key={k}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: k === i ? 'var(--accent, #3b82f6)' : 'var(--border-input)',
                }}
              />
            ))}
          </div>
          <div style={{ display: 'inline-flex', gap: 8 }}>
            {!last ? (
              <button className="btn btn-secondary btn-sm" onClick={dismissIntro}>
                Пропустить
              </button>
            ) : null}
            <button className="btn btn-primary btn-sm" onClick={() => (last ? dismissIntro() : setI(i + 1))}>
              {last ? 'Понятно' : 'Далее'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
