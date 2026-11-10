// Доменные типы NoVPN. Формы совместимы с mock-адаптером фронтенда
// и со схемой backend/API. ISO-строки для дат, id — строки.

import type {
  AgentConnectivity,
  ConfigSource,
  DeviceStatus,
  EndpointReachability,
  JobState,
  ManagementLevel,
  Protocol,
  ProxyType,
  ResetPolicy,
  ServiceHealth,
  TelegramMode,
  UserProtocol,
} from './enums.js';

/** Публичные порты endpoint'а (часть Endpoint Profile, хранится по домену и
 *  переживает удаление физического сервера). */
export interface ServerPorts {
  xray: number;
  awg: number;
  http: number;
  socks: number;
  https: number;
}

export interface LegacyPort {
  proto: keyof ServerPorts;
  port: number;
  /** На какой актуальный порт редиректит iptables-алиас (для корректного снятия и
   *  пере-указания при повторной смене порта — REDIRECT не цепочечный). */
  target: number;
  since: string;
}

/** Прежняя маска Reality, которую сервер ещё принимает после смены (переходный период). */
export interface LegacyMask {
  sni: string;
  since: string;
}

/** Самопроверка установки сервера (после установки и по кнопке «Проверить установку»). */
export interface InstallCheckResult {
  at: string;
  ok: boolean;
  /** «Xray ✓, AmneziaWG ✗ (нет интерфейса awg0)». */
  summary: string;
  /** Ошибка установки, если она оборвалась. */
  error?: string | null;
  checks: Array<{ key: string; name: string; ok: boolean; detail: string }>;
}

export interface Server {
  id: string;
  name: string;
  country: string | null;
  host: string;
  /** Публичные порты компонентов (дефолты 443/51820/8080/1080/8443, если не менялись). */
  ports?: ServerPorts;
  /** Старые порты, оставленные для совместимости с ранее выданными конфигами. */
  legacyPorts?: LegacyPort[];
  /** Маска Reality (сайт, под который сервер маскируется) и прежние маски, которые
   *  ещё принимаются, пока приложения не обновили подписку. */
  realityMask?: { sni: string | null; legacy: LegacyMask[] };
  /** Итог последней установки/самопроверки: что реально работает на сервере. */
  installCheck?: InstallCheckResult | null;
  /** Физический сервер отвязан: endpoint (домен/порты/ключи/конфиги) сохранён, SSH нет. */
  detached?: boolean;
  /** SSH-вход по ключу настроен (пароль отключён после hardening). */
  sshKeyAuth?: boolean;
  /** Свой значок сервера (эмодзи, напр. 🏠). Если задан — показывается в подписке
   *  вместо флага страны. Пусто = флаг из country. */
  flagEmoji?: string | null;
  /** Агент подключён к панели. */
  agent: AgentConnectivity;
  /** Публичный VPN-endpoint доступен снаружи. */
  endpointOk: boolean;
  /** Здоровье VPN-службы (детальный сигнал). */
  serviceHealth?: ServiceHealth;
  endpointReachability?: EndpointReachability;
  protocols: Protocol[];
  trafficGb: number;
  users: number;
  autoIssue: boolean;
  lastSyncAt: string | null;
  recommended: boolean;
  /** Версия установленного агента. */
  agentVersion?: string | null;
  /** Сводка маршрутизации этого сервера — чтобы режим был виден на карточке, а не
   *  только внутри формы «Изменить». Подробности правит EndpointConfigPanel. */
  routing?: ServerRoutingSummary;
  /** Тест скорости на сервере (OpenSpeedTest в Docker). null/нет — не установлен. */
  speedtest?: ServerSpeedtest | null;
  /** Защита SSH (включает владелец сервера, по умолчанию выключена). null/нет — не включалась. */
  sshGuard?: ServerSshGuard | null;
  /** Самотесты сервера (его собственный канал до узла Speedtest), новые первыми, до 10. */
  selfTests?: ServerSelfTest[];
}

/** Результат самотеста: сервер сам мерил свой канал, независимо от канала админа. */
export interface ServerSelfTest {
  at: string;
  downloadMbps: number;
  uploadMbps: number;
  pingMs: number | null;
  /** Узел, до которого мерили (город, оператор). */
  server: string | null;
  isp: string | null;
  /** Чем мерили: cloudflare (свой многопоточный тест) — или старые ookla / speedtest-cli. */
  tool: string;
  url?: string | null;
  /** Загрузка процессора сервера во время фазы скачивания, %. ≥90 — упёрлись в CPU, а не в сеть. */
  cpuPct?: number | null;
  /** Расшифровка: сколько дал каждый источник и коды ответов. */
  note?: string | null;
}

