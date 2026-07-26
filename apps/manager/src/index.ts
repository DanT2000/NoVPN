import { config } from './config.js';
import { seedIfEmpty } from './seed.js';
import { createApp } from './app.js';
import { startSyncLoop } from './services/sync.js';
import { startBot } from './services/telegram.js';

// В production секрет подписи сессий обязателен — иначе панель поднялась бы на
// известном дефолтном значении, и сессии можно было бы подделать.
if (config.isProd && (!process.env.SESSION_SECRET || config.sessionSecret === 'dev-insecure-session-secret-change-me')) {
  throw new Error('SESSION_SECRET не задан — обязателен в production (см. .env.example)');
}

seedIfEmpty();

const app = createApp();
app.listen(config.port, () => {
  console.log(`[NoVPN] панель слушает :${config.port}`);
  startSyncLoop();
  setTimeout(() => void startBot(), 5000); // поднять Telegram-бота, если включён
});
