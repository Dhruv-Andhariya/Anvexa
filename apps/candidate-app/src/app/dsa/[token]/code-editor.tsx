'use client';

import { useRef } from 'react';

interface Props {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  label: string;
}

const INDENT = '    ';

/** Dependency-free code editor: monospace textarea with a line-number gutter and Tab indentation. */
export function CodeEditor({ value, onChange, disabled, label }: Props) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = value.split('\n').length;

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
        }}
        className="min-w-0 flex-1 resize-none overflow-auto bg-transparent px-3 py-3 font-mono text-xs leading-5 text-foreground focus:outline-none disabled:opacity-60"
      />
    </div>
  );
}
