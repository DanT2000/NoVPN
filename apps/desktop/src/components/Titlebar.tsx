/* Титульная полоса. Системная рамка отключена — окно должно выглядеть единым
   тёмным блоком.

   Набор кнопок зависит от настройки «Сворачивать в трей»:
   • включена  — одна кнопка, прячет окно в трей;
   • выключена — прятать некуда, поэтому появляется «свернуть», а крестик
     закрывает приложение по-настоящему.

   «Развернуть» нет ни в одном случае: окно ограничено по размеру, и разворот
   визуально ничего не делал. Выход есть всегда — по правой кнопке. */

import { useEffect, useState } from 'react';
import { IconClose, IconMinimize } from './icons';
import { hideWindow, inTauri, minimizeWindow, quitApp } from '../lib/tauri';
import { useStore } from '../state/store';

export function Titlebar() {
  const { s } = useStore();
  const toTray = s.settings.tray;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [menu]);

  return (
    <>
      <div
        className="titlebar"
        data-tauri-drag-region
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <span className="wordmark" data-tauri-drag-region>
          no<span>vpn</span>
        </span>
        <span className="titlebar-spacer" data-tauri-drag-region />

        {inTauri ? (
          <>
            {!toTray ? (
              <button className="winbtn" aria-label="Свернуть" title="Свернуть" onClick={() => void minimizeWindow()}>
                <IconMinimize />
              </button>
            ) : null}
            <button
              className="winbtn winbtn-close"
              aria-label={toTray ? 'Свернуть в трей' : 'Закрыть'}
              title={toTray ? 'Свернуть в трей' : 'Закрыть'}
              onClick={() => void (toTray ? hideWindow() : quitApp())}
            >
              <IconClose size={13} />
            </button>
          </>
        ) : null}
      </div>

      {menu ? (
        <div className="ctxmenu" style={{ left: menu.x, top: menu.y }} role="menu">
          {toTray ? (
            <button role="menuitem" onClick={() => void hideWindow()}>
              Свернуть в трей
            </button>
          ) : (
            <button role="menuitem" onClick={() => void minimizeWindow()}>
              Свернуть
            </button>
          )}
          <button role="menuitem" onClick={() => void quitApp()}>
            Выход
          </button>
        </div>
      ) : null}
    </>
  );
}
