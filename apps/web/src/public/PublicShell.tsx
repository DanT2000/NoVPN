import { useEffect } from 'react';
import { useApp } from '../store/AppStore';
import type { PublicRoute } from '../store/AppStore';
import { Wordmark } from '../components/ui';
import { Home } from './Home';
import { Cabinet } from './Cabinet';
import { Wizard } from './Wizard';
import { Devices } from './Devices';
import { Connect } from './Connect';

export function PublicShell() {
  const { nav, goAdmin, publicUser, goPublic } = useApp();
  const route = nav.route as PublicRoute;

  // Кабинет/устройства/мастер требуют введённого кода.
  const needsUser = route !== 'home' && route !== 'apps';
  // Редирект — эффектом, а не во время рендера: setState в теле компонента
  // вызывает предупреждение React и лишний прогон.
  useEffect(() => {
    if (needsUser && !publicUser) goPublic('home');
  }, [needsUser, publicUser, goPublic]);
  if (needsUser && !publicUser) return null;

  return (
    <div style={{ background: 'var(--bg-app)', minHeight: '100vh' }}>
      <div style={{ width: 'min(460px, 100%)', margin: '0 auto', padding: '0 18px 56px' }}>
        <header
          style={{
            position: 'sticky', top: 0, zIndex: 20, background: 'var(--bg-app)',
            borderBottom: '1px solid var(--border)', padding: '16px 0 12px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}
        >
          <Wordmark />
          {route === 'home' ? (
            <button
              type="button"
              onClick={() => goAdmin('login')}
              className="mono"
              style={{ background: 'none', border: 0, color: 'var(--text-faint)', fontSize: 12, cursor: 'pointer' }}
            >
              admin →
            </button>
          ) : null}
        </header>

        <main style={{ paddingTop: 8 }}>
          {route === 'home' && <Home />}
          {route === 'cabinet' && <Cabinet />}
          {route === 'wizard' && <Wizard />}
          {route === 'devices' && <Devices />}
          {route === 'apps' && <Connect />}
        </main>
      </div>
    </div>
  );
}
