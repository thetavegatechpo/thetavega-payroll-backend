import { Router } from "express";
import bcrypt from "bcryptjs";
import MobileEmployeeCredential from "../models/MobileEmployeeCredential.js";
import MobileDeviceSession from "../models/MobileDeviceSession.js";
import { z } from "zod";
import mongoose from "mongoose";
import { Employee, Department, Designation } from "../models/index.js";
import { authenticate, permit } from "../middleware/auth.js";
import { asyncHandler as wrap } from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";

const router = Router();
router.use(authenticate);
const optionalText = z.string().trim().max(200).optional();

const schema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.union([z.string().email(), z.literal("")]).optional(),
  mobile: optionalText,
  dateOfBirth: z.coerce.date().optional(),
  gender: optionalText,
  department: z.string().refine(mongoose.isValidObjectId),
  designation: z.string().refine(mongoose.isValidObjectId),
  joiningDate: z.coerce.date(),
  employmentType: z.enum(["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"]).optional(),
  address: z.object({
    line1: optionalText, city: optionalText, state: optionalText, pincode: optionalText,
  }).strict().optional(),
  bank: z.object({
    accountHolder: optionalText, bankName: optionalText,
    accountNumber: optionalText, ifsc: optionalText,
  }).strict().optional(),
  statutory: z.object({
    pan: optionalText, uan: optionalText, esicNumber: optionalText,
    pfEligible: z.boolean().optional(), esicEligible: z.boolean().optional(),
  }).strict().optional(),
}).strict();

const employeeNumberSchema = z.string().regex(/^[0-9]{1,5}$/, "Enter 1 to 5 digits for Employee ID");
const createSchema = schema.extend({ employeeNumber: employeeNumberSchema });
// Employee number is optional in PATCH; if supplied, update employeeCode.
const editSchema = schema.partial().extend({ employeeNumber: employeeNumberSchema.optional() });
const employeeCodeFor = number => `TT/E/${number.padStart(5, "0")}`;

const clean = e => {
  const o = e.toObject ? e.toObject() : { ...e };
  delete o.bank;
  delete o.statutory;
  return o;
};

router.get("/", permit("employee:read"), wrap(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.department && mongoose.isValidObjectId(req.query.department)) filter.department = req.query.department;
  if (req.query.search) {
    const escaped = String(req.query.search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { firstName: { $regex: escaped, $options: "i" } },
      { lastName: { $regex: escaped, $options: "i" } },
      { employeeCode: { $regex: escaped, $options: "i" } },
    ];
  }
  const [rows, total] = await Promise.all([
    Employee.find(filter).select("-bank -statutory")
      .populate("department", "code name")
      .populate("designation", "code name")
      .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Employee.countDocuments(filter),
  ]);
  res.json({ data: rows, total, page, limit });
}));

router.get('/:id/mobile-password', permit('employee:write'), wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid employee ID' });
  const employee = await Employee.findById(req.params.id).select('_id mobile status');
  if (!employee) return res.status(404).json({ message: 'Employee not found' });
  const credential = await MobileEmployeeCredential.findOne({ employee: employee._id })
    .select('passwordChangedAt mustChangePassword').lean();
  res.json({ configured: !!credential, passwordChangedAt: credential?.passwordChangedAt ?? null,
    mustChangePassword: credential?.mustChangePassword ?? false });
}));

const mobilePasswordSchema = z.object({ password: z.string().min(10).max(128) }).strict();
router.put('/:id/mobile-password', permit('employee:write'), wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid employee ID' });
  const parsed = mobilePasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Password must be 10-128 characters' });
  const employee = await Employee.findById(req.params.id).select('_id mobile status employeeCode');
  if (!employee) return res.status(404).json({ message: 'Employee not found' });
  if (employee.status !== 'ACTIVE') return res.status(409).json({ message: 'Only active employees can receive app passwords' });
  const mobile = String(employee.mobile || '').trim();
  if (!/^(?:\+91|91)?[6-9]\d{9}$/.test(mobile))
    return res.status(400).json({ message: 'Set a valid registered employee mobile number first' });
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const now = new Date();
  await MobileEmployeeCredential.findOneAndUpdate(
    { employee: employee._id },
    { $set: { passwordHash, passwordChangedAt: now, mustChangePassword: true,
      failedAttempts: 0, lockedUntil: null } },
    { upsert: true, new: true, runValidators: true }
  );
  await MobileDeviceSession.updateMany({ employee: employee._id, revokedAt: null },
    { $set: { revokedAt: now } });
  await audit(req, 'RESET_MOBILE_PASSWORD', 'Employee', employee.id, null,
    { employeeCode: employee.employeeCode });
  res.json({ message: 'App password saved. Existing mobile sessions revoked.', configured: true });
}));

