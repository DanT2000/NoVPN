import type { NextFunction, Request, Response } from 'express';
import { isDefaultAdminPassword } from '../services/adminAuth.js';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.admin) {
    res.status(401).json({ error: { type: 'unauthorized', message: 'Требуется вход администратора.' } });
    return;
  }
  // Пока пароль администратора дефолтный — до его смены НЕ отдаём ничего, кроме самой
  // смены пароля и bootstrap (он в этом состоянии возвращает пустышку с флагом смены,
  // чтобы UI показал экран смены). Иначе известный дефолт = бэкдор: даже GET /bootstrap
  // отдал бы коды/токены всех пользователей и прокси-пароли. Блокируем и чтение, и запись.
  if (isDefaultAdminPassword() && req.path !== '/api/admin/password' && req.path !== '/api/bootstrap') {
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
