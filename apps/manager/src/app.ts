import express from 'express';
import session from 'express-session';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { router } from './routes.js';
import { agentRouter } from './routes/agent.js';
import { SqliteSessionStore } from './services/sessionStore.js';

export function createApp() {
  const app = express();
  // За edge-прокси (openresty → traefik), который терминирует TLS. trust proxy +
  // cookie secure:'auto' — чтобы session-cookie всегда ставился и получал флаг
  // Secure, когда прокси сообщает https (иначе secure:true не ставит cookie за прокси).
  //
  // ЧИСЛО, А НЕ true: `trust proxy: true` доверяет ЛЮБОМУ X-Forwarded-For, и тогда
  // req.ip — это то, что прислал клиент. Любой лимит по IP при этом обходится
  // подстановкой нового адреса в заголовок на каждый запрос. Число = сколько
  // прокси перед нами (openresty + traefik = 2): Express возьмёт адрес, который
  // подставил наш прокси, а не тот, что придумал клиент.
  app.set('trust proxy', config.trustProxyHops);
  // Сохраняем «сырое» тело для проверки подписи агента. Лимит 16mb: покрывает
  // иконки приложений (data URL) и восстановление бэкапа (base64 базы); при этом
  // ограничивает объём тела на неаутентифицированных маршрутах (защита от DoS).
  app.use(
    express.json({
      limit: '16mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  app.use(
    session({
      name: 'novpn.sid',
      store: new SqliteSessionStore(),
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

  // Единый обработчик ошибок: битый JSON / слишком большое тело отдаём в том же
  // формате {error}, а не HTML со стеком, и не шумим стеком в логах.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const e = err as { type?: string; status?: number } | null;
    if (e?.type === 'entity.parse.failed')
      return res.status(400).json({ error: { type: 'validation', message: 'Некорректный JSON в запросе.' } });
    if (e?.type === 'entity.too.large')
      return res.status(413).json({ error: { type: 'validation', message: 'Слишком большой запрос.' } });
    if (!err) return next();
    res.status(500).json({ error: { type: 'server', message: 'Внутренняя ошибка сервера.' } });
  });

  return app;
}
