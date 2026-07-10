import type { NextFunction, Request, Response } from 'express';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.admin) {
    next();
    return;
  }
  res.status(401).json({ error: { type: 'unauthorized', message: 'Требуется вход администратора.' } });
}