router.get("/:id", permit("employee:read"), wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid employee ID' });
  const doc = await Employee.findById(req.params.id).select("-bank -statutory")
    .populate("department", "name code")
    .populate("designation", "name code");
  if (!doc) return res.status(404).json({ message: "Employee not found" });
  res.json(doc);
}));

router.post("/", permit("employee:write"), wrap(async (req, res) => {
  const { employeeNumber, ...data } = createSchema.parse(req.body);
  const employeeCode = employeeCodeFor(employeeNumber);
  if (Number(employeeNumber) === 0) return res.status(400).json({ message: "Employee ID must be greater than zero" });
  const [dept, desig] = await Promise.all([
    Department.exists({ _id: data.department, active: true }),
    Designation.exists({ _id: data.designation, active: true }),
  ]);
  if (!dept || !desig) return res.status(400).json({ message: "Invalid or inactive department/designation" });
  if (!data.email) delete data.email;
  if (await Employee.exists({ employeeCode })) return res.status(409).json({ message: "Employee ID already exists" });
  try {
    const doc = await Employee.create({ ...data, employeeCode, createdBy: req.user.id, updatedBy: req.user.id });
    await audit(req, "CREATE", "Employee", doc.id, null, { employeeCode: doc.employeeCode });
    return res.status(201).json(clean(doc));
  } catch (error) {
    if (error.code === 11000 && (error.keyPattern?.employeeCode || error.keyValue?.employeeCode))
      return res.status(409).json({ message: "Employee ID already exists" });
    throw error;
  }
}));

router.patch("/:id", permit("employee:write"), wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: "Invalid employee ID" });
  const { employeeNumber, ...data } = editSchema.parse(req.body);
  const before = await Employee.findById(req.params.id);
  if (!before) return res.status(404).json({ message: "Employee not found" });

  let newEmployeeCode = before.employeeCode;
  if (employeeNumber !== undefined) {
    if (Number(employeeNumber) === 0) return res.status(400).json({ message: "Employee ID must be greater than zero" });
    newEmployeeCode = employeeCodeFor(employeeNumber);
    if (newEmployeeCode !== before.employeeCode &&
        await Employee.exists({ employeeCode: newEmployeeCode, _id: { $ne: before._id } }))
      return res.status(409).json({ message: "Employee ID already exists" });
  }
  if (data.department && !await Department.exists({ _id: data.department, active: true }))
    return res.status(400).json({ message: "Invalid department" });
  if (data.designation && !await Designation.exists({ _id: data.designation, active: true }))
    return res.status(400).json({ message: "Invalid designation" });
  if (data.email === "") data.email = undefined;
  const changes = { ...data, updatedBy: req.user.id };
  if (employeeNumber !== undefined) changes.employeeCode = newEmployeeCode;
  let doc;
  try {
    doc = await Employee.findByIdAndUpdate(req.params.id, { $set: changes }, { new: true, runValidators: true });
  } catch (error) {
    if (error.code === 11000 && (error.keyPattern?.employeeCode || error.keyValue?.employeeCode))
      return res.status(409).json({ message: "Employee ID already exists" });
    throw error;
  }
  await audit(req, "UPDATE", "Employee", doc.id,
    { employeeCode: before.employeeCode },
    { employeeCode: doc.employeeCode, fields: Object.keys(changes) });
  res.json(clean(doc));
}));

router.patch("/:id/status", permit("employee:write"), wrap(async (req, res) => {
  const { status } = z.object({ status: z.enum(["ACTIVE", "INACTIVE", "EXITED"]) }).parse(req.body);
  const doc = await Employee.findByIdAndUpdate(req.params.id, { $set: { status, updatedBy: req.user.id } }, { new: true });
  if (!doc) return res.status(404).json({ message: "Employee not found" });
  await audit(req, "STATUS_CHANGE", "Employee", doc.id, null, { status });
  res.json(clean(doc));
}));

export default router;
