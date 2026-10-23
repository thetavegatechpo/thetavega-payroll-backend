// Set an employee mobile-app password without changing payroll accounts.
// From backend root: node --env-file=.env src/scripts/setMobilePassword.js EMPLOYEE_CODE
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { Employee } from '../models/index.js';
import MobileEmployeeCredential from '../models/MobileEmployeeCredential.js';

const code = process.argv[2];
if (!code || process.argv.length !== 3) { console.error('Usage: node --env-file=.env src/scripts/setMobilePassword.js EMPLOYEE_CODE'); process.exit(1); }
if (!process.stdin.isTTY) { console.error('Run in an interactive terminal'); process.exit(1); }
const promptSecret = async (prompt) => {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  const raw = !!stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  let result = '';
  try {
    while (true) {
      const c = await new Promise(resolve => stdin.once('data', resolve));
      const s = c.toString('utf8');
      if (s === '\r' || s === '\n') break;
      if (s === '\u0003') throw new Error('Cancelled');
      if (s === '\u007f' || s === '\b') { result = result.slice(0,-1); continue; }
      if (/^[\x20-\x7e]+$/.test(s)) result += s;
    }
    process.stdout.write('\n');
    return result;
  } finally { stdin.setRawMode(raw); stdin.pause(); }
};
try {
  const pass = await promptSecret('New employee password (10+ characters): ');
  const confirm = await promptSecret('Repeat password: ');
  if (pass.length < 10 || pass !== confirm || pass.length > 128) throw new Error('Passwords must match and be 10-128 characters');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not configured');
  await mongoose.connect(process.env.MONGODB_URI);
  const employee = await Employee.findOne({ employeeCode: code, status: 'ACTIVE' });
  if (!employee) throw new Error('Active employee code not found');
  await MobileEmployeeCredential.findOneAndUpdate({ employee: employee._id }, { $set: { passwordHash: await bcrypt.hash(pass,12), mustChangePassword: false, passwordChangedAt: new Date(), failedAttempts: 0, lockedUntil: null } }, { upsert: true, new: true, runValidators: true });
  console.log('Mobile login password configured for employee code:', code);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
