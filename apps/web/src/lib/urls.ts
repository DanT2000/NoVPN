// Публичный базовый адрес панели СО СХЕМОЙ. Домен в настройках человек часто
// вводит без https:// («panel.example.ru») — нормализуем здесь, иначе личные
// ссылки и ссылки-подписки получаются битыми («panel.example.ru/k/…» вместо
// «https://panel.example.ru/k/…»). Пустой домен → адрес текущей вкладки.
export function publicBase(domain?: string | null): string {
  const raw = (domain ?? '').trim().replace(/\/+$/, '');
  if (!raw) return typeof window !== 'undefined' ? window.location.origin : '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}