/** Защита SSH: блокировка подбора пароля (fail2ban + лимиты sshd) и, по желанию, вход по
 *  SSH только с перечисленных адресов. Адрес панели разрешён всегда и не блокируется. */
export interface ServerSshGuard {
  bruteforce: boolean;
  /** IPv4-адреса или подсети (CIDR), с которых можно входить по SSH. Пусто = с любых. */
  allow: string[];
  /** С какого адреса заходит сама панель (сервер видит его в SSH-соединении). */
  panelIp?: string | null;
  appliedAt: string;
}

/** Тест скорости на сервере: меряет реальный канал между браузером админа и сервером. */
export interface ServerSpeedtest {
  port: number;
  /** IPv4-адреса или подсети (CIDR), которым открыт доступ к странице теста. Пусто = закрыт для всех. */
  allow: string[];
  installedAt: string;
}

/** Режим одного профиля в подписке. `smart` — умная маршрутизация: список AutoRoute
 *  (что не работает в России) идёт в VPN, всё остальное — напрямую. `full` — полный
 *  туннель, весь трафик в VPN без исключений. */
export type ServerRoutingMode = 'smart' | 'full';

/** Какие профили выдаёт сервер:
 *  - `both` — умный профиль первым (рекомендуемый) и «Полный VPN» вторым;
 *  - `full` — только полный туннель;
 *  - `smart` — только умный профиль, полного человек не получает вовсе.
 *  Пер-пользовательских запретов нет намеренно: на сервере ничего не блокируется,
 *  а лишний трафик — это лимиты самого человека. */
export type ServerRoutingProfiles = 'both' | 'full' | 'smart';

/** Направление умного профиля. `match-vpn` (основной): список → VPN, остальное
 *  напрямую. `match-direct` (унаследованный «обход белых списков»): список →
 *  напрямую, остальное в VPN. */
export type SmartDirection = 'match-vpn' | 'match-direct';

/** Откуда умный профиль берёт список. `autoroute` — опубликованная сборка AutoRoute;
 *  `local` — только свой список сервера (или встроенный RU-список в match-direct). */
export type SmartSourceKind = 'autoroute' | 'local';

export interface ServerRoutingSummary {
  /** Оставлено для совместимости: 'full' если сервер выдаёт ТОЛЬКО полный профиль. */
  mode: ServerRoutingMode;
  profiles: ServerRoutingProfiles;
  direction: SmartDirection;
  source: SmartSourceKind;
  lanAccess: boolean;
  /** null = разрешены все доступные запасные каналы. */
  fallbackTypes: ('https' | 'http' | 'socks')[] | null;
  /** Сколько доменов задано ИМЕННО у этого сервера (дополняют основной список). */
  ownExceptions: number;
  /** Через сколько ЧАСОВ подключение в полном режиме само вернётся на умный.
   *  0 — не возвращать. Дробные допустимы: 0.5 — полчаса.
   *
   *  Исполняет это ПРИЛОЖЕНИЕ NoVPN, а не сервер: сервер лишь отдаёт два конфига и
   *  не знает, каким из них человек пользуется. Чужие клиенты (Happ, v2rayNG) поле
   *  игнорируют — там переключение остаётся ручным. */
  fullTimeoutHours: number;
}

