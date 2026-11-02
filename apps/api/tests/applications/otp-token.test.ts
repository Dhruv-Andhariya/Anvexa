import { describe, expect, it } from 'vitest';
import { hashOtp, sameHash, signPhoneProof, verifyPhoneProof } from '../../src/modules/applications/otp/otp-token';
import { otpSenderFromEnv } from '../../src/modules/applications/otp/otp-sender';
import { otpSecretFromEnv } from '../../src/modules/applications/otp/otp.service';

const SECRET = 'x'.repeat(40);
const proof = { tenantId: 't1', phone: '+919876543210', exp: Math.floor(Date.now() / 1000) + 60 };

describe('phone proof token', () => {
  it('round-trips a valid token', () => expect(verifyPhoneProof(SECRET, signPhoneProof(SECRET, proof))).toEqual(proof));
  it('rejects a tampered payload', () => {
    const [, mac] = signPhoneProof(SECRET, proof).split('.');
    const forged = Buffer.from(JSON.stringify({ ...proof, phone: '+919999999999' })).toString('base64url');
    expect(verifyPhoneProof(SECRET, `${forged}.${mac}`)).toBeUndefined();
  });
  it('rejects another secret and expired tokens', () => {
    expect(verifyPhoneProof('y'.repeat(40), signPhoneProof(SECRET, proof))).toBeUndefined();
    expect(verifyPhoneProof(SECRET, signPhoneProof(SECRET, { ...proof, exp: 1 }))).toBeUndefined();
    expect(verifyPhoneProof(SECRET, 'garbage')).toBeUndefined();
  });
});

describe('otp hashing', () => {
  it('binds the code to tenant and phone', () => {
    const h = hashOtp(SECRET, 't1', '+919876543210', '123456');
    expect(sameHash(h, hashOtp(SECRET, 't1', '+919876543210', '123456'))).toBe(true);
    expect(sameHash(h, hashOtp(SECRET, 't2', '+919876543210', '123456'))).toBe(false);
    expect(h).not.toContain('123456');
  });
});

describe('production safety', () => {
  it('requires a real secret and a real OTP provider in production', () => {
    expect(() => otpSecretFromEnv({ NODE_ENV: 'production' })).toThrow();
    expect(() => otpSenderFromEnv({ NODE_ENV: 'production' })).toThrow();
    expect(otpSenderFromEnv({}).kind).toBe('dev');
  });
});
