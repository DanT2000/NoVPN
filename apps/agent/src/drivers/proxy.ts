// Драйвер HTTP/SOCKS5 (администраторская функция). Отдельный login/password на
// каждый доступ, без общего логина. Установка proxy-сервиса выполняется отдельно;
// драйвер честно сообщает, если сервис не обнаружен.

import { dockerPs } from '../shell.js';
import type { AccessRef, CreatedAccess, DiscoveredAccess, DriverHealth, ProtocolDriver, TrafficSample } from './types.js';

function make(protocol: 'http' | 'socks5', containerHint: string): ProtocolDriver {
  return {
    protocol,
    async detect() {
      return (await dockerPs()).some((n) => n.includes(containerHint));
    },
    async healthcheck(): Promise<DriverHealth> {
      const installed = (await dockerPs()).some((n) => n.includes(containerHint));
      return { installed, healthy: installed, note: installed ? 'сервис обнаружен' : 'proxy-сервис не установлен' };
    },
    async createAccess(): Promise<CreatedAccess> {
      throw new Error('Выпуск proxy-доступа появится вместе с установкой proxy-сервиса на сервере.');
    },
    async importAccess(): Promise<DiscoveredAccess[]> {
      return [];
    },
    async revokeAccess(_ref: AccessRef): Promise<void> {
      throw new Error('Не реализовано для proxy.');
    },
    async getTraffic(): Promise<TrafficSample[]> {
      return [];
    },
  };
}

export const httpProxyDriver = make('http', '3proxy');
export const socks5Driver = make('socks5', '3proxy');