export interface User {
  id: string;
  name: string;
  comment: string;
  category: string | null;
  tags: string[];
  /** Шестизначный пользовательский код. Устаревший способ входа: работает
   *  только у тех, кому он был разрешён при переходе на ссылки, и только до
   *  codeLoginUntil. Остаётся как идентификатор в Telegram-боте. */
  code: string;
  /** Токен личной ссылки: <публичный-адрес>/k/<accessToken>. Основной способ входа. */
  accessToken: string | null;
  /** До какого момента этому пользователю разрешён вход по коду.
   *  null = нельзя (так у всех, кого завели после перехода на ссылки). */
  codeLoginUntil: string | null;
  deviceLimit: number | null;
  expiresAt: string | null;
  trafficLimitGb: number | null;
  trafficUsedGb: number;
  /** Трафик уже удалённых конфигов, списанный на пользователя (входит в trafficUsedGb).
   *  Показываем отдельно, иначе непонятно, куда делась разница с суммой живых конфигов. */
  retiredTrafficGb?: number;
  /** Расход за последние 30 дней по почасовому учёту (появляется по мере накопления). */
  traffic30Gb?: number;
  resetPolicy: ResetPolicy;
  allowedServers: string[];
  allowedProtocols: UserProtocol[];
  /** Типы прокси, которые пользователь может себе выдать в кабинете (если они
   *  установлены на сервере). Пусто — прокси недоступны. */
  allowedProxies: ProxyType[];
  isActive: boolean;
  /** Приоритетный доступ: вместе с обычной подпиской пользователь получает общий
   *  резервный пул NoVPN (внешние подписки админа) как аварийный маршрут. */
  priorityAccess: boolean;
  /** «Полный доступ (без защиты)»: сервер не режет этому человеку российские сервисы
   *  (исключение из «Российские сервисы мимо серверов»), а полный профиль он получает в
   *  любом приложении, не только в NoVPN. Для экстренных случаев. */
  fullAccess?: boolean;
  /** «Только приложение NoVPN»: Amnezia и прокси не выдаются, чужие приложения (Happ,
   *  v2rayNG…) получают по подписке только сообщение «подключайтесь через NoVPN». */
  appOnly?: boolean;
  /** Расход за текущий и прошлый календарный месяц (UTC), ГБ — из помесячного учёта. */
  trafficMonthGb?: number;
  trafficPrevMonthGb?: number;
  telegram: string | null;
  createdAt: string;
  lastActivityAt: string | null;
}

/** Правила группы: что группа задаёт своим участникам. Поля нет — группа его не трогает,
 *  у каждого остаётся своё. Применяются кнопкой «Применить ко всем в группе» и
 *  подставляются в форму, когда человека заводят в группу или переводят в неё. */
export interface GroupRules {
  allowedServers?: string[];
  allowedProtocols?: Array<'xray' | 'amneziawg'>;
  allowedProxies?: ProxyType[];
  priorityAccess?: boolean;
  fullAccess?: boolean;
  appOnly?: boolean;
  deviceLimit?: number | null;
  trafficLimitGb?: number | null;
  resetPolicy?: ResetPolicy;
}

/** Группа людей (прежняя «категория» пользователя). */
export interface UserGroup {
  name: string;
  rules: GroupRules;
  /** Участников (не удалённых). */
  members: number;
}

/** Предпросмотр «Применить ко всем»: что изменится у каждого участника. */
export interface GroupApplyPreview {
  people: Array<{
    userId: string;
    name: string;
    /** Что поменяется — по-человечески: «серверы», «полный доступ: вкл»… */
    changes: string[];
    /** Сколько выданных конфигов снимется (вне новых серверов/протоколов). */
    revokeConfigs: number;
  }>;
}

/** Объявление администратора для приложений: NoVPN показывает его один раз окном, Happ —
 *  в шапке подписки. Приходит с панели, поэтому доходит и без работающего VPN. */
export interface Announcement {
  id: string;
  text: string;
  /** all — всем; android / windows — приложению NoVPN на этой платформе; happ — Happ. */
  audience: 'all' | 'android' | 'windows' | 'happ';
  /** Только версиям NoVPN ниже этой (для android / windows), иначе null. */
  belowVersion: string | null;
  /** Кнопка «Обновить» в окне. */
  update: boolean;
  createdAt: string;
  expiresAt: string | null;
}

export interface AnnouncementInput {
  text: string;
  audience: Announcement['audience'];
  belowVersion?: string | null;
  update?: boolean;
  /** Сколько дней показывать; null — пока не уберут. */
  days?: number | null;
}

/** Приложение, которое забирает подписку человека: по HWID (Happ и др. шлют x-hwid),
 *  иначе по User-Agent. Адреса не храним. */
export interface SubClient {
  app: string;
  ua: string | null;
  hwid: string | null;
  model: string | null;
  os: string | null;
  firstSeen: string;
  lastSeen: string;
  hits: number;
}

