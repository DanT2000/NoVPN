// Ссылка vpn:// для приложения AmneziaVPN — импорт конфига в один тап.
//
// Формат (подтверждён по клиенту Amnezia и сторонним конвертерам):
//   vpn:// + base64url( qCompress(JSON) )
// где qCompress — формат Qt: 4 байта big-endian с размером ИСХОДНЫХ данных,
// далее zlib-deflate.
//
// Внутри JSON главное поле — containers[0].awg.last_config.config: это обычный
// INI-текст .conf, который мы и так генерируем. Остальные поля — метаданные для
// карточки сервера в приложении.
//
// ВАЖНО: vpn:// понимает приложение AmneziaVPN. Отдельное приложение AmneziaWG
// ссылку не принимает — ему нужен файл .conf. Поэтому в интерфейсе даём оба
// варианта, а не подменяем одно другим.

import zlib from 'node:zlib';

export interface AwgLinkInput {
  /** Готовый INI-текст конфигурации (тот же, что отдаём файлом). */
  conf: string;
  /** Хост сервера (домен). */
  host: string;
  /** Порт AmneziaWG. */
  port: number;
  clientIp: string;
  clientPrivKey: string;
  clientPubKey: string;
  serverPubKey: string;
  presharedKey: string;
  /** Название, которое человек увидит в приложении. */
  description: string;
  mtu?: number;
}

/** Qt-совместимое сжатие: 4 байта размера (big-endian) + zlib. */
function qCompress(data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length, 0);
  return Buffer.concat([size, zlib.deflateSync(data, { level: 8 })]);
}

export function buildAmneziaVpnLink(i: AwgLinkInput): string {
  // Параметры обфускации берём из самого конфига — он источник истины.
  const grab = (key: string): string | undefined => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'mi').exec(i.conf);
    return m?.[1]?.trim();
  };

  const lastConfig: Record<string, unknown> = {
    H1: grab('H1'),
    H2: grab('H2'),
    H3: grab('H3'),
    H4: grab('H4'),
    Jc: grab('Jc'),
    Jmin: grab('Jmin'),
    Jmax: grab('Jmax'),
    S1: grab('S1'),
    S2: grab('S2'),
    client_ip: i.clientIp,
    client_priv_key: i.clientPrivKey,
    client_pub_key: i.clientPubKey,
    // Главное поле: приложение поднимает соединение именно из этого INI.
    config: i.conf,
    hostName: i.host,
    mtu: String(i.mtu ?? 1376),
    port: i.port,
    psk_key: i.presharedKey,
    server_pub_key: i.serverPubKey,
  };

  const payload = {
    containers: [
      {
        container: 'amnezia-awg',
        awg: {
          isThirdPartyConfig: true,
          last_config: JSON.stringify(lastConfig),
          port: String(i.port),
          transport_proto: 'udp',
        },
      },
    ],
    defaultContainer: 'amnezia-awg',
    description: i.description,
    hostName: i.host,
  };

  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  return 'vpn://' + qCompress(json).toString('base64url');
}

/**
 * Собрать ссылку прямо из текста .conf — в нём уже есть всё нужное
 * (ключи, endpoint, параметры обфускации). Работает и для ранее выпущенных
 * конфигов, поэтому хранить ссылку отдельно не требуется.
 * Возвращает null, если conf не похож на AmneziaWG.
 */
export function vpnLinkFromConf(conf: string, description: string): string | null {
  if (!conf || !/\[Interface\]/i.test(conf)) return null;
  const g = (key: string): string | undefined => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'mi').exec(conf);
    return m?.[1]?.trim();
  };
  const priv = g('PrivateKey');
  const endpoint = g('Endpoint');
  if (!priv || !endpoint) return null;

  const lastColon = endpoint.lastIndexOf(':');
  const host = lastColon > 0 ? endpoint.slice(0, lastColon) : endpoint;
  const port = lastColon > 0 ? Number(endpoint.slice(lastColon + 1)) : 51820;
  if (!Number.isFinite(port)) return null;

  // PublicKey в секции [Peer] — это ключ СЕРВЕРА.
  const peerPart = conf.split(/\[Peer\]/i)[1] ?? '';
  const srvPub = /^\s*PublicKey\s*=\s*(.+)$/mi.exec(peerPart)?.[1]?.trim() ?? '';

  return buildAmneziaVpnLink({
    conf,
    host,
    port,
    clientIp: (g('Address') ?? '').replace(/\/\d+$/, ''),
    clientPrivKey: priv,
    clientPubKey: '',
    serverPubKey: srvPub,
    presharedKey: g('PresharedKey') ?? '',
    description,
  });
}

/** Разбор ссылки обратно — для проверки в тестах. */
export function parseAmneziaVpnLink(link: string): Record<string, any> {
  const b64 = link.replace(/^vpn:\/\//, '');
  const raw = Buffer.from(b64, 'base64url');
  // Первые 4 байта — размер до сжатия, их пропускаем.
  return JSON.parse(zlib.inflateSync(raw.subarray(4)).toString('utf8'));
}
