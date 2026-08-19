import { config } from './config.js';
import { seedIfEmpty } from './seed.js';
import { createApp } from './app.js';
import { startSyncLoop } from './services/sync.js';
import { startRoutingSyncLoop } from './services/routingSync.js';
import { startBot, notifyAdmin } from './services/telegram.js';
import * as repo from './repo.js';

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

// Уведомления администратору об ошибках фоновых задач в его Telegram (если задан
// adminTelegramChatId и включено). Через хук, чтобы repo не зависел от telegram.
repo.setJobErrorHook((e) => {
  if (e.level !== 'error') return;
  if (repo.getSettings().notifyErrors === false) return;
  void notifyAdmin(`⚠️ ${repo.brandName()}: ошибка\n\n${e.server}: ${e.text}`, { key: `err:${e.server}:${e.text}`.slice(0, 80) }).catch(() => {});
});

// Одноразово шифруем открытые .conf в БД (AmneziaWG приватный ключ). Идемпотентно.
try {
  const n = repo.migrateEncryptConfs();
  if (n) console.log(`[NoVPN] зашифровано .conf в покое: ${n}`);
} catch (e) {
  console.error('[NoVPN] шифрование conf:', e instanceof Error ? e.message : e);
}

// Каталог файлов приложений + чистка осиротевших файлов (без ссылок в каталоге).
import('./services/appFiles.js')
  .then((af) => {
    const removed = af.cleanupOrphans();
    if (removed) console.log(`[NoVPN] удалено осиротевших файлов приложений: ${removed}`);
  })
  .catch((e) => console.error('[NoVPN] чистка файлов приложений:', e instanceof Error ? e.message : e));

const app = createApp();
app.listen(config.port, () => {
  console.log(`[NoVPN] панель слушает :${config.port}`);
  startSyncLoop();
  startRoutingSyncLoop();
  // Бот запускается best-effort: его сбой не должен помешать старту панели.
  setTimeout(() => {
    startBot().catch((e) => console.error('[NoVPN] startBot:', e instanceof Error ? e.message : e));
  }, 5000);
});
