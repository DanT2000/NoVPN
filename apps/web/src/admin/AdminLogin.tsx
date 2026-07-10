// A0 — Вход администратора. Центрированная карточка, demo: admin / admin.

import { useState } from 'react';
import { useApp } from '../store/AppStore';
import { Wordmark, Field } from '../components/ui';

export function AdminLogin() {
  const { adminLogin, goAdmin, goPublic } = useApp();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const ok = await adminLogin(login, password);
      if (ok) goAdmin('dashboard');
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
            <Field label="Логин">
              <input
                className="input"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="username"
                autoFocus
              />
            </Field>
            <Field label="Пароль">
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Field>

            {error ? <div className="notice notice-red">Неверный логин или пароль.</div> : null}

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy}>
              {busy ? 'Входим…' : 'Войти'}
            </button>
          </form>

          <p className="small muted" style={{ marginTop: 14, marginBottom: 0, lineHeight: 1.5 }}>
            Двухфакторная аутентификация предусмотрена архитектурой и появится на этапе backend.
          </p>
        </div>

        <div className="mono center" style={{ marginTop: 16, color: 'var(--text-faint)', fontSize: 12 }}>
          demo: admin / admin
        </div>
      </div>
    </div>
  );
}
