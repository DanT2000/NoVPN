/* Граница ошибок последнего рубежа. Без неё любое исключение при рендере любого
   компонента (например, на неожиданной форме данных из API) обрушивает ВЕСЬ SPA в
   пустой белый экран без единой кнопки. Здесь ловим такой сбой, показываем понятный
   экран с перезагрузкой и пишем причину в консоль для диагностики. Обычный рендер
   граница не трогает — она активна только когда ниже по дереву что-то бросило. */

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
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div className="stack center" style={{ maxWidth: 380 }}>
          <div className="notice notice-red">
            Что-то пошло не так на этой странице. Обновите её — если повторится, сообщите нам.
          </div>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Обновить страницу
          </button>
        </div>
      </div>
    );
  }
}
