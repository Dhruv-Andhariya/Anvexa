import { HttpStatus } from '@nestjs/common';
import { dsaError } from '../dsa.dto';
import { ALL_INPUT_TYPES, type ProctorInputType } from './proctoring.types';

export const MAX_EVENTS_PER_REQUEST = 20;
const MAX_DETAIL = 60;

export interface ProctorStartDto {
  consent: true;
  consentVersion: string;
  fullscreen: boolean;
  /** The webcam was on when the candidate pressed Start (required when the policy requires the camera). */
  camera?: boolean;
}

export interface ProctorEventInput {
  type: ProctorInputType;
  /** Optional client time (epoch ms). The server clamps it into the attempt window. */
  at?: number;
  detail?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Identity comes only from the invitation token in the URL. A body that tries to name a candidate, assessment or
 * invitation is refused, so there is no way to record events against someone else.
 */
function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw dsaError(
        HttpStatus.BAD_REQUEST,
        'UNEXPECTED_FIELD',
        `${where}: "${key.slice(0, 40)}" is not accepted. Identity is taken from your assessment link.`,
      );
    }
  }
}

export function parseProctorStart(body: unknown): ProctorStartDto {
  if (!isRecord(body)) throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'Send a JSON body.');
  rejectUnknownKeys(body, ['consent', 'consentVersion', 'fullscreen', 'camera'], 'Request');
  if (body.consent !== true) {
    throw dsaError(HttpStatus.BAD_REQUEST, 'CONSENT_REQUIRED', 'You must read and accept the monitoring notice to start.');
  }
  if (typeof body.consentVersion !== 'string' || body.consentVersion === '') {
    throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'consentVersion is required.');
  }
  if (typeof body.fullscreen !== 'boolean') {
    throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'fullscreen must be true or false.');
  }
  if (body.camera !== undefined && typeof body.camera !== 'boolean') {
    throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'camera must be true or false.');
  }
  return { consent: true, consentVersion: body.consentVersion, fullscreen: body.fullscreen, ...(body.camera !== undefined ? { camera: body.camera } : {}) };
}

export function parseProctorEvents(body: unknown): ProctorEventInput[] {
  if (!isRecord(body)) throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'Send a JSON body.');
  rejectUnknownKeys(body, ['events'], 'Request');
  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) {
    throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'events must be a non-empty list.');
  }
  if (events.length > MAX_EVENTS_PER_REQUEST) {
    throw dsaError(HttpStatus.BAD_REQUEST, 'TOO_MANY_EVENTS', `Send at most ${MAX_EVENTS_PER_REQUEST} events per request.`);
  }
  return events.map((raw, i) => {
    if (!isRecord(raw)) throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', `Event ${i + 1} is not an object.`);
    rejectUnknownKeys(raw, ['type', 'at', 'detail'], `Event ${i + 1}`);
    if (typeof raw.type !== 'string' || !ALL_INPUT_TYPES.includes(raw.type)) {
      throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_EVENT_TYPE', `Event ${i + 1} has an unknown type.`);
    }
    const out: ProctorEventInput = { type: raw.type as ProctorInputType };
    if (raw.at !== undefined) {
      if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) {
        throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', `Event ${i + 1}: at must be a number.`);
      }
      out.at = raw.at;
    }
    if (raw.detail !== undefined) {
      if (typeof raw.detail !== 'string') throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', `Event ${i + 1}: detail must be text.`);
      // Short label only (e.g. "Ctrl+Shift+I"): strip control characters, cap the length.
      out.detail = raw.detail.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_DETAIL);
    }
    return out;
  });
}
