import { useApp } from './store/AppStore';
import { Loading } from './components/ui';
import { PublicShell } from './public/PublicShell';
import { AdminShell } from './admin/AdminShell';

export function App() {
  const { loading, loadError, data, reload, nav } = useApp();

  if (loading && !data) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loading text="Загрузка…" />
      </div>
    );
  }

  if (loadError && !data) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div className="stack center" style={{ maxWidth: 360 }}>
          <div className="notice notice-red">{loadError}</div>
          <button className="btn btn-primary" onClick={() => void reload()}>
            Повторить
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return nav.area === 'admin' ? <AdminShell /> : <PublicShell />;
}
