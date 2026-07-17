import type { NextFunction, Request, Response } from 'express';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.admin) {
    next();
    return;
  }
  res.status(401).json({ error: { type: 'unauthorized', message: 'Требуется вход администратора.' } });
}

// Публичные операции над устройствами: либо пользователь, вошедший по коду,
// либо админ (он делает то же самое за пользователя из панели).
export function requireUserOrAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.userId || req.session?.admin) {
    next();
    return;
  }
  res.status(401).json({ error: { type: 'unauthorized', message: 'Введите код доступа.' } });
}
