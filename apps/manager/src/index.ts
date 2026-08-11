import { config } from './config.js';
import { seedIfEmpty } from './seed.js';
import { createApp } from './app.js';
import { startSyncLoop } from './services/sync.js';
import { startBot } from './services/telegram.js';

// Панель — долгоживущий сервис управления доступами: одна необработанная ошибка
// в фоновой корутине (бот, синк, таймер) не должна ронять весь процесс и отрубать
// доступ всем пользователям. Логируем и продолжаем работать. Это последний рубеж —
// код всё равно оборачивает known-опасные места в try/catch адресно.
// Логирование не должно само бросать: если запись в БД (источник исходной ошибки)
// снова упадёт, .catch гасит вторичный reject — иначе получился бы runaway-цикл
// unhandledRejection → import → throw → unhandledRejection.
function logCrash(prefix: string, detail: string): void {
  import('./repo.js')
    .then((repo) => repo.addJobError('Панель', `${prefix}: ${detail}`.slice(0, 300)))
    .catch(() => {
      /* даже логирование не должно ронять процесс */
    });
}
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[NoVPN] unhandledRejection:', msg);
  logCrash('Необработанная ошибка', msg);
});
process.on('uncaughtException', (err) => {
  console.error('[NoVPN] uncaughtException:', err instanceof Error ? err.stack || err.message : String(err));
  logCrash('Необработанное исключение', err instanceof Error ? err.message : String(err));
});

// В production секрет подписи сессий не должен быть небезопасным дефолтом: если
// SESSION_SECRET забыли задать, config выводит стабильный секрет из ENCRYPTION_KEY.
// Явно предупреждаем администратора задать SESSION_SECRET.
if (config.isProd && !process.env.SESSION_SECRET) {
  console.warn('[NoVPN] SESSION_SECRET не задан — использую производный ключ. Рекомендуется задать SESSION_SECRET явно.');
}

seedIfEmpty();

const app = createApp();
app.listen(config.port, () => {
  console.log(`[NoVPN] панель слушает :${config.port}`);
  startSyncLoop();
  // Бот запускается best-effort: его сбой не должен помешать старту панели.
  setTimeout(() => {
    startBot().catch((e) => console.error('[NoVPN] startBot:', e instanceof Error ? e.message : e));
  }, 5000);
});
