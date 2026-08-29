import { useEffect, useRef } from 'react';
import { StoreProvider, useStore } from './state/store';
import { applyTheme } from './lib/theme';
import { Titlebar } from './components/Titlebar';
import { TabBar } from './components/TabBar';
import { DevPanel } from './components/DevPanel';
import { Onboarding, QuickSetup } from './screens/Onboarding';
import { Intro } from './screens/Intro';
import { Home } from './screens/Home';
import { Routing } from './screens/Routing';
import { Connection } from './screens/Connection';
import { Settings } from './screens/Settings';
import { onTrayToggle, syncCloseToTray, syncTray } from './lib/tauri';

const ZOOM = { normal: 1, large: 1.12, xlarge: 1.25 };

const LIVE = new Set(['on', 'config-updating', 'config-updated']);

function Shell() {
  const { s, nav, go, connect, disconnect } = useStore();
  const dev = import.meta.env.DEV;
  const live = LIVE.has(s.conn);

  useEffect(() => {
    document.documentElement.style.setProperty('--ui-zoom', String(ZOOM[s.settings.uiScale]));
  }, [s.settings.uiScale]);

  useEffect(() => {
    applyTheme(s.settings.theme);
  }, [s.settings.theme]);

  // Трей отражает состояние: синий значок и «Отключить», серый и «Подключить».
  useEffect(() => {
    void syncTray(live);
  }, [live]);

  useEffect(() => {
    void syncCloseToTray(s.settings.tray);
  }, [s.settings.tray]);

  // Переключение из меню трея. Подписываемся ОДИН раз, а актуальные
  // live/connect/disconnect читаем через ref: иначе слушатель пересоздавался бы
  // на каждый рендер, а асинхронный listen мог утечь мимо cleanup (заглушка
  // снималась раньше, чем резолвился настоящий unlisten) — и клики из трея
  // срабатывали бы разом на нескольких накопленных обработчиках.
  const trayToggle = useRef<() => void>(() => {});
  trayToggle.current = () => (live ? disconnect() : connect());
  useEffect(() => {
    let active = true;
    let stop = () => {};
    void onTrayToggle(() => trayToggle.current()).then((f) => {
      // Успели отписаться до резолва listen — снимаем слушатель сразу.
      if (active) stop = f;
      else f();
    });
    return () => {
      active = false;
      stop();
    };
  }, []);

  // До конца онбординга нижней панели нет: уходить с этого пути некуда,
  // пока подписка не подключена.
  if (!s.onboarded) {
    return (
      <>
        <Titlebar />
        <Onboarding />
        {dev ? <DevPanel /> : null}
      </>
    );
  }

  // Быстрая настройка, вызванная из настроек: показываем поверх приложения,
  // без нижней навигации — это отдельный проход, а не вкладка.
  if (nav.quickSetup) {
    return (
      <>
        <Titlebar />
        <QuickSetup />
        {dev ? <DevPanel /> : null}
      </>
    );
  }

  return (
    <>
      <Titlebar />
      {nav.tab === 'home' ? <Home /> : null}
      {nav.tab === 'routing' ? <Routing /> : null}
      {nav.tab === 'connection' ? <Connection /> : null}
      {nav.tab === 'settings' ? <Settings /> : null}
      <TabBar tab={nav.tab} onGo={go} />
      {/* Первичный мини-гайд — поверх главного экрана, один раз после ввода конфига. */}
      {s.onboarded && !s.introSeen ? <Intro /> : null}
      {dev ? <DevPanel /> : null}
    </>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
