/* Что показывать про браузер: цвет плашки и куда вести за расширением.
   САМ СПИСОК больше не выдумываем — установленные браузеры отдаёт оболочка
   (команда browsers_installed, реестр StartMenuInternet). Раньше здесь стояла
   заглушка, где Chrome, Edge и Яндекс всегда числились найденными: владелец
   справедливо возмутился, что «найден Яндекс», которого у него нет. */

export interface BrowserLook {
  color: string;
  /** Страница расширения в магазине. Пусто — там его ещё нет, ставится вручную. */
  store: string;
}

export const BROWSER_LOOK: Record<string, BrowserLook> = {
  chrome: { color: '#4285F4', store: '' },
  edge: { color: '#0F8FE9', store: '' },
  yandex: { color: '#FC3F1D', store: '' },
  firefox: { color: '#FF7139', store: '' },
  opera: { color: '#FF1B2D', store: '' },
  brave: { color: '#FB542B', store: '' },
  vivaldi: { color: '#EF3939', store: '' },
};

export const lookOf = (id: string): BrowserLook => BROWSER_LOOK[id] ?? { color: '#8a94a6', store: '' };
