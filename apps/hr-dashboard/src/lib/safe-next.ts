/** Only same-site paths are allowed as a "continue to" target (no open redirects). */
export const safeNext = (v: string | string[] | null | undefined) =>
  typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : undefined;