/** Внешняя резервная подписка (сторонний провайдер) — аварийный пул. */
export interface BackupSubscription {
  id: string;
  /** null — общий пул администратора; иначе id пользователя-владельца (личная резервная подписка). */
  ownerUserId: string | null;
  title: string;
  url: string;
  /** User-Agent для запроса к провайдеру (пусто — дефолтный). */
  userAgent: string | null;
  /** HWID, если провайдер его требует. */
  hwid: string | null;
  enabled: boolean;
  /** Корзина: 'whitelist' — обход белых списков; 'outage' — аварийный (наш сервер лёг). */
  kind: 'whitelist' | 'outage';
  /** Порядок перебора (меньше — раньше). Безлимитные/дешёвые выше, лимитные — в конец. */
  sort: number;
  /** Кому доступна: 'all' — всем с доступом к резерву; 'priority' — только приоритетным. */
  availableFor: 'all' | 'priority';
  /** Собственный месячный лимит ПОДПИСКИ, ГБ (лимит провайдера; null = без лимита). */
  limitGb: number | null;
  /** Статистика самой внешней подписки (из заголовка Subscription-Userinfo). */
  provider: {
    upload: number | null;
    download: number | null;
    total: number | null;
    /** unix-секунды. */
    expire: number | null;
  };
  format: string | null;
  serverCount: number;
  lastFetchedAt: string | null;
  lastError: string | null;
  /** Наш внутренний расход по этой подписке (сумма по пользователям), байт. */
  internalBytes: number;
  createdAt: string;
  updatedAt: string;
}

/** Один сервер, разобранный из резервной подписки. */
export interface BackupServer {
  id: string;
  subscriptionId: string;
  name: string;
  host: string;
  port: number;
  protocol: string;
  enabled: boolean;
}

export interface Device {
  id: string;
  userId: string | null;
  /** Ссылка vpn:// для приложения AmneziaVPN (импорт в один тап).
   *  Только у AmneziaWG-устройств; отдельное приложение AmneziaWG её не понимает. */
  vpnKey?: string | null;
  name: string;
  serverId: string;
  protocol: Protocol;
  isActive: boolean;
  lastSeenAt: string | null;
  trafficGb: number;
  createdAt: string;
  /** Подсказка ОС: только заявленная пользователем/платформой, не угаданная. */
  osHint: string | null;
  /** Источник и уровень управления — для импортированных/legacy записей. */
  source?: ConfigSource;
  managementLevel?: ManagementLevel;
  /** Вычисляемый статус для отображения. */
  status?: DeviceStatus;
  /** Мониторинг трафика/активности реально доступен по этому конфигу. */
  monitoringAvailable?: boolean;
  /** Сохранённый конфиг устройства (для повторного просмотра). */
  link?: string | null;
  conf?: string | null;
}

export type AppPlatform = 'Android' | 'iOS' | 'Windows' | 'macOS' | 'Linux';

/** Один клиент на конкретной платформе: ссылка и/или загруженный файл. */
export interface AppPlatformEntry {
  platform: AppPlatform;
  /** Ссылка (стор/сайт/прямая) для этой платформы. */
  url?: string | null;
  /** Загруженный файл (data URL) — устаревшее, для мелких файлов. Крупные
   *  инсталляторы теперь на диске (downloadName/downloadSize), см. ниже. */
  file?: string | null;
  /** Имя файла на диске (постоянный том appsDir). Скачивается по адресу
   *  /apps/file/<appId>/<platform> — стримом, без раздувания базы. */
  downloadName?: string | null;
  /** Размер файла в байтах (для подписи «Скачать · 64 МБ»). */
  downloadSize?: number | null;
}

/** Клиент-приложение: одна карточка на все платформы, ссылки/файлы — по платформам. */
export interface AppClient {
  id: string;
  client: string;
  /** С какими форматами совместим: xray | amneziawg | amnezia-app (vpn://). */
  compat: Array<'xray' | 'amneziawg' | 'amnezia-app'>;
  /** Офиц. сайт клиента (общий). */
  source: string;
  instruction: string;
  enabled: boolean;
  /** Иконка клиента (data URL). */
  icon?: string | null;
  /** Схема «добавить подписку одним нажатием»: к ней дописывается ссылка
   *  подписки. Заполняется только для ПОДТВЕРЖДЁННЫХ схем — иначе кнопка
   *  молча не сработает и человек решит, что сломана подписка. */
  urlScheme?: string | null;
  /** Платформы, на которых доступен клиент, со ссылками/файлами. */
  platforms: AppPlatformEntry[];
}

export interface TelegramSettings {
  enabled: boolean;
  /** Токен наружу не возвращается — только маска. */
  tokenMasked: string | null;
  mode: TelegramMode;
  proxyOn: boolean;
  /** Источник прокси: взять адрес выбранного сервера или указать вручную. */
  proxySource?: 'server' | 'manual';
  /** Устарело: один сервер. Читается, если proxyServerIds пуст. */
  proxyServerId?: string | null;
  /** Серверы-прокси по порядку: не отвечает один — бот берёт следующий. */
  proxyServerIds?: string[];
  proxyType: ProxyType;
  proxyHost: string;
  proxyPort: string;
  proxyLogin: string;
  /** Пароль прокси наружу не возвращается. */
  proxyPassSet?: boolean;
  template: string;
  status: 'running' | 'stopped' | 'error';
  linkedUserIds: string[];
  /** @username бота (узнаётся автоматически) — для ссылки-привязки. */
  botUsername?: string | null;
}

