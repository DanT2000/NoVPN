// A11 — Логи. Ошибки фоновых задач (с объяснением) + журнал действий администратора.

import type { JobError } from '@novpn/shared';
import { useApp } from '../store/AppStore';
import { Panel, ScreenHeader, Loading } from '../components/ui';
import { rel } from '../lib/format';

// Человеческое объяснение частых ошибок: по подстроке в тексте.
function explain(text: string): string | null {
  const t = text.toLowerCase();
  if (t.includes('ssh') || t.includes('authentication') || t.includes('auth fail')) return 'Панель не смогла зайти на сервер по SSH. Проверьте host, порт, логин и пароль/ключ в карточке сервера.';
  if (t.includes('timeout') || t.includes('timed out') || t.includes('etimedout')) return 'Сервер не ответил вовремя (сеть/нагрузка/файрвол). Обычно проходит само; если повторяется — проверьте доступность сервера.';
  if (t.includes('certbot') || t.includes('lets') || t.includes('acme') || t.includes('https')) return 'Не удалось выпустить TLS-сертификат для HTTPS-прокси. Нужен домен (не IP), указывающий на сервер, и свободный порт 80.';
  if (t.includes('quota') || t.includes('квот')) return 'Ошибка в обработке квоты трафика — пиры/логины снимаются или возвращаются в следующем цикле синхронизации.';
  if (t.includes('econnrefused') || t.includes('refused')) return 'Соединение отклонено — служба на сервере не запущена или порт закрыт файрволом.';
  if (t.includes('xray') || t.includes('server.json')) return 'Проблема с конфигом Xray на сервере. Панель самоисцеляет дубли при следующем выпуске; при повторе — переустановите ПО на сервере.';
  return null;
}

const LEVEL: Record<string, { color: string; label: string }> = {
  error: { color: 'var(--red-fg)', label: 'ошибка' },
  warn: { color: 'var(--amber-fg)', label: 'предупр.' },
  info: { color: 'var(--text-muted-2)', label: 'инфо' },
};

export function Logs() {
  const { data, loading, loadError } = useApp();
  if (loadError) return <div className="notice notice-red">{loadError}</div>;
  if (loading || !data) return <Loading text="Загружаем логи…" />;

  const errors: JobError[] = data.jobErrors ?? [];
  const log = data.adminLog ?? [];

  return (
    <>
      <ScreenHeader eyebrow="Журнал" title="Логи" />
      <div className="stack" style={{ gap: 16 }}>
        <Panel title={`Ошибки и события задач (${errors.length})`}>
          {errors.length === 0 ? (
            <div className="small muted">Ошибок нет — все фоновые задачи проходят чисто. ✅</div>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {errors.map((e, i) => {
                const lvl = LEVEL[e.level ?? 'error'] ?? LEVEL.error!;
                const why = explain(e.text);
                return (
                  <div key={`${e.at}-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingBottom: 10, borderBottom: '1px solid var(--border-inner)' }}>
                    <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: lvl.color, textTransform: 'uppercase' }}>{lvl.label}</span>
                      <span className="small mono muted">{e.server} · {rel(e.at)}</span>
                    </div>
                    <span className="small" style={{ wordBreak: 'break-word' }}>{e.text}</span>
                    {why ? <span className="small muted">💡 {why}</span> : null}
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="Журнал действий">
          {log.length === 0 ? (
            <div className="small muted">Пока нет событий.</div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {log.map((l, i) => (
                <div key={`${l.at}-${i}`} className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                  <span className="small mono muted" style={{ flex: 'none', minWidth: 92 }}>{rel(l.at)}</span>
                  <span className="small">{l.text}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
