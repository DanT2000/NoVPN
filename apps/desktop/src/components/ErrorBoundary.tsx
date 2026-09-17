/* Граница ошибок последнего рубежа. Без неё исключение при рендере любого
   компонента обрушивает весь интерфейс клиента в пустой экран — а это VPN, и
   человек тогда не может даже отключиться. Ловим сбой, показываем понятный экран
   с перезагрузкой и пишем причину в консоль. Обычный рендер граница не трогает. */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Необработанная ошибка интерфейса:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Что-то пошло не так</div>
          <div style={{ fontSize: 13, opacity: 0.7 }}>
            Интерфейс столкнулся с ошибкой. Перезапустите его — если повторится, сообщите нам.
          </div>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Перезапустить интерфейс
          </button>
        </div>
      </div>
    );
  }
}
