/* Нижняя панель — вся навигация приложения. Четыре раздела, больше не нужно:
   «Приложения» живут внутри маршрутизации, отдельным пунктом они бы
   дублировали сами себя. */

import { IconConnection, IconHome, IconRouting, IconSettings } from './icons';
import type { Tab } from '../state/types';

const TABS: { id: Tab; label: string; Icon: (p: { size?: number }) => JSX.Element }[] = [
  { id: 'home', label: 'Главная', Icon: IconHome },
  { id: 'routing', label: 'Маршрутизация', Icon: IconRouting },
  { id: 'connection', label: 'Подключение', Icon: IconConnection },
  { id: 'settings', label: 'Настройки', Icon: IconSettings },
];

export function TabBar({ tab, onGo }: { tab: Tab; onGo: (t: Tab) => void }) {
  return (
    <nav className="tabbar" aria-label="Разделы">
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          className="tab"
          aria-current={tab === id ? 'page' : undefined}
          onClick={() => onGo(id)}
        >
          <Icon size={19} />
          <span className="tab-label">{label}</span>
        </button>
      ))}
    </nav>
  );
}
