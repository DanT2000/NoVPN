import express from 'express';
import session from 'express-session';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { router } from './routes.js';
import { agentRouter } from './routes/agent.js';

export function createApp() {
  const app = express();
  // За edge-прокси (openresty), который терминирует TLS. trust proxy + cookie
  // secure:'auto' — чтобы session-cookie всегда ставился и получал флаг Secure,
  // когда прокси сообщает https (иначе secure:true не ставит cookie за прокси).
  app.set('trust proxy', true);
  // Сохраняем «сырое» тело для проверки подписи агента.
  // Лимит 64mb: логотип/файлы клиентов админ загружает как data URL (хранятся в БД).
  app.use(
    express.json({
      limit: '64mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  app.use(
    session({
      name: 'novpn.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        maxAge: config.sessionTtlHours * 3600 * 1000,
      },
    }),
  );

  // API + health.
  app.use(agentRouter);
  app.use(router);

  // Статика собранного фронтенда (в проде) + SPA-fallback.
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path === '/healthz') return next();
      res.sendFile(path.join(config.webDist, 'index.html'));
    });
  }

  return app;
}
