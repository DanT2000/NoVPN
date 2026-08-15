// A0 — Вход администратора. Центрированная карточка.

import { useState } from 'react';
import { useApp } from '../store/AppStore';
import { Wordmark, Field } from '../components/ui';

export function AdminLogin() {
  const { adminLogin, goAdmin, goPublic, nav } = useApp();
    const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const ok = await adminLogin(password);
      // Deep-link сохраняем: пришли на /admin/settings → после входа открываются
      // настройки, а не дашборд. На dashboard уходим только с «голого» /admin (login).
      if (ok) { if (nav.area !== 'admin' || nav.route === 'login') goAdmin('dashboard'); }
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        background: 'var(--bg-app)', minHeight: '100vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div style={{ width: 'min(380px, 100%)' }}>
        <div className="row-between" style={{ marginBottom: 20 }}>
          <Wordmark suffix="admin" />
          <button
            type="button"
            className="mono"
            style={{ background: 'none', border: 0, color: 'var(--text-faint)', fontSize: 12, cursor: 'pointer' }}
            onClick={() => goPublic('home')}
          >
            ← на сайт
          </button>
        </div>

        <div className="card">
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Field label="Пароль администратора">
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus
              />
            </Field>

            {error ? <div className="notice notice-red">Неверный пароль.</div> : null}

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy}>
              {busy ? 'Входим…' : 'Войти'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
