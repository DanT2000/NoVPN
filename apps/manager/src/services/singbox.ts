// Декомпиляция бинарного sing-box rule-set (.srs) в source JSON через официальную
// команду `sing-box rule-set decompile`. БЕЗ shell: байты пишем во временный файл со
// случайным именем, запускаем spawn с массивом аргументов (никакой интерполяции URL/имён).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const BIN = process.env.SINGBOX_BIN || 'sing-box';

/** Бинарник sing-box недоступен на сервере — SRS обработать нельзя. */
export class SingboxUnavailableError extends Error {
  constructor(message = 'sing-box binary не найден') {
    super(message);
    this.name = 'SingboxUnavailableError';
  }
}

/** Декомпилировать .srs (сырые байты) в source rule-set JSON ({version, rules}).
 *  Бросает SingboxUnavailableError, если бинарник не найден. */
export async function decompileSrs(buffer: Buffer): Promise<string> {
  const dir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const inPath = path.join(dir, `novpn-rs-${id}.srs`);
  const outPath = path.join(dir, `novpn-rs-${id}.json`);
  await fs.promises.writeFile(inPath, buffer);
  try {
    await runSingbox(['rule-set', 'decompile', inPath, '-o', outPath]);
    const json = await fs.promises.readFile(outPath, 'utf8');
    if (!json.trim()) throw new Error('sing-box вернул пустой результат');
    JSON.parse(json); // source rule-set должен быть валидным JSON
    return json;
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

function runSingbox(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      return reject(new SingboxUnavailableError());
    }
    let stderr = '';
    child.on('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'ENOENT' ? new SingboxUnavailableError() : e);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sing-box decompile завершился с кодом ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`));
    });
  });
}
