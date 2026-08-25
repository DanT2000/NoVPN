// Нормализация домена как ключа server_keys. Без зависимостей — импортируется и из
// repo, и из keyvault (иначе цикл импортов repo ↔ keyvault).
// ВСЕ обращения к server_keys (ключи, порты, legacy, endpoint-config) обязаны идти через
// domainKey(): иначе один и тот же сервер при неканоничном host (регистр, порт, схема)
// расщеплялся бы на две строки — ключи в одной, порты/настройки в другой, и при
// восстановлении брались бы DEFAULT_PORTS → выданные AWG-конфиги отваливались.
export function domainKey(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[:/].*$/, '');
}
