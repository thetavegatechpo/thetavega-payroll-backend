import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import MobileEmployeeCredential from '../models/MobileEmployeeCredential.js';
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Employee } from '../models/index.js';
import MobileDeviceSession from '../models/MobileDeviceSession.js';
import { authenticateMobile, hashToken } from '../middleware/mobileAuth.js';
import { asyncHandler as wrap } from '../utils/asyncHandler.js';

const router = Router();
const mobileSchema = z.object({ mobile: z.string().regex(/^[6-9]\d{9}$/) }).strict();

// Existing employee phone numbers may be stored as 10-digit or +91-prefix strings.
// If more than one active record matches, fail closed without exposing employee details.
const candidates = mobile => [mobile, `+91${mobile}`, `91${mobile}`];
async function uniqueActiveEmployee(mobile) {
  const found = await Employee.find({ mobile: { $in: candidates(mobile) }, status: 'ACTIVE' }).select('_id employeeCode firstName lastName mobile').limit(2);
  return found.length === 1 ? found[0] : null;
}

// Mobile/password authentication, separate from payroll administrator credentials.
const passwordSchema = mobileSchema.extend({ password: z.string().min(1).max(128) }).strict();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
const SESSION_HOURS = 24;
router.post('/login', loginLimiter, wrap(async (req, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Enter a valid mobile number and password' });
  const employee = await uniqueActiveEmployee(parsed.data.mobile);
  const credential = employee ? await MobileEmployeeCredential.findOne({ employee: employee._id }).select('+passwordHash') : null;
  const now = new Date();
  const locked = credential?.lockedUntil && credential.lockedUntil > now;
  // Never create or expose credentials merely through a login attempt.
  const valid = !locked && credential && await bcrypt.compare(parsed.data.password, credential.passwordHash);
  if (!valid) {
    if (credential && !locked) {
      const count = (credential.failedAttempts || 0) + 1;
      credential.failedAttempts = count >= 5 ? 0 : count;
      credential.lockedUntil = count >= 5 ? new Date(Date.now() + 15 * 60_000) : null;
      await credential.save();
    }
    return res.status(401).json({ message: 'Invalid credentials or account temporarily locked' });
  }
  credential.failedAttempts = 0;
  credential.lockedUntil = null;
  await credential.save();
  if (!process.env.MOBILE_JWT_SECRET || process.env.MOBILE_JWT_SECRET.length < 32) throw new Error('MOBILE_JWT_SECRET must be at least 32 characters');
  const token = jwt.sign({ tokenType: 'employee' }, process.env.MOBILE_JWT_SECRET, { algorithm: 'HS256', subject: String(employee._id), issuer: 'thetavega-payroll', audience: 'thetavega-mobile', expiresIn: `${SESSION_HOURS}h`, jwtid: randomUUID() });
  await MobileDeviceSession.create({ employee: employee._id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + SESSION_HOURS * 60 * 60_000) });
  res.json({ token, tokenType: 'Bearer', expiresInSeconds: SESSION_HOURS * 3600, mustChangePassword: credential.mustChangePassword, employee: { id: String(employee._id), employeeCode: employee.employeeCode, name: `${employee.firstName} ${employee.lastName}`.trim() } });
}));

const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(10).max(128) }).strict();
router.post('/change-password', authenticateMobile, wrap(async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'New password must have at least 10 characters' });
  const cred = await MobileEmployeeCredential.findOne({ employee: req.mobileEmployee._id }).select('+passwordHash');
  if (!cred || !await bcrypt.compare(parsed.data.currentPassword, cred.passwordHash)) return res.status(401).json({ message: 'Current password incorrect' });
  if (parsed.data.currentPassword === parsed.data.newPassword) return res.status(400).json({ message: 'Choose a different password' });
  cred.passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  cred.mustChangePassword = false;
  cred.passwordChangedAt = new Date();
  await cred.save();
  // Revoke other device sessions when password changes.
  await MobileDeviceSession.updateMany({ employee: req.mobileEmployee._id, _id: { $ne: req.mobileSession._id }, revokedAt: null }, { $set: { revokedAt: new Date() } });
  res.json({ message: 'Password changed successfully' });
}));

router.get('/me', authenticateMobile, wrap(async (req, res) => {
  const employee = await Employee.findById(req.mobileEmployee._id).select('employeeCode firstName lastName mobile department designation status').populate('department', 'code name').populate('designation', 'code name');
  res.json({ employee: { id: String(employee._id), employeeCode: employee.employeeCode, firstName: employee.firstName, lastName: employee.lastName, mobile: employee.mobile, department: employee.department, designation: employee.designation } });
}));

router.post('/logout', authenticateMobile, wrap(async (req, res) => {
  await MobileDeviceSession.updateOne({ _id: req.mobileSession._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  res.json({ message: 'Logged out' });
}));
export default router;
