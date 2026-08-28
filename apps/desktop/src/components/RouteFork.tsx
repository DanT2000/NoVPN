/* Развилка маршрутов — главный визуальный элемент приложения.
   Показывает единственное, что человеку нужно понять про NoVPN: трафик
   расходится на два пути.

   Первый вариант был абстрактным — две линии и кружки, и по нему не читалось,
   что происходит. Теперь оба пути названы и показаны карточками, а по живому
   пути бегут точки: видно не только «куда», но и «идёт ли». Когда умная
   маршрутизация выключена, прямого пути нет вовсе, и его карточка гаснет. */

import { IconShield, IconStraight } from './icons';
import type { ConnState } from '../state/types';

const OK = new Set<ConnState>(['on', 'config-updating', 'config-updated']);
const BAD = new Set<ConnState>(['error', 'no-internet', 'sub-invalid']);

function tone(conn: ConnState): 'on' | 'wait' | 'bad' | 'off' {
  if (OK.has(conn)) return 'on';
  if (conn === 'connecting') return 'wait';
  if (BAD.has(conn)) return 'bad';
  return 'off';
}

const D_LEFT = 'M150 2 C 150 22, 74 14, 74 34';
const D_RIGHT = 'M150 2 C 150 22, 226 14, 226 34';

export function RouteFork({
  conn,
  smart,
  vpnLabel,
  directLabel,
}: {
  conn: ConnState;
  smart: boolean;
  vpnLabel: string;
  directLabel: string;
}) {
  const t = tone(conn);
  const directOff = !smart;
  const flowing = t === 'on' || t === 'wait';

  return (
    <div className={`routes routes-${t}${directOff ? ' routes-nodirect' : ''}`}>
      <div className="routes-source">Ваш трафик</div>

      <svg className="routes-link" viewBox="0 0 300 36" aria-hidden>
        <path className="rl rl-direct" d={D_LEFT} />
        <path id="rl-vpn-path" className="rl rl-vpn" d={D_RIGHT} />
        {flowing
          ? [0, 0.55, 1.1].map((delay) => (
              <circle key={delay} className="rl-dot" r="2.6">
                <animateMotion dur="1.65s" begin={`${delay}s`} repeatCount="indefinite" path={D_RIGHT} />
              </circle>
            ))
          : null}
      </svg>

      <div className="routes-cards">
        <div className="rcard rcard-direct">
          <span className="rcard-icon">
            <IconStraight size={19} />
          </span>
          <span className="rcard-title">Напрямую</span>
          <span className="rcard-note">{directOff ? 'выключено' : directLabel}</span>
        </div>

        <div className="rcard rcard-vpn">
          <span className="rcard-icon">
            <IconShield size={19} />
          </span>
          <span className="rcard-title">Через VPN</span>
          <span className="rcard-note">{vpnLabel}</span>
        </div>
      </div>
    </div>
  );
}
