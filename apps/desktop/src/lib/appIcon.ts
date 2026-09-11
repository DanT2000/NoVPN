/* Иконки приложений из встроенного пака (src/assets/appicons). Это собственные
   значки проекта, на которые ссылается data/apps.json полем icon ("icons/vscode.png").
   Раньше пак лежал в presets/, но во фронтенд не подключался — рисовалась буква.
   Теперь показываем настоящий значок. Работает офлайн, без сети. */

// Vite соберёт все иконки и отдаст их URL'ы (один разбор на весь пак).
const APP_ICONS = import.meta.glob('../assets/appicons/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** URL значка по ссылке из apps.json (например "icons/discord.png") или id. */
export function appIconUrl(icon?: string | null): string | undefined {
  if (!icon) return undefined;
  const file = icon.split('/').pop();
  if (!file) return undefined;
  const name = file.endsWith('.png') ? file : `${file}.png`;
  return APP_ICONS[`../assets/appicons/${name}`];
}
