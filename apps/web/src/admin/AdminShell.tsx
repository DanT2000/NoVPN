import { useApp } from '../store/AppStore';
import type { AdminRoute } from '../store/AppStore';
import { Wordmark } from '../components/ui';
import { AdminLogin } from './AdminLogin';
import { ForcePasswordChange } from './ForcePasswordChange';
import { Dashboard } from './Dashboard';
import { Users } from './Users';
import { UserCreate } from './UserCreate';
import { UserCreated } from './UserCreated';
import { UserCard } from './UserCard';
import { Servers } from './Servers';
import { ServerWizard } from './ServerWizard';
import { Telegram } from './Telegram';
import { AppsAdmin } from './AppsAdmin';
import { SmartRouting } from './SmartRouting';
import { DesktopUpdates } from './DesktopUpdates';
import { Logs } from './Logs';
import { Settings } from './Settings';

interface NavItem {
  key: AdminRoute;
  label: string;
  match: AdminRoute[];
}

const NAV: NavItem[] = [
  { key: 'dashboard', label: 'Обзор', match: ['dashboard'] },
  { key: 'users', label: 'Пользователи', match: ['users', 'user-create', 'user-created', 'user-card'] },
  { key: 'servers', label: 'Серверы', match: ['servers', 'server-wizard'] },
  { key: 'telegram', label: 'Telegram', match: ['telegram'] },
  { key: 'apps', label: 'Приложения', match: ['apps'] },
  { key: 'smart-routing', label: 'Умная маршрутизация', match: ['smart-routing'] },
  { key: 'desktop-updates', label: 'Обновления приложения', match: ['desktop-updates'] },
  { key: 'logs', label: 'Логи', match: ['logs'] },
  { key: 'settings', label: 'Настройки', match: ['settings'] },
];

export function AdminShell() {
  const { adminAuthed, mustChangePassword, nav, goAdmin, adminLogout, isMobile, data } = useApp();

  if (!adminAuthed) return <AdminLogin />;
  // Пока пароль дефолтный — панель заблокирована экраном обязательной смены (бэкенд
  // тоже блокирует мутации до смены). Это единственный шаг после первого входа.
  if (mustChangePassword) return <ForcePasswordChange />;

  const dbRisky = data?.dbHealth?.risky === true;

  const route = (nav.route === 'login' ? 'dashboard' : nav.route) as AdminRoute;
  const activeKey = NAV.find((n) => n.match.includes(route))?.key ?? 'dashboard';

  const content = (
    <>
      {/* КРИТИЧНО: персистентность базы не подтверждена — редеплой может стереть данные. */}
      {dbRisky ? (
        <div className="notice notice-red" style={{ marginBottom: 14 }}>
          <b>⚠️ Не подтверждено, что база переживёт обновление!</b>
          <div style={{ marginTop: 6 }}>
            Файл базы <code>{data?.dbHealth?.dbPath}</code> должен лежать на постоянном томе.
            Если это не так, при каждом редеплое/переустановке все пользователи, устройства и
            настройки будут потеряны. Подключите постоянное хранилище (persistent storage) для
            каталога базы: в Coolify это «Storages» с точкой монтирования на <code>/data</code>,
            в docker-compose — именованный том на <code>/data</code>. Затем обновите панель ещё
            раз — если данные сохранятся, предупреждение исчезнет само. Сделайте это до того,
            как заведёте пользователей.
          </div>
        </div>
      ) : null}
      {route === 'dashboard' && <Dashboard />}
      {route === 'users' && <Users />}
      {route === 'user-create' && <UserCreate />}
      {route === 'user-created' && <UserCreated />}
      {route === 'user-card' && <UserCard />}
      {route === 'servers' && <Servers />}
      {route === 'server-wizard' && <ServerWizard />}
      {route === 'telegram' && <Telegram />}
      {route === 'apps' && <AppsAdmin />}
      {route === 'smart-routing' && <SmartRouting />}
      {route === 'desktop-updates' && <DesktopUpdates />}
      {route === 'logs' && <Logs />}
      {route === 'settings' && <Settings />}
    </>
  );

  if (isMobile) {
    return (
      <div style={{ background: 'var(--bg-app)', minHeight: '100vh' }}>
        <header style={{ position: 'sticky', top: 0, zIndex: 20, background: 'var(--bg-app)', borderBottom: '1px solid var(--border)' }}>
          <div className="row-between" style={{ padding: '14px 16px' }}>
            <Wordmark suffix="admin" />
            <button className="mono" style={{ background: 'none', border: 0, color: 'var(--text-faint)', fontSize: 12, cursor: 'pointer' }} onClick={adminLogout}>
              Выйти
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '0 12px 10px' }}>
            {NAV.map((n) => (
              <button
                key={n.key}
                onClick={() => goAdmin(n.key)}
                className="chip chip-sm"
                style={{
                  whiteSpace: 'nowrap',
                  background: activeKey === n.key ? 'var(--surface-btn-2)' : 'transparent',
                  color: activeKey === n.key ? 'var(--text-primary)' : 'var(--text-muted-2)',
                  border: 0,
                }}
              >
                {n.label}
              </button>
            ))}
          </div>
        </header>
        <main style={{ padding: '16px 16px 48px', maxWidth: 1080, margin: '0 auto' }}>{content}</main>
      </div>
    );
  }

  return (
    <div style={{ background: 'var(--bg-app)', minHeight: '100vh', display: 'flex' }}>
      <aside
        style={{
          width: 216, flex: 'none', position: 'sticky', top: 0, height: '100vh',
          borderRight: '1px solid var(--border)', padding: '24px 0', display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ padding: '0 20px 24px' }}>
          <Wordmark suffix="admin" />
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column' }}>
          {NAV.map((n) => (
            <button
              key={n.key}
              onClick={() => goAdmin(n.key)}
              style={{
                textAlign: 'left', background: 'none', border: 0, cursor: 'pointer',
                padding: '11px 20px', borderLeft: `2px solid ${activeKey === n.key ? 'var(--accent)' : 'transparent'}`,
                color: activeKey === n.key ? 'var(--text-primary)' : 'var(--text-muted-2)', fontSize: 14, fontWeight: 600,
              }}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div style={{ marginTop: 'auto', padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="eyebrow">admin</span>
          <button className="mono" style={{ background: 'none', border: 0, color: 'var(--text-faint)', fontSize: 12, cursor: 'pointer', textAlign: 'left' }} onClick={adminLogout}>
            Выйти
          </button>
        </div>
      </aside>
      <main style={{ flex: 1, minWidth: 0, padding: '32px 40px 64px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>{content}</div>
      </main>
    </div>
  );
}
