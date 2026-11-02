import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token for session cookies and invitation links. Only its hash is ever stored. */
export const newToken = () => randomBytes(32).toString('base64url');

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const hours = (name: string, fallback: number) => (Number(process.env[name]) || fallback) * 60 * 60 * 1000;

export const sessionTtlMs = () => hours('SESSION_TTL_HOURS', 12);
export const invitationTtlMs = () => hours('INVITATION_TTL_HOURS', 7 * 24);

/** Where invitation links point (the HR dashboard's /invite/:token page). */
export const appUrl = () => (process.env.HR_DASHBOARD_URL || 'http://localhost:3000').replace(/\/+$/, '');
