/**
 * Webcam for the monitored SQL assessment (same helpers as the careers site's online test, apps/careers-site/src/lib/
 * camera.ts). The video stays in the browser: it is shown to the candidate and analysed on their computer, never
 * recorded or uploaded. The page reports only short EVENTS about it.
 */

export type CameraProblem = 'insecure' | 'unsupported' | 'denied' | 'not_found' | 'in_use' | 'model' | 'unknown';

export const CAMERA_MESSAGES: Record<CameraProblem, string> = {
  insecure: 'The camera only works on a secure (https) page. Please open the link from your email exactly as it is.',
  unsupported: 'This browser cannot use a camera. Please use a recent Chrome, Edge or Firefox on a laptop or desktop.',
  denied: 'Camera access is blocked for this website. Allow it as shown below; the page continues by itself once it is allowed.',
  not_found: 'No camera was found. Connect a webcam, or use a laptop with a camera, then press Try again.',
  in_use:
    'Your camera is already being used by another app or browser tab (for example a video call, the Camera app, or this test open in another tab). Close it, then press Try again.',
  model: 'The camera check could not be loaded in this browser. Please try again, or use a recent Chrome or Edge.',
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

/** Video only, small: enough for the face model, nothing more. */
export async function startCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
}

/** What the browser has decided for this site: allowed, not asked yet, blocked, or it does not say (older browsers). */
export type CameraPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

/** The current camera permission, then every change to it (the candidate unblocking the camera, say). */
export async function followCameraPermission(onChange: (p: CameraPermission) => void): Promise<() => void> {
  try {
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
    const report = () => onChange(status.state as CameraPermission);
    report();
    status.addEventListener('change', report);
    return () => status.removeEventListener('change', report);
  } catch {
    onChange('unknown'); // Firefox / older Safari: we learn it when asking
    return () => undefined;
  }
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
