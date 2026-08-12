// Обязательная смена пароля при первом входе (пока пароль администратора дефолтный).
// Блокирует всю панель до задания своего пароля. Без локаута: админ уже вошёл под
// дефолтным паролем, здесь просто задаёт новый — текущий вводить не нужно (бэкенд
// не спрашивает его, пока пароль дефолтный).

import { useState } from 'react';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import { Wordmark, Field } from '../components/ui';

export function ForcePasswordChange() {
  const { reload, adminLogout } = useApp();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (pw.length < 6) return setError('Новый пароль — минимум 6 символов.');
    if (pw !== pw2) return setError('Пароли не совпадают.');
    setBusy(true);
    setError(null);
    try {
      // current не нужен: пароль ещё дефолтный, бэкенд его не проверяет.
      await api.changeAdminPassword('', pw);
      await reload(); // перечитываем bootstrap → mustChangePassword станет false → панель откроется
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить пароль.');
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
      <div style={{ width: 'min(400px, 100%)' }}>
        <div className="row-between" style={{ marginBottom: 20 }}>
          <Wordmark suffix="admin" />
          <button
            type="button"
            className="mono"
            style={{ background: 'none', border: 0, color: 'var(--text-faint)', fontSize: 12, cursor: 'pointer' }}
            onClick={() => void adminLogout()}
          >
            выйти
          </button>
        </div>

        <div className="card">
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Задайте пароль администратора</div>
          <div className="body small muted" style={{ marginBottom: 14 }}>
            Панель доступна из интернета, а сейчас используется стандартный пароль. Прежде
            чем продолжить, задайте свой — это единственный шаг.
          </div>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Field label="Новый пароль">
              <input
                className="input"
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoComplete="new-password"
                placeholder="минимум 6 символов"
                autoFocus
              />
            </Field>
            <Field label="Повторите пароль">
              <input
                className="input"
                type="password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                autoComplete="new-password"
              />
            </Field>

            {error ? <div className="notice notice-red">{error}</div> : null}

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy}>
              {busy ? 'Сохраняем…' : 'Сохранить и войти'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
