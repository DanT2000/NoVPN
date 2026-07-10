import express from 'express';
import session from 'express-session';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { router } from './routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  app.use(
    session({
      name: 'novpn.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProd,
        maxAge: config.sessionTtlHours * 3600 * 1000,
      },
    }),
  );

  // API + health.
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
