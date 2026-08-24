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
  // Разбор JSON-тела ограничиваем ПО МАРШРУТАМ, а не общим 32mb: иначе любой
  // неаутентифицированный запрос (вход/код/подписка) мог бы прислать 32 МБ, а verify
  // ещё и копировал бы всё тело в строку на КАЖДЫЙ запрос (DoS по памяти).
  // 1) Агент: нужен rawBody для проверки подписи; тело маленькое.
  app.use(
    '/api/agent',
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );
  // 2) Крупные АДМИНСКИЕ тела: загрузка файлов приложений (base64 ≈ 27 МБ) и
  //    восстановление бэкапа (base64 базы). Только за requireAdmin.
  app.use(['/api/admin/apps', '/api/admin/backup'], express.json({ limit: '48mb' }));
  // 3) Всё остальное (включая неаутентифицированные маршруты) — компактный лимит.
  app.use(express.json({ limit: '1mb' }));

  app.use(
    session({
      name: 'novpn.sid',
      store: new SqliteSessionStore(),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      // rolling: продлеваем сессию при КАЖДОМ запросе (touch обновляет expire и в
      // хранилище). Иначе сессия протухала по фиксированному времени от входа и
      // выкидывала админа посреди работы. Теперь активная сессия не истекает.
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        // 'auto': за edge-прокси (trust proxy настроен) cookie получает флаг Secure,
        // когда соединение https — не уходит в открытом виде. COOKIE_SECURE=true
        // форсирует Secure всегда. 'auto' не ломает вход, если прокси не шлёт proto.
        secure: config.cookieSecure || 'auto',
        maxAge: config.sessionTtlHours * 3600 * 1000,
      },
    }),
  );

  // API + health.
  app.use(agentRouter);
  app.use(router);

  // Канал раздачи NoVPN Desktop: /desktop/latest.json (манифест), установщик .exe,
  // ассеты гайда. Статикой из папки desktop/ репозитория. ВАЖНО: до SPA-fallback,
  // иначе /desktop/latest.json проваливался в index.html (отдавался HTML вместо JSON).
  // fallthrough:false → отсутствующий файл = 404, а не HTML главной.
  if (fs.existsSync(config.desktopDir)) {
    app.use(
      '/desktop',
      express.static(config.desktopDir, {
        setHeaders: (res, p) => {
          if (p.endsWith('.json')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
        },
      }),
    );
    // Отсутствующий файл в /desktop → честный 404 (а не HTML главной и не 500).
    app.use('/desktop', (_req, res) => res.status(404).json({ error: { type: 'not_found', message: 'Файл не найден.' } }));
  }

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
