import { useApp } from './store/AppStore';
import { Loading } from './components/ui';
import { PublicShell } from './public/PublicShell';
import { AdminShell } from './admin/AdminShell';

export function App() {
  const { loading, loadError, data, publicData, reload, nav } = useApp();

  // Публичная часть живёт на publicData, админка — на data. Ждём то,
  // что нужно текущей области.
  const ready = nav.area === 'admin' ? !!data : !!publicData;

  if (loading && !ready) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loading text="Загрузка…" />
      </div>
    );
  }

  if (loadError && !ready) {
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

  // В админку пускаем и без data — AdminShell сам покажет экран входа.
  if (nav.area === 'admin') return <AdminShell />;
  return publicData ? <PublicShell /> : null;
}
