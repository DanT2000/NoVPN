import { useState } from 'react';
import { useApp } from '../store/AppStore';
import { api } from '../api';
import { CodeInput } from '../components/CodeInput';

const DEMO = [
  { code: '482915', label: 'активен' },
  { code: '664209', label: 'истёк' },
  { code: '918273', label: 'отключён' },
  { code: '555001', label: 'лимит' },
];

export function Home() {
  const { setPublicUser, goPublic } = useApp();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const demoOn = true;

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
      goPublic('cabinet');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка проверки кода.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div style={{ minHeight: 'calc(100vh - 160px)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ paddingTop: '12vh' }}>
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

        {demoOn ? (
          <div style={{ marginTop: 28 }}>
            <div className="eyebrow" style={{ color: 'var(--text-fainter)', marginBottom: 10 }}>
              demo-коды прототипа
            </div>
            <div className="chip-row">
              {DEMO.map((d) => (
                <button key={d.code} type="button" className="chip chip-sm" onClick={() => setCode(d.code)}>
                  <span className="mono">{d.code}</span> · {d.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 'auto', paddingTop: 40 }}>
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-fainter)' }}>
          v2.0 · управление доступами
        </span>
      </div>
    </div>
  );
}
