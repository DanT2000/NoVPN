import { useState } from 'react';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import { CodeInput } from '../components/CodeInput';

export function Home() {
  const { setPublicUser, goPublic, reloadPublic } = useApp();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    if (code.length !== 6 || checking) return;
    setChecking(true);
    setError(null);
    try {
      const res = await api.checkCode(code);
      if ('error' in res) {
        setError(res.error.message);
        return;
      }
      setPublicUser(res.user);
      // Код принят — сервер открыл сессию; забираем свои устройства.
      await reloadPublic();
      goPublic('cabinet');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка проверки кода.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div style={{ minHeight: 'calc(100vh - 96px)', display: 'flex', flexDirection: 'column' }}>
      {/* центрируем блок ввода по вертикали (как на входе в админку) */}
      <div style={{ margin: 'auto 0', width: '100%' }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 10px' }}>Доступ по коду</h1>
        <p style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--text-muted)', margin: '0 0 28px' }}>
          Введите шестизначный код из сообщения администратора — конфигурация выдаётся автоматически.
        </p>

        <div className="field" style={{ marginBottom: 16 }}>
          <span className="field-label">Код доступа</span>
          <CodeInput value={code} onChange={setCode} onEnter={submit} />
        </div>

        {error ? (
          <div className="notice notice-red" style={{ marginBottom: 16 }}>
            {error}
          </div>
        ) : null}

        <button
          className="btn btn-primary btn-lg btn-block"
          disabled={code.length !== 6 || checking}
          onClick={submit}
        >
          {checking ? 'Проверяем…' : 'Продолжить'}
        </button>
      </div>

      <div style={{ textAlign: 'center', paddingTop: 24 }}>
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-fainter)' }}>
          NoVPN · управление доступами
        </span>
      </div>
    </div>
  );
}
