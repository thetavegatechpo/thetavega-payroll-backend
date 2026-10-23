import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export function localOtpAllowed() {
  return process.env.NODE_ENV === 'development' && process.env.MOBILE_OTP_DEV_MODE === 'true';
}
export function otpServiceAvailable() {
  // Real SMS adapter must be implemented before enabling production login.
  return localOtpAllowed();
}
export function newOtp() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
export function otpDigest(mobile, otp) {
  const secret = process.env.MOBILE_OTP_HMAC_SECRET;
  if (!secret || secret.length < 32) throw new Error('MOBILE_OTP_HMAC_SECRET must be at least 32 characters');
  return createHmac('sha256', secret).update(`${mobile}:${otp}`).digest('hex');
}
export function equalOtpHash(expected, actual) {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}
export async function sendOtp(mobile, otp) {
  if (!localOtpAllowed()) throw new Error('No SMS provider configured');
  // Local backend console ONLY. Never return the code through HTTP or store it in plaintext.
  console.log(`[LOCAL DEVELOPMENT OTP] +91${mobile}: ${otp}`);
}
