/**
 * Webcam for the monitored assessment. The video stays in the browser: it is shown to the candidate only, never
 * recorded or uploaded. The page reports EVENTS about it (started / stopped / permission withdrawn).
 */

export type CameraProblem = 'insecure' | 'unsupported' | 'denied' | 'not_found' | 'in_use' | 'unknown';

export const CAMERA_MESSAGES: Record<CameraProblem, string> = {
  insecure: 'The camera only works on a secure (https) page. Please open the link from your email exactly as it is.',
  unsupported: 'This browser cannot use a camera. Please use a recent Chrome, Edge, Firefox or Safari.',
  denied: 'Camera access is blocked. Allow the camera for this site (the camera icon in the address bar, or your browser settings), then try again.',
  not_found: 'No camera was found. Connect a webcam, or use a laptop or phone with a camera.',
  in_use: 'Your camera is being used by another app (for example a video call). Close that app, then try again.',
  unknown: 'The camera could not be started. Please try again, or try another browser.',
};

export function cameraSupport(): CameraProblem | null {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  return null;
}

export function cameraProblemOf(err: unknown): CameraProblem {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'not_found';
  if (name === 'NotReadableError' || name === 'AbortError') return 'in_use';
  return 'unknown';
}

/** Video only, small: a preview for the candidate, nothing more. */
export async function startCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' }, audio: false });
}

/** Calls `onRevoked` when the camera permission is withdrawn in the browser settings (where browsers tell us). */
export async function watchCameraPermission(onRevoked: () => void): Promise<() => void> {
  try {
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
    const handler = () => {
      if (status.state === 'denied') onRevoked();
    };
    status.addEventListener('change', handler);
    return () => status.removeEventListener('change', handler);
  } catch {
    return () => undefined; // Firefox / older Safari: the track's "ended" event still tells us
  }
}

export const fullscreenSupported = () => typeof document !== 'undefined' && !!document.documentElement.requestFullscreen && document.fullscreenEnabled;
