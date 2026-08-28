// Сериализация базы AutoRoute в формат V2Ray/Xray geosite.dat / geoip.dat.
//
// Это protobuf (см. v2fly/v2ray-core app/router/config.proto), без зависимостей:
// кодируем varint + length-delimited поля руками, схема крошечная.
//
//   GeoSiteList { repeated GeoSite entry = 1 }
//   GeoSite     { string country_code = 1; repeated Domain domain = 2 }
//   Domain      { Type type = 1; string value = 2 }   Type: Plain=0 Regex=1 Domain=2 Full=3
//   GeoIPList   { repeated GeoIP entry = 1 }
//   GeoIP       { string country_code = 1; repeated CIDR cidr = 2 }
//   CIDR        { bytes ip = 1; uint32 prefix = 2 }
//
// Тег внутри файла — `novpn` (в правилах Xray: geosite:novpn / geoip:novpn).
// Декодер здесь же — только для тестов, чтобы проверять байты, а не верить кодеру.

import type { RoutingRuleKind } from '@novpn/shared';

export const GEO_TAG = 'novpn';

const DOMAIN_TYPE: Record<Exclude<RoutingRuleKind, 'ip'>, number> = { keyword: 0, regexp: 1, domain: 2, full: 3 };

function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}
/** Поле-строка/сообщение: tag (field<<3|2) + длина + байты. */
function ld(field: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
}
function vi(field: number, value: number): Buffer {
  return Buffer.concat([varint((field << 3) | 0), varint(value)]);
}

export interface GeoDomain {
  kind: Exclude<RoutingRuleKind, 'ip'>;
  value: string;
}

/** geosite.dat с одним тегом. Порядок доменов сохраняется — детерминированные байты. */
export function encodeGeoSite(domains: GeoDomain[], tag = GEO_TAG): Buffer {
  const parts: Buffer[] = [ld(1, Buffer.from(tag.toUpperCase(), 'utf8'))];
  for (const d of domains) {
    const type = DOMAIN_TYPE[d.kind];
    // type=0 (Plain) — protobuf default, поле опускается; кодируем явно только ненулевой.
    const msg = Buffer.concat([...(type ? [vi(1, type)] : []), ld(2, Buffer.from(d.value, 'utf8'))]);
    parts.push(ld(2, msg));
  }
  return ld(1, Buffer.concat(parts));
}

function parseIp(s: string): { ip: Buffer; prefix: number } | null {
  const [addr, maskRaw] = s.split('/');
  if (!addr) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
    const oct = addr.split('.').map(Number);
    if (oct.some((o) => o > 255)) return null;
    const prefix = maskRaw == null ? 32 : Number(maskRaw);
    if (!(prefix >= 0 && prefix <= 32)) return null;
    return { ip: Buffer.from(oct), prefix };
  }
  if (addr.includes(':')) {
    const prefix = maskRaw == null ? 128 : Number(maskRaw);
    if (!(prefix >= 0 && prefix <= 128)) return null;
    const ip = parseIpv6(addr);
    return ip ? { ip, prefix } : null;
  }
  return null;
}
function parseIpv6(s: string): Buffer | null {
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.writeUInt16BE(parseInt(g, 16), i * 2);
  }
  return out;
}

/** geoip.dat с одним тегом. Невалидные CIDR молча пропускаются (валидация — на входе). */
export function encodeGeoIp(cidrs: string[], tag = GEO_TAG): Buffer {
  const parts: Buffer[] = [ld(1, Buffer.from(tag.toUpperCase(), 'utf8'))];
  for (const c of cidrs) {
    const p = parseIp(c);
    if (!p) continue;
    parts.push(ld(2, Buffer.concat([ld(1, p.ip), vi(2, p.prefix)])));
  }
  return ld(1, Buffer.concat(parts));
}

// ── декодер (для тестов) ──────────────────────────────────────────────────────

function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[pos++]!;
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [result >>> 0, pos];
    shift += 7;
  }
}
function fields(buf: Buffer): Array<{ field: number; value: Buffer | number }> {
  const out: Array<{ field: number; value: Buffer | number }> = [];
  let pos = 0;
  while (pos < buf.length) {
    let key: number;
    [key, pos] = readVarint(buf, pos);
    const field = key >>> 3;
    const wt = key & 7;
    if (wt === 0) {
      let v: number;
      [v, pos] = readVarint(buf, pos);
      out.push({ field, value: v });
    } else if (wt === 2) {
      let len: number;
      [len, pos] = readVarint(buf, pos);
      out.push({ field, value: buf.subarray(pos, pos + len) });
      pos += len;
    } else {
      throw new Error(`неподдерживаемый wire type ${wt}`);
    }
  }
  return out;
}

export function decodeGeoSite(buf: Buffer): Array<{ tag: string; domains: Array<{ type: number; value: string }> }> {
  return fields(buf)
    .filter((f) => f.field === 1)
    .map((entry) => {
      let tag = '';
      const domains: Array<{ type: number; value: string }> = [];
      for (const f of fields(entry.value as Buffer)) {
        if (f.field === 1) tag = (f.value as Buffer).toString('utf8');
        if (f.field === 2) {
          let type = 0;
          let value = '';
          for (const d of fields(f.value as Buffer)) {
            if (d.field === 1) type = d.value as number;
            if (d.field === 2) value = (d.value as Buffer).toString('utf8');
          }
          domains.push({ type, value });
        }
      }
      return { tag, domains };
    });
}

export function decodeGeoIp(buf: Buffer): Array<{ tag: string; cidrs: Array<{ ip: Buffer; prefix: number }> }> {
  return fields(buf)
    .filter((f) => f.field === 1)
    .map((entry) => {
      let tag = '';
      const cidrs: Array<{ ip: Buffer; prefix: number }> = [];
      for (const f of fields(entry.value as Buffer)) {
        if (f.field === 1) tag = (f.value as Buffer).toString('utf8');
        if (f.field === 2) {
          let ip: Buffer = Buffer.alloc(0);
          let prefix = 0;
          for (const c of fields(f.value as Buffer)) {
            if (c.field === 1) ip = c.value as Buffer;
            if (c.field === 2) prefix = c.value as number;
          }
          cidrs.push({ ip, prefix });
        }
      }
      return { tag, cidrs };
    });
}