export interface AppSettings {
  domain: string;
  defaultServerId: string | null;
  defaultProtocols: UserProtocol[];
  messageTemplate: string;
  codeAttempts: number;
  codeCooldownMin: number;
  /** Автоотключение неактивных устройств: если устройство не выходило на связь
   *  дольше N дней — отключаем его. 0 = не отключать. */
  inactiveDisableDays: number;
  /** Через сколько дней автоматически отключать вход по коду у пользователя,
   *  которому его включили. 0 = не отключать. По умолчанию 15. */
  codeLoginDays: number;
  /** Продвинутый режим X-Ray: подписка отдаётся как полный конфиг с обходом
   *  «белых списков» (RU-домены напрямую) и аварийным фоллбэком Xray→прокси.
   *  По умолчанию ВКЛ. Выключение → обычная подписка (только ссылки, без обхода).
   *  Отсутствие поля трактуется как ВКЛ (для уже созданных панелей). */
  xrayWhitelist: boolean;
  /** Редактируемый из админки список доменов обхода (по строке на домен: «ya.ru»
   *  или «domain:ya.ru»/«full:go.yandex»). Пусто/отсутствует → встроенный дефолт
   *  RU_WHITELIST_ROUTES. Меняется без пересборки/деплоя — новый /full сразу с ним. */
  whitelistDomains?: string[];
  /** Имя бренда/сервиса: метка каждого конфига в клиенте (#<бренд>-устройство) и
   *  Profile-Title подписки. Задаётся автором один раз, отдельно от имени сервера
   *  (флаг+название). Пусто/отсутствует → фолбэк на APP_NAME (по умолчанию «NoVPN»). */
  brandName?: string;
  /** Доступ клиента в локальную сеть сервера (private ranges) через туннель. По
   *  умолчанию ВЫКЛ (LAN идёт напрямую/мимо, как и было). Включают для self-host
   *  дома, когда нужен доступ к домашним устройствам через VPN. */
  lanAccess?: boolean;
  /** Российские сервисы мимо серверов: зарубежный сервер не выпускает соединения к
   *  российским адресам и сервисам (Xray — правило geoip:ru + имена, AmneziaWG —
   *  nftables). Тогда российское приложение, которому достался полный туннель, не видит
   *  адрес сервера и не может его сдать. Умный режим не задевает: там они и так напрямую.
   *  По умолчанию ВЫКЛ; домашний сервер (🏠/RU) не получает никогда. */
  ruGuard?: boolean;
  /** Чужие приложения (Happ, v2rayTun, Streisand…) получают в подписке только «умный»
   *  профиль; «Полный VPN» — лишь приложению NoVPN (оно забирает подписку под User-Agent
   *  `v2rayNG/1.9.5` и сверяет профили с meta.json). Сервер, у которого есть только полный
   *  режим (домашний), не трогается. Отсутствие поля = ВКЛ. */
  thirdPartySmartOnly?: boolean;
  /** Telegram-ID администратора (узнаётся командой /id у бота). На него бот шлёт
   *  уведомления об ошибках и ежедневную сводку. Управление панелью — только в вебе. */
  adminTelegramChatId?: string;
  /** Слать администратору уведомления об ошибках фоновых задач (по умолчанию ВКЛ,
   *  если задан adminTelegramChatId). */
  notifyErrors?: boolean;
  /** Слать администратору ежедневную сводку (трафик/пользователи/ошибки). По умолчанию
   *  ВКЛ, если задан adminTelegramChatId. */
  dailyDigest?: boolean;
  /** Ссылки на расширение для браузера (страница «Скачать»). Пусто → кнопка «скоро».
   *  У каждого браузера своя ссылка; Edge/Яндекс при пустом поле наследуют Chrome-ссылку
   *  (одно и то же расширение из Chrome Web Store ставится во все Chromium-браузеры). */
  extChromeUrl?: string;
  extEdgeUrl?: string;
  extYandexUrl?: string;
  extFirefoxUrl?: string;
  /** Обновление панели. Панель работает Docker-образом, который собирает CI из GitHub,
   *  поэтому «подменить себя» нельзя — по кнопке «Обновить» она шлёт POST на этот хук,
   *  а CI забирает свежий код и перезапускает контейнер. Пусто → кнопка недоступна. */
  updateHookUrl?: string;
  /** Токен для хука (уходит как Bearer), если CI его требует. */
  updateHookToken?: string;
  /** Настраиваемые лимиты РЕЗЕРВНОЙ маршрутизации. Две отдельные КОРЗИНЫ — обход
   *  «белых списков» (whitelist) и аварийные серверы, когда наш сервер лёг (outage) —
   *  с РАЗДЕЛЬНЫМИ МЕСЯЧНЫМИ лимитами, отдельно для приоритетных и обычных. У лимита
   *  null = безлимит. Пусто/отсутствует → дефолты (RESERVE_DEFAULTS): приоритетным обе
   *  корзины безлимитно; обычным обход вкл (5 ГБ/мес) и аварийный вкл (10 ГБ/мес).
   *  Всё меняется вручную в «Дополнительных настройках» — ничего не захардкожено. */
  reserve?: ReserveLimits;
}

