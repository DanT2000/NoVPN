import { config } from './config.js';
import { seedIfEmpty } from './seed.js';
import { createApp } from './app.js';
import { startSyncLoop } from './services/sync.js';
import { startBot } from './services/telegram.js';

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
  setTimeout(() => void startBot(), 5000); // поднять Telegram-бота, если включён
});
