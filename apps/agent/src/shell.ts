// Обёртки над командами. Агент НЕ предоставляет браузеру произвольный shell —
// только фиксированные операции драйверов. Здесь общие примитивы.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

export async function run(cmd: string, args: string[], input?: string): Promise<string> {
  const child = pExecFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 });
  if (input != null && child.child.stdin) {
    child.child.stdin.write(input);
    child.child.stdin.end();
  }
  const { stdout } = await child;
  return stdout.toString();
}

/** true, если команда доступна и вернула 0. Для detect/healthcheck. */
export async function ok(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args);
    return true;
  } catch {
    return false;
  }
}

export async function dockerExec(container: string, ...cmd: string[]): Promise<string> {
  return run('docker', ['exec', container, ...cmd]);
}

/** docker exec со stdin (для `sh -c 'echo ... | ...'` без утечки в argv-логи не выходит,
 *  поэтому передаём через stdin, если возможно). */
export async function dockerExecStdin(container: string, input: string, ...cmd: string[]): Promise<string> {
  return run('docker', ['exec', '-i', container, ...cmd], input);
}

export async function dockerCp(container: string, from: string, toLocal: string): Promise<void> {
  await run('docker', ['cp', `${container}:${from}`, toLocal]);
}
export async function dockerCpTo(fromLocal: string, container: string, to: string): Promise<void> {
  await run('docker', ['cp', fromLocal, `${container}:${to}`]);
}
export async function dockerRestart(container: string): Promise<void> {
  await run('docker', ['restart', container]);
}
export async function dockerPs(): Promise<string[]> {
  try {
    const out = await run('docker', ['ps', '--format', '{{.Names}}']);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