/** Лимиты резерва по корзинам и уровням доступа. Месяц — календарный (сброс 1-го числа). */
export interface ReserveLimits {
  /** Доступен ли обычным пользователям обход белых списков. */
  whitelistForRegular: boolean;
  /** Доступны ли обычным пользователям аварийные серверы. */
  outageForRegular: boolean;
  /** Месячный лимит корзины, ГБ. null = безлимит. */
  whitelistRegularGb: number | null;
  outageRegularGb: number | null;
  whitelistPriorityGb: number | null;
  outagePriorityGb: number | null;
}

/** Дефолты лимитов резерва (когда settings.reserve не задан). Приоритетным — обе корзины
 *  безлимитно; обычным обе включены с месячными лимитами. Владелец меняет всё в админке. */
export const RESERVE_DEFAULTS: ReserveLimits = {
  whitelistForRegular: true,
  outageForRegular: true,
  whitelistRegularGb: 5,
  outageRegularGb: 10,
  whitelistPriorityGb: null,
  outagePriorityGb: null,
};

// ── Умная маршрутизация (Smart Routing) — управляемые JSON-файлы для NoVPN Desktop ──
// Каждый файл может управляться локально ИЛИ зеркалить внешний URL.
// Публичные URL панели неизменны: /routing/<name>.json.
//
// `sites` убран окончательно (решение владельца, подтверждено трижды): список сайтов —
// локальная настройка пользователя в NoVPN Desktop (в т.ч. одним кликом из расширения),
// с панелью не синхронизируется. Клиент при 404 держит last-known-good и не ломается.
export type RoutingFileName = 'upstream' | 'apps';
export type RoutingMode = 'local' | 'mirror';
/** Состояние последней проверки внешнего источника. */
export type RoutingSyncStatus = 'idle' | 'ok' | 'nochange' | 'error' | 'rejected';
/** Формат внешнего источника (определяется по расширению URL). LST/TXT → построчный
 *  список → JSON {items}; SRS → бинарный sing-box rule-set → decompile → source JSON. */
export type RoutingSourceFormat = 'json' | 'lst' | 'txt' | 'srs';

/** Статистика конвертации источника (для LST/TXT — построчная; json/srs — только формат). */
export interface RoutingSourceStats {
  format: RoutingSourceFormat;
  lines?: number; // строк получено
  valid?: number; // валидных элементов (прошли проверку, до дедупа)
  skipped?: number; // пропущено (пустые/комментарии/невалидные)
  dups?: number; // дубликатов удалено
}

export interface RoutingFileMeta {
  name: RoutingFileName;
  version: number;
  updatedAt: string; // ISO
  size: number; // байт (UTF-8) текущего сохранённого содержимого
  valid: boolean; // сохранённое всегда валидно (на всякий случай флаг)
  rootType: 'array' | 'object' | 'other' | null;
  /** Число элементов, если структуру можно нормально определить, иначе null (§11). */
  entryCount: number | null;
  // источник (режим зеркала)
  mode: RoutingMode;
  sourceUrl: string;
  sourceFormat: RoutingSourceFormat; // определён по расширению sourceUrl
  autoSync: boolean;
  intervalHours: number; // фиксировано 1
  lastCheckAt: string | null;
  lastOkAt: string | null;
  status: RoutingSyncStatus;
  statusReason: string; // человекочитаемая причина (ошибка/отклонение/итог)
  lastAdded: number | null;
  lastRemoved: number | null;
  sourceStats: RoutingSourceStats | null; // статистика последней применённой конвертации
}

