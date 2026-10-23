import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { Employee } from '../models/index.js';
import MobileDeviceSession from '../models/MobileDeviceSession.js';

export const hashToken = token => createHash('sha256').update(token).digest('hex');
export async function authenticateMobile(req, res, next) {
  try {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!match) return res.status(401).json({ message: 'Employee authentication required' });
    const secret = process.env.MOBILE_JWT_SECRET;
    if (!secret || secret.length < 32) throw new Error('MOBILE_JWT_SECRET not configured');
    const claims = jwt.verify(match[1], secret, { algorithms: ['HS256'], audience: 'thetavega-mobile', issuer: 'thetavega-payroll' });
    if (claims.tokenType !== 'employee' || !claims.jti) return res.status(401).json({ message: 'Invalid session' });
    const session = await MobileDeviceSession.findOne({ employee: claims.sub, tokenHash: hashToken(match[1]), revokedAt: null, expiresAt: { $gt: new Date() } });
    if (!session) return res.status(401).json({ message: 'Session expired or revoked' });
    const employee = await Employee.findOne({ _id: claims.sub, status: 'ACTIVE' }).select('_id employeeCode firstName lastName mobile department designation');
    if (!employee) return res.status(401).json({ message: 'Employee access unavailable' });
    req.mobileEmployee = employee;
    req.mobileSession = session;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError' || error.name === 'NotBeforeError' || error.name === 'CastError') return res.status(401).json({ message: 'Invalid or expired session' });
    next(error);
  }
}
