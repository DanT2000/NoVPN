import type { NextFunction, Request, Response } from 'express';
import { isDefaultAdminPassword } from '../services/adminAuth.js';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.admin) {
    res.status(401).json({ error: { type: 'unauthorized', message: 'Требуется вход администратора.' } });
    return;
  }
  // Пока пароль администратора дефолтный — до его смены пускаем только чтение (GET,
  // чтобы загрузился экран смены) и сам эндпоинт смены пароля. Иначе известный дефолт
  // был бы полноценным бэкдором, даже если UI показал экран смены.
  if (isDefaultAdminPassword() && req.method !== 'GET' && req.path !== '/api/admin/password') {
    res.status(403).json({ error: { type: 'must_change_password', message: 'Сначала задайте новый пароль администратора.' } });
    return;
  }
  next();
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
