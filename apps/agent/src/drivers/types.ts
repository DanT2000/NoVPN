// Единый интерфейс драйвера протокола. Каждый протокол реализует его.
// Операции идемпотентны: повтор с тем же ref не создаёт дубликат.

export interface AccessRef {
  /** Xray: uuid; AmneziaWG: publicKey; proxy: login. */
  id: string;
  extra?: Record<string, string>;
}

export interface CreatedAccess {
  ref: AccessRef;
  /** Xray — vless-ссылка. */
  link?: string;
  /** AmneziaWG — текст .conf. */
  conf?: string;
  /** Технические поля для хранения (ключи и т.п.). */
  meta?: Record<string, string>;
}

export interface DiscoveredAccess {
  ref: AccessRef;
  /** Идентификатор для сопоставления с БД панели. */
  matchKey: string;
  note?: string;
}

export interface TrafficSample {
  ref: AccessRef;
  receivedBytes: number | null;
  sentBytes: number | null;
  lastHandshakeAt: string | null;
  /** false — статистика по этому конфигу недоступна («Мониторинг недоступен»). */
  available: boolean;
}

export interface DriverHealth {
  installed: boolean;
  healthy: boolean;
  note: string;
}

export interface ProtocolDriver {
  readonly protocol: 'xray' | 'amneziawg' | 'http' | 'socks5';
  detect(): Promise<boolean>;
  healthcheck(): Promise<DriverHealth>;
  createAccess(deviceName: string): Promise<CreatedAccess>;
  /** Обнаружить существующие (legacy) доступы без изменения конфигурации. */
  importAccess(): Promise<DiscoveredAccess[]>;
  revokeAccess(ref: AccessRef): Promise<void>;
  /** enable/disable — для протоколов, где это отличается от revoke. */
  enableAccess?(ref: AccessRef): Promise<void>;
  disableAccess?(ref: AccessRef): Promise<void>;
  rotateAccess?(ref: AccessRef, deviceName: string): Promise<CreatedAccess>;
  getTraffic(): Promise<TrafficSample[]>;
  exportConfig?(ref: AccessRef): Promise<string>;
}
