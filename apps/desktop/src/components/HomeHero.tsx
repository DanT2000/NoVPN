/* Главный герой домашнего экрана: глобус-фон и большая круглая кнопка с нашим
   логотипом. Кнопка — основной переключатель: клик подключает или отключает VPN.
   Цвет кнопки говорит о состоянии: серый — выключено, синий — умный режим,
   зелёный — полный VPN, янтарный — подключаемся, красный — ошибка/нет интернета.
   Глобус приходит двумя картинками (светлая/тёмная тема) и растворяется по краям,
   переходя в фон приложения. */

import { useStore, effectiveSmart } from '../state/store';
import globeDark from '../assets/globe-dark.png';
import globeLight from '../assets/globe-light.png';

type Tone = 'grey' | 'blue' | 'green' | 'amber' | 'red';

const TONE: Record<Tone, { a: string; b: string }> = {
  grey: { a: '#8b93a1', b: '#5b6472' },
  blue: { a: '#4f93ff', b: '#1d4ed8' },
  green: { a: '#34d27f', b: '#15803d' },
  amber: { a: '#f7b23b', b: '#d97706' },
  red: { a: '#f6664f', b: '#b91c1c' },
};

function Shield({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        fill="#fff"
        d="M12,2L4,5.5v6.2c0,4.6 3.4,8.9 8,10.3c4.6,-1.4 8,-5.7 8,-10.3V5.5L12,2zM12,4.2l6,2.6v4.9c0,3.5 -2.5,6.9 -6,8.1c-3.5,-1.2 -6,-4.6 -6,-8.1V6.8L12,4.2z"
      />
      <path fill="#fff" d="M8.7,8h1.9l3,4.6V8h1.7v8h-1.9l-3,-4.6V16H8.7z" />
    </svg>
  );
}

export function HomeHero() {
  const { s, connect, disconnect, reconnecting, noInternet } = useStore();
  const conn = s.conn;
  const live = conn === 'on' || conn === 'config-updated' || conn === 'config-updating';
  const connecting = conn === 'connecting' || reconnecting;
  const bad = conn === 'error' || conn === 'sub-invalid';
  const smart = effectiveSmart(s);

  const tone: Tone = noInternet || bad ? 'red' : connecting ? 'amber' : live ? (smart ? 'blue' : 'green') : 'grey';
  const { a, b } = TONE[tone];
  const busy = conn === 'sub-invalid';

  const label = live ? 'Отключить' : connecting ? 'Идёт подключение' : 'Подключить';

  return (
    <div className="hero">
      <img className="hero-globe hero-globe-dark" src={globeDark} alt="" aria-hidden draggable={false} />
      <img className="hero-globe hero-globe-light" src={globeLight} alt="" aria-hidden draggable={false} />
      <button
        type="button"
        className={`hero-btn${connecting ? ' hero-btn-pulse' : ''}`}
        onClick={() => (live || connecting ? disconnect() : connect())}
        disabled={busy}
        aria-label={label}
        title={label}
        style={{
          background: `radial-gradient(120% 120% at 50% 22%, ${a} 0%, ${b} 78%)`,
          boxShadow: `0 0 0 1px rgba(255,255,255,0.14) inset, 0 10px 26px ${b}59, 0 0 46px ${a}55`,
        }}
      >
        <Shield size={70} />
      </button>
    </div>
  );
}
