/**
 * Keeps the student's fresh phone proof (signed, valid ~30 min) for THIS browser tab only, so the
 * "my data" page right after applying does not ask for a second OTP. sessionStorage is cleared when
 * the tab closes; if storage is blocked we simply ask for an OTP again.
 */
export interface PhoneProof {
  companySlug: string;
  phone: string;
  otpToken: string;
}

const KEY = 'hireflow.phoneProof';

export function rememberPhoneProof(proof: PhoneProof): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(proof));
  } catch {
    // storage blocked (private mode etc.) - fine, the student verifies again
  }
}

export function recallPhoneProof(companySlug: string): PhoneProof | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const proof = raw ? (JSON.parse(raw) as Partial<PhoneProof>) : null;
    return proof?.companySlug === companySlug && typeof proof.phone === 'string' && typeof proof.otpToken === 'string'
      ? (proof as PhoneProof)
      : null;
  } catch {
    return null;
  }
}

export function forgetPhoneProof(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
