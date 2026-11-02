'use client';

import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { inputClass } from './ui';

interface TagInputProps {
  id: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  maxItems: number;
  maxLength: number;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
}

/** Type a value and press Enter or comma to add it. Pasting "a, b, c" adds all three. */
export function TagInput({
  id,
  values,
  onChange,
  placeholder,
  maxItems,
  maxLength,
  invalid,
  describedBy,
  disabled,
}: TagInputProps) {
  const [text, setText] = useState('');
  const full = values.length >= maxItems;

  const add = (raw: string[]) => {
    const next = [...values];
    for (const item of raw.map((r) => r.trim()).filter(Boolean)) {
      if (next.length >= maxItems) break;
      if (!next.some((v) => v.toLowerCase() === item.toLowerCase())) next.push(item.slice(0, maxLength));
    }
    if (next.length !== values.length) onChange(next);
  };

  const commit = () => {
    if (text.trim()) add([text]);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !text && values.length) {
      onChange(values.slice(0, -1));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (/[,\n]/.test(pasted)) {
      e.preventDefault();
      add(pasted.split(/[,\n]/));
    }
  };

  return (
    <div>
      {values.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Added items">
          {values.map((v) => (
            <li
              key={v}
              className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-sm text-foreground"
            >
              {v}
              <button
                type="button"
                onClick={() => onChange(values.filter((x) => x !== v))}
                disabled={disabled}
                aria-label={`Remove ${v}`}
                className="rounded-full px-1.5 text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={id}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={commit}
        placeholder={full ? `Limit of ${maxItems} reached` : placeholder}
        maxLength={maxLength}
        disabled={disabled || full}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={inputClass}
      />
    </div>
  );
}
