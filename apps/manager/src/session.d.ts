import 'express-session';

declare module 'express-session' {
  interface SessionData {
    admin?: boolean;
    // Пользователь, вошедший по 6-значному коду. Устройства и конфиги отдаются
    // только владельцу — id из тела запроса больше не является удостоверением.
    userId?: string;
  }
}