export interface RoutingFileFull extends RoutingFileMeta {
  content: string; // ровно сохранённый JSON-текст (то, что отдаёт публичный URL)
}

export interface RoutingSourcePatch {
  mode?: RoutingMode;
  sourceUrl?: string;
  autoSync?: boolean;
}

/** Результат ручной проверки «Проверить сейчас» (ничего не публикует). */
export interface RoutingCheckResult {
  ok: boolean; // запрос+валидация прошли
  changed: boolean; // содержимое отличается от сохранённого
  status: RoutingSyncStatus;
  reason: string;
  count: number | null;
  added: number | null;
  removed: number | null;
  /** Формат/статистика конвертации источника этой проверки. */
  stats?: RoutingSourceStats;
  /** Новое содержимое (уже канонический JSON) для «Открыть в редакторе» (если ok && changed). */
  content?: string;
}

// ── AutoRoute: сборка Upstream из многих источников ──────────────────────────
// Upstream перестал быть «одним файлом с редактором»: это скомпилированный датасет.
// Много источников → нормализация → слияние по приоритету → версия. Публичный
// /routing/upstream.json продолжает отдавать привычный {items:[...]}, поэтому уже
// выданные клиенты ничего не замечают.
//
// dataset вынесен отдельным полем (сейчас всегда 'upstream'): позже появятся
// именованные датасеты (Default / Aggressive / KZ) без переделки схемы.

/** Что означает попадание в список. Направление («в VPN» или «мимо») выбирается
 *  на сервере режимом Smart Routing; здесь — намерение самого источника. */
export type RoutingAction = 'vpn' | 'direct' | 'block';

/** Вид правила в нормализованном виде (совпадает с префиксами Xray routing). */
export type RoutingRuleKind = 'domain' | 'full' | 'keyword' | 'regexp' | 'ip';

/** 'auto' — определить по расширению URL (как раньше). */
export type AutoRouteSourceFormat = RoutingSourceFormat | 'auto';

export interface AutoRouteSource {
  id: string;
  dataset: string;
  title: string;
  url: string;
  format: AutoRouteSourceFormat;
  /** Формат, который реально применился в последней проверке (auto → разрешённый). */
  resolvedFormat: RoutingSourceFormat | null;
  action: RoutingAction;
  enabled: boolean;
  /** Меньше = выше в списке = приоритетнее при конфликте. Хранится плотным 0..N-1. */
  priority: number;
  lastCheckAt: string | null;
  lastOkAt: string | null;
  status: RoutingSyncStatus;
  statusReason: string;
  /** Сколько правил дал источник в последнем успешном разборе (last-known-good). */
  ruleCount: number | null;
  stats: RoutingSourceStats | null;
}

export interface AutoRouteSourceInput {
  title: string;
  url: string;
  format?: AutoRouteSourceFormat;
  action?: RoutingAction;
  enabled?: boolean;
}

export interface AutoRouteSourcePatch extends Partial<AutoRouteSourceInput> {
  priority?: number;
}

/** Вклад одного источника в конкретную сборку. */
export interface AutoRouteBuildSource {
  sourceId: string;
  title: string;
  rules: number; // сколько правил дал
  won: number; // сколько попало в итог (не перебито приоритетнее)
  conflicts: number; // сколько перебито более приоритетным с ДРУГИМ действием
}

export interface AutoRouteBuild {
  version: number;
  builtAt: string;
  sha256: string;
  domains: number;
  ips: number;
  added: number;
  removed: number;
  conflicts: number;
  sourcesChanged: number;
  sources: AutoRouteBuildSource[];
  /** true — именно эта версия сейчас опубликована на /routing/upstream.json. */
  published: boolean;
}

/** Один конфликт: значение пришло из нескольких источников с разным действием. */
export interface AutoRouteConflict {
  kind: RoutingRuleKind;
  value: string;
  winner: { sourceId: string; title: string; action: RoutingAction };
  losers: { sourceId: string; title: string; action: RoutingAction }[];
}

export interface AutoRouteState {
  dataset: string;
  sources: AutoRouteSource[];
  builds: AutoRouteBuild[];
  /** Версия, опубликованная на публичном URL (null — ещё ни разу не собирали). */
  publishedVersion: number | null;
  publicUrl: string;
  /** Публичные DAT-файлы (формат V2Ray/Xray geosite/geoip, тег `novpn`). */
  dat: { geosite: string; geoip: string };
  /** Сколько правил из опубликованной сборки реально зашивается в подписку Xray
   *  (есть потолок — телефонный конфиг не должен раздуваться до мегабайт). */
  subscription: { rules: number; cap: number; truncated: boolean };
}

