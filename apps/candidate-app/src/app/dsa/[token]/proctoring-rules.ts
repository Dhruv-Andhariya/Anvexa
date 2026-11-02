import type { ProctorInputType } from '@/lib/dsa-api';

/** What a key press means for the assessment. `null` = a normal key: never blocked, never reported. */
export interface KeyVerdict {
  type: ProctorInputType;
  detail: string;
}

const isMac = () => typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/**
 * Restricted shortcuts only. Typing, Tab / Shift+Tab (indentation), Enter, Backspace, arrows, Home / End,
 * Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (undo / redo), Ctrl+Left / Right and everything else pass through untouched.
 *
 * `inEditor`: select-all inside the code editor is a normal editing action (copy / cut stay blocked, so it cannot be
 * used to lift text out), so it is allowed there and only restricted elsewhere.
 *
 * Letters are matched on `code` (physical key), so other keyboard layouts and macOS Option do not change the result.
 * Honest limit: a page only sees keys the browser passes to it. Many browser / OS shortcuts (Ctrl+T, Ctrl+W, Alt+Tab,
 * the Windows key, Ctrl+Shift+Delete ...) never reach the page and cannot be blocked from it.
 */
export function classifyKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'getModifierState'>, inEditor: boolean): KeyVerdict | null {
  // AltGr (Ctrl+Alt on Windows) types characters on many layouts. Never treat it as a shortcut.
  if (e.getModifierState?.('AltGraph')) return null;

  const mod = e.ctrlKey || e.metaKey;
  const code = e.code;
  const mac = isMac();
  const m = mac ? 'Cmd' : 'Ctrl';

  if (e.key === 'F12') return { type: 'DEVTOOLS_SHORTCUT', detail: 'F12' };

  // Screenshots: the page can only notice these keys, never block them, and never sees Win+Shift+S, the Snipping Tool,
  // a phone camera, or most macOS shortcuts (the OS usually keeps them).
  if (e.key === 'PrintScreen' || code === 'PrintScreen') return { type: 'SCREENSHOT_ATTEMPT', detail: 'PrintScreen' };
  if (e.metaKey && e.shiftKey && (code === 'Digit3' || code === 'Digit4' || code === 'Digit5')) {
    return { type: 'SCREENSHOT_ATTEMPT', detail: `Cmd+Shift+${code.slice(5)}` };
  }

  if (mod && e.shiftKey && !e.altKey && (code === 'KeyI' || code === 'KeyJ' || code === 'KeyC')) {
    return { type: 'DEVTOOLS_SHORTCUT', detail: `${m}+Shift+${code.slice(3)}` };
  }
  if (e.ctrlKey && e.shiftKey && !e.altKey && code === 'KeyK') return { type: 'DEVTOOLS_SHORTCUT', detail: 'Ctrl+Shift+K' };
  if (e.metaKey && e.altKey && (code === 'KeyI' || code === 'KeyJ' || code === 'KeyC')) {
    return { type: 'DEVTOOLS_SHORTCUT', detail: `Cmd+Option+${code.slice(3)}` };
  }
  if (e.metaKey && e.altKey && code === 'KeyU') return { type: 'VIEW_SOURCE', detail: 'Cmd+Option+U' };

  if (mod && !e.altKey) {
    switch (code) {
      case 'KeyU':
        return { type: 'VIEW_SOURCE', detail: `${m}+U` };
      case 'KeyS':
        return { type: 'SAVE_SHORTCUT', detail: `${m}+S` };
      case 'KeyP':
        return { type: 'PRINT_SHORTCUT', detail: `${m}+P` };
      case 'KeyC':
        return { type: 'COPY', detail: `${m}+C` };
      case 'KeyX':
        return { type: 'CUT', detail: `${m}+X` };
      case 'KeyV':
        return { type: 'PASTE', detail: `${m}+V` };
      case 'KeyA':
        return inEditor ? null : { type: 'SELECT_ALL', detail: `${m}+A` };
      case 'Insert':
        return { type: 'COPY', detail: `${m}+Insert` };
    }
  }
  if (e.shiftKey && !mod && code === 'Insert') return { type: 'PASTE', detail: 'Shift+Insert' };
  if (e.shiftKey && !mod && code === 'Delete') return { type: 'CUT', detail: 'Shift+Delete' };
  return null;
}

/** Short, plain messages. They say what was recorded, not what the thresholds are. */
export const NOTICE_TEXT: Partial<Record<ProctorInputType, string>> = {
  FULLSCREEN_EXIT: 'You left full-screen mode. This was recorded.',
  TAB_SWITCH: 'You switched away from the assessment tab. This was recorded.',
  WINDOW_BLUR: 'The assessment window lost focus. This was recorded.',
  COPY: 'Copying is disabled during the assessment. The attempt was recorded.',
  CUT: 'Cutting is disabled during the assessment. The attempt was recorded.',
  PASTE: 'Pasting is disabled during the assessment. The attempt was recorded.',
  SELECT_ALL: 'Select-all is disabled outside the code editor. The attempt was recorded.',
  CONTEXT_MENU: 'The right-click menu is disabled during the assessment. The attempt was recorded.',
  DEVTOOLS_SHORTCUT: 'Developer tools are not allowed during the assessment. The attempt was recorded.',
  VIEW_SOURCE: 'Viewing the page source is not allowed during the assessment. The attempt was recorded.',
  SAVE_SHORTCUT: 'Saving the page is not allowed during the assessment. The attempt was recorded.',
  PRINT_SHORTCUT: 'Printing is not allowed during the assessment. The attempt was recorded.',
  SCREENSHOT_ATTEMPT: 'Screenshots are not allowed during the assessment. The attempt was recorded.',
};
