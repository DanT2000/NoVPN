import { useEffect, useMemo, useRef, useState } from 'react';

// Лёгкий редактор JSON без сторонних библиотек (в проекте нет monaco/codemirror):
// прозрачный <textarea> поверх подсвеченного <pre> (классика react-simple-code-editor)
// + колонка номеров строк + живая валидация с указанием строки/столбца и переходом
// к ошибке. Подсветка дебаунсится; на очень больших файлах отключается (перф).

const LINE_HEIGHT_PX = 19.5; // должно совпадать с CSS (.jed font 13px × line-height 1.5)
const HIGHLIGHT_MAX_CHARS = 400_000; // выше — рендерим без подсветки, чтобы не лагало

export interface JsonValidity {
  valid: boolean;
  line: number | null;
  col: number | null;
  pos: number | null;
  message: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Подсветка JSON: экранируем, затем оборачиваем токены в span с классами.
const TOKEN_RE = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
function highlightJson(src: string): string {
  return escapeHtml(src).replace(TOKEN_RE, (m) => {
    let cls: string;
    if (m[0] === '"') cls = /:\s*$/.test(m) ? 'j-key' : 'j-str';
    else if (m === 'true' || m === 'false') cls = 'j-bool';
    else if (m === 'null') cls = 'j-null';
    else cls = 'j-num';
    return `<span class="${cls}">${m}</span>`;
  });
}

/** Разобрать ошибку JSON.parse в {строка, столбец, позиция, сообщение}. */
export function locateJsonError(text: string): JsonValidity {
  try {
    JSON.parse(text);
    return { valid: true, line: null, col: null, pos: null, message: '' };
  } catch (e) {
    const raw = e instanceof Error ? e.message : 'Некорректный JSON';
    let pos: number | null = null;
    let line: number | null = null;
    let col: number | null = null;
    const mLC = /line (\d+) column (\d+)/i.exec(raw);
    const mPos = /position (\d+)/i.exec(raw);
    if (mPos) pos = Number(mPos[1]);
    if (mLC) {
      line = Number(mLC[1]);
      col = Number(mLC[2]);
    } else if (pos != null) {
      const before = text.slice(0, pos);
      line = before.split('\n').length;
      col = pos - before.lastIndexOf('\n');
    }
    if (pos == null && line != null && col != null) {
      // восстановим позицию из строки/столбца
      const lines = text.split('\n');
      let p = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) p += lines[i]!.length + 1;
      pos = p + (col - 1);
    }
    // почистим служебный хвост «in JSON at position …»
    const message = raw.replace(/\s*in JSON at position.*$/i, '').replace(/\s*in JSON$/i, '').trim() || 'Некорректный JSON';
    return { valid: false, line, col, pos, message };
  }
}

export function JsonEditor({
  value,
  onChange,
  onValidityChange,
  height = 520,
}: {
  value: string;
  onChange: (v: string) => void;
  onValidityChange?: (v: JsonValidity) => void;
  height?: number;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutRef = useRef<HTMLPreElement>(null);

  // Валидация — синхронно на каждое изменение (JSON.parse дёшев даже на сотнях КБ).
  const validity = useMemo(() => locateJsonError(value), [value]);
  useEffect(() => {
    onValidityChange?.(validity);
  }, [validity, onValidityChange]);

  // Подсветка — дебаунс (регулярка + большой innerHTML дороги).
  const [html, setHtml] = useState<string>(() => (value.length <= HIGHLIGHT_MAX_CHARS ? highlightJson(value) : escapeHtml(value)));
  useEffect(() => {
    const id = window.setTimeout(() => {
      setHtml(value.length <= HIGHLIGHT_MAX_CHARS ? highlightJson(value) : escapeHtml(value));
    }, 140);
    return () => window.clearTimeout(id);
  }, [value]);

  const lineCount = useMemo(() => (value === '' ? 1 : value.split('\n').length), [value]);
  const gutterText = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'), [lineCount]);
  const gutterWidth = `${Math.max(2, String(lineCount).length)}ch`;

  const syncScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutRef.current) gutRef.current.scrollTop = ta.scrollTop;
  };

  const jumpToError = () => {
    const ta = taRef.current;
    if (!ta || validity.pos == null) return;
    const pos = Math.max(0, Math.min(value.length, validity.pos));
    ta.focus();
    ta.setSelectionRange(pos, pos);
    const targetLine = validity.line ?? 1;
    ta.scrollTop = Math.max(0, (targetLine - 1) * LINE_HEIGHT_PX - height / 2);
    syncScroll();
  };

  return (
    <div className="jed-wrap">
      <div className="jed" style={{ height }}>
        <pre className="jed-gutter mono" ref={gutRef} aria-hidden style={{ width: gutterWidth }}>
          {gutterText}
        </pre>
        <div className="jed-main">
          <pre className="jed-highlight mono" ref={preRef} aria-hidden>
            <code dangerouslySetInnerHTML={{ __html: html + (value.endsWith('\n') ? '\n' : '') }} />
          </pre>
          <textarea
            className="jed-input mono"
            ref={taRef}
            value={value}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncScroll}
          />
        </div>
      </div>
      <div className="jed-status">
        {validity.valid ? (
          <span style={{ color: 'var(--green-fg)' }}>✓ JSON валиден</span>
        ) : (
          <span className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--red-fg)' }}>
              ✕ JSON невалиден{validity.line != null ? ` — строка ${validity.line}, столбец ${validity.col}` : ''}
            </span>
            <span className="small muted">{validity.message}</span>
            {validity.pos != null ? (
              <button type="button" className="btn btn-outline btn-sm" onClick={jumpToError}>
                Перейти к ошибке
              </button>
            ) : null}
          </span>
        )}
      </div>
    </div>
  );
}