/** Результат поиска по опубликованной сборке: откуда пришло правило и почему победило. */
export interface AutoRouteSearchHit {
  kind: RoutingRuleKind;
  value: string;
  action: RoutingAction;
  sourceId: string;
  sourceTitle: string;
  priority: number;
}

/** Итог одной пересборки. */
export interface AutoRouteBuildResult {
  ok: boolean;
  reason: string;
  build: AutoRouteBuild | null;
  conflicts: AutoRouteConflict[];
}

export interface LogEntry {
  at: string;
  text: string;
}

export interface JobError {
  at: string;
  server: string;
  text: string;
  /** Уровень записи журнала: 'error' | 'warn' | 'info'. Старые записи — без поля (error). */
  level?: 'error' | 'warn' | 'info';
}

export interface Job {
  id: string;
  serverId: string;
  type: string;
  state: JobState;
  progress: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

/** Точка подключения прокси конкретного типа (для показа пользователю). */
export interface ProxyEndpoint {
  type: ProxyType;
  host: string;
  port: number;
}

/** Прокси-аккаунт пользователя на сервере: один уникальный логин/пароль,
 *  распространяется на установленные на сервере типы прокси, разрешённые
 *  пользователю. Пароль виден владельцу в кабинете (в отличие от VPN он нужен
 *  для подключения). */
export interface ProxyAccount {
  id: string;
  userId: string | null;
  serverId: string;
  serverName: string;
  serverHost: string;
  login: string;
  /** Пароль — отдаётся владельцу/админу для подключения (у прокси иначе никак). */
  password: string;
  /** Готовые точки подключения (host:port) по каждому доступному типу. */
  endpoints: ProxyEndpoint[];
  /** Суммарный трафик (ГБ) из логов 3proxy. */
  trafficGb: number;
  /** Когда через прокси последний раз шёл трафик. */
  lastSeenAt: string | null;
  isActive: boolean;
  createdAt: string;
}

/** Ответ /api/bootstrap — всё, что нужно ПАНЕЛИ АДМИНА при старте. Только для админа:
 *  содержит коды доступа всех пользователей и конфиги всех устройств. */
/** Самотест изоляции базы: переживёт ли она переустановку/редеплой. */
export interface DbHealth {
  /** Путь к файлу базы внутри приложения. */
  dbPath: string;
  /** Приложение запущено в контейнере (Docker и т.п.). */
  container: boolean;
  /** Подтверждено, что база пережила хотя бы одно пересоздание контейнера
   *  (или содержит данные старше текущего процесса) → том постоянный. */
  confirmedPersistent: boolean;
  /** ОПАСНО: контейнер + персистентность не подтверждена → возможно, редеплой
   *  сотрёт данные. На свежей установке подтвердится после первого обновления. */
  risky: boolean;
}

export interface BootstrapData {
  users: User[];
  devices: Device[];
  servers: Server[];
  apps: AppClient[];
  telegram: TelegramSettings;
  settings: AppSettings;
  adminLog: LogEntry[];
  jobErrors: JobError[];
  history: Record<string, LogEntry[]>;
  /** Самотест изоляции базы (для предупреждения при первом запуске). */
  dbHealth: DbHealth;
  /** Пароль администратора всё ещё дефолтный — панель обязана потребовать смену
   *  до любых действий (переживает перезагрузку страницы, не только вход). */
  mustChangePassword: boolean;
  /** Группы людей с правилами (1.7.0). Старые панели поле не шлют. */
  groups?: UserGroup[];
}

/** Сервер глазами обычного пользователя: куда подключаться, без внутренней телеметрии. */
export interface PublicServerView {
  id: string;
  name: string;
  country: string | null;
  /** Свой значок сервера (эмодзи). Показывается ВМЕСТЕ с флагом страны (🏠🇫🇮). */
  flagEmoji: string | null;
  host: string;
  protocols: Protocol[];
  recommended: boolean;
  /** Сервер доступен для выпуска конфига. */
  online: boolean;
  /** Пер-серверная ссылка-подписка Xray (/sub/<t>/server/<id>/full) со СВОИМ обходом
   *  и политикой этого сервера. null, если сервер не разрешён пользователю / не xray /
   *  отвязан / нет входа. Общий subLink (все серверы, один обход) — в PublicBootstrapData. */
  subLink: string | null;
}

