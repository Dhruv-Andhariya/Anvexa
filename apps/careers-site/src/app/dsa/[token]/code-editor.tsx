'use client';

import { useMemo, useRef } from 'react';

interface Props {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  label: string;
  /** 'sql' = SQL keywords, strings, numbers and comments are highlighted. */
  highlight?: 'sql';
}

const INDENT = '    ';

const SQL_KEYWORDS = new Set(
  (
    'select distinct from where and or not in between like is null as on join inner left right full outer cross natural using group by having order asc desc ' +
    'limit offset union all intersect except case when then else end with recursive exists any some over partition rows range preceding following current row ' +
    'cast collate escape glob true false values'
  ).split(' '),
);
const SQL_FUNCTIONS = new Set(
  'count sum avg min max round abs coalesce ifnull nullif length lower upper substr trim replace strftime date datetime julianday rank dense_rank row_number lag lead total group_concat printf instr'.split(' '),
);
const SQL_TOKEN = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|\b(\d+(?:\.\d+)?)\b|([A-Za-z_][A-Za-z0-9_]*)/g;

/** SQL split into highlighted pieces (the text itself is unchanged, so it lines up with the textarea exactly). */
function highlightSql(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(SQL_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [token, comment, str, quoted, num, word] = m;
    const lower = word?.toLowerCase();
    const cls = comment
      ? 'italic text-muted'
      : str
        ? 'text-success'
        : quoted
          ? 'text-foreground'
          : num
            ? 'text-danger'
            : lower && SQL_KEYWORDS.has(lower)
              ? 'font-semibold text-accent'
              : lower && SQL_FUNCTIONS.has(lower)
                ? 'text-accent'
                : null;
    out.push(
      cls ? (
        <span key={key++} className={cls}>
          {token}
        </span>
      ) : (
        token
      ),
    );
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Dependency-free code editor: monospace textarea with a line-number gutter and Tab indentation. With `highlight`, a
 * highlighted copy of the text sits exactly behind a transparent textarea (typing, caret, selection and undo stay the
 * browser's own).
 */
export function CodeEditor({ value, onChange, disabled, label, highlight }: Props) {
  const gutter = useRef<HTMLDivElement>(null);
  const painted = useRef<HTMLPreElement>(null);
  const lines = value.split('\n').length;
  const colored = useMemo(() => (highlight === 'sql' ? highlightSql(value) : null), [highlight, value]);

  /**
   * Inserts text at the caret through the browser's own editing command. It replaces a selection, moves the caret,
   * fires a normal `input` event (so React state follows) and keeps native undo / redo working, with no timing gap
   * where a fast keystroke could land in the wrong place. Falls back to a state update if the command is unavailable.
   */
  const insertText = (el: HTMLTextAreaElement, text: string) => {
    if (document.execCommand('insertText', false, text)) return;
    const { selectionStart: s, selectionEnd: end } = el;
    onChange(value.slice(0, s) + text + value.slice(end));
    requestAnimationFrame(() => el.setSelectionRange(s + text.length, s + text.length));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === 'Tab') {
      e.preventDefault();
      insertText(el, INDENT);
    } else if (e.key === 'Enter') {
      // keep the indentation of the current line
      const s = el.selectionStart;
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const indent = /^[ \t]*/.exec(value.slice(lineStart, s))?.[0] ?? '';
      if (indent) {
        e.preventDefault();
        insertText(el, `\n${indent}`);
      }
    }
  };

  return (
    <div data-code-editor="" className="flex min-h-[320px] flex-1 overflow-hidden rounded-md border border-border bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/40">
      <div
        ref={gutter}
        aria-hidden="true"
        className="select-none overflow-hidden border-r border-border bg-background px-2 py-3 text-right font-mono text-xs leading-5 text-muted"
      >
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        {colored && (
          <pre
            ref={painted}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre px-3 py-3 font-mono text-xs leading-5 text-foreground"
          >
            {colored}
            {/* a trailing newline needs a character after it to take up its line, like in the textarea */}
            {'\n '}
          </pre>
        )}
        <textarea
          aria-label={label}
          value={value}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
            if (painted.current) {
              painted.current.scrollTop = e.currentTarget.scrollTop;
              painted.current.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
          className={`absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent px-3 py-3 font-mono text-xs leading-5 focus:outline-none disabled:opacity-60 ${colored ? 'text-transparent caret-foreground' : 'text-foreground'}`}
        />
      </div>
    </div>
  );
}
