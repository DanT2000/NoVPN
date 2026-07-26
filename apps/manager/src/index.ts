import { config } from './config.js';
import { seedIfEmpty } from './seed.js';
import { createApp } from './app.js';
import { startSyncLoop } from './services/sync.js';
import { startBot } from './services/telegram.js';

seedIfEmpty();

const app = createApp();
app.listen(config.port, () => {
  console.log(`[NoVPN] панель слушает :${config.port}`);
  startSyncLoop();
  setTimeout(() => void startBot(), 5000); // поднять Telegram-бота, если включён
});
