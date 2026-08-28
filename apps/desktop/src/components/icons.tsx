/* Иконки — инлайновый SVG, без внешних зависимостей: приложение должно
   рисоваться целиком офлайн. Все с единым штрихом 1.6 и размером 20. */

interface P {
  size?: number;
  className?: string;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const IconHome = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M4 10.5 12 4l8 6.5" />
    <path d="M6 9.8V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.8" />
  </svg>
);

/** Развилка — тот же образ, что и на главном экране. */
export const IconRouting = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M12 20v-6" />
    <path d="M12 14c0-3 -5-3 -5-6V5" />
    <path d="M12 14c0-3 5-3 5-6V5" />
    <circle cx="7" cy="4" r="1.4" />
    <circle cx="17" cy="4" r="1.4" />
  </svg>
);

export const IconConnection = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="8" />
    <path d="M4 12h16" />
    <path d="M12 4c2.2 2.4 3.3 5.1 3.3 8s-1.1 5.6-3.3 8c-2.2-2.4-3.3-5.1-3.3-8S9.8 6.4 12 4Z" />
  </svg>
);

export const IconSettings = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
  </svg>
);

/** Прямой путь — стрелка вниз без преград. */
export const IconStraight = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M12 4v14" />
    <path d="M7.5 13.5 12 18l4.5-4.5" />
  </svg>
);

/** Путь через VPN — щит. */
export const IconShield = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M12 3.5 5 6.4v5c0 4.2 2.8 7.4 7 9.1 4.2-1.7 7-4.9 7-9.1v-5L12 3.5Z" />
  </svg>
);

export const IconCheck = ({ size = 14 }: P) => (
  <svg {...base(size)} strokeWidth={2.4}>
    <path d="M4 12.5 9.5 18 20 6.5" />
  </svg>
);

export const IconChevron = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);

export const IconPlus = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconRefresh = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M20 11a8 8 0 1 0-.7 4.3" />
    <path d="M20 5v6h-6" />
  </svg>
);

export const IconTrash = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
  </svg>
);

export const IconMinimize = ({ size = 12 }: P) => (
  <svg {...base(size)} strokeWidth={1.4}>
    <path d="M4 12h16" />
  </svg>
);

export const IconMaximize = ({ size = 11 }: P) => (
  <svg {...base(size)} strokeWidth={1.6}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </svg>
);

export const IconClose = ({ size = 12 }: P) => (
  <svg {...base(size)} strokeWidth={1.7}>
    <path d="M5 5l14 14M19 5L5 19" />
  </svg>
);
