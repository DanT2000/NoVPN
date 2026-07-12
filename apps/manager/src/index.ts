import { config } from './config.js';
import { seedIfEmpty } from './seed.js';
import { createApp } from './app.js';
import { startSyncLoop } from './services/sync.js';
import { startBot } from './services/telegram.js';

seedIfEmpty();

const app = createApp();
app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[NoVPN manager] ${config.appName} слушает :${config.port} (mockAgent=${config.enableMockAgent})`);
  startSyncLoop();
  setTimeout(() => void startBot(), 5000); // поднять Telegram-бота, если включён
});
