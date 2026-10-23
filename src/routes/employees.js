import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { Employee, Department, Designation } from "../models/index.js";
import { authenticate, permit } from "../middleware/auth.js";
import { asyncHandler as wrap } from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";

const router = Router();
router.use(authenticate);
const optionalText = z.string().trim().max(200).optional();

// Existing employee fields and validation are unchanged.
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

// Manual number is required only when creating an employee.
// PATCH deliberately does not allow changing an established employee ID.
const createSchema = schema.extend({
  employeeNumber: z.string().regex(/^[0-9]{1,5}$/, "Enter 1 to 5 digits for Employee ID"),
});

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
  if (req.query.department && mongoose.isValidObjectId(req.query.department)) {
    filter.department = req.query.department;
  }
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

router.get("/:id", permit("employee:read"), wrap(async (req, res) => {
  const doc = await Employee.findById(req.params.id).select("-bank -statutory")
    .populate("department", "name code")
    .populate("designation", "name code");
  if (!doc) return res.status(404).json({ message: "Employee not found" });
  res.json(doc);
}));

router.post("/", permit("employee:write"), wrap(async (req, res) => {
  const { employeeNumber, ...data } = createSchema.parse(req.body);
  const employeeCode = "TT/E/" + employeeNumber.padStart(5, "0");
  if (Number(employeeNumber) === 0) {
    return res.status(400).json({ message: "Employee ID must be greater than zero" });
  }
  const [dept, desig] = await Promise.all([
    Department.exists({ _id: data.department, active: true }),
    Designation.exists({ _id: data.designation, active: true }),
  ]);
  if (!dept || !desig) {
    return res.status(400).json({ message: "Invalid or inactive department/designation" });
  }
  if (!data.email) delete data.email;
  if (await Employee.exists({ employeeCode })) {
    return res.status(409).json({ message: "Employee ID already exists" });
  }
  try {
    const doc = await Employee.create({
      ...data, employeeCode, createdBy: req.user.id, updatedBy: req.user.id,
    });
    await audit(req, "CREATE", "Employee", doc.id, null, { employeeCode: doc.employeeCode });
    return res.status(201).json(clean(doc));
  } catch (error) {
    // Also guard against concurrent submissions of the same employee ID.
    if (error.code === 11000 && (error.keyPattern?.employeeCode || error.keyValue?.employeeCode)) {
      return res.status(409).json({ message: "Employee ID already exists" });
    }
    throw error;
  }
}));

router.patch("/:id", permit("employee:write"), wrap(async (req, res) => {
  const data = schema.partial().parse(req.body);
  const before = await Employee.findById(req.params.id);
  if (!before) return res.status(404).json({ message: "Employee not found" });
  if (data.department && !await Department.exists({ _id: data.department, active: true })) {
    return res.status(400).json({ message: "Invalid department" });
  }
  if (data.designation && !await Designation.exists({ _id: data.designation, active: true })) {
    return res.status(400).json({ message: "Invalid designation" });
  }
  if (data.email === "") data.email = undefined;
  const doc = await Employee.findByIdAndUpdate(req.params.id, {
    $set: { ...data, updatedBy: req.user.id },
  }, { new: true, runValidators: true });
  await audit(req, "UPDATE", "Employee", doc.id,
    { employeeCode: before.employeeCode }, { fields: Object.keys(data) });
  res.json(clean(doc));
}));

router.patch("/:id/status", permit("employee:write"), wrap(async (req, res) => {
  const { status } = z.object({
    status: z.enum(["ACTIVE", "INACTIVE", "EXITED"]),
  }).parse(req.body);
  const doc = await Employee.findByIdAndUpdate(req.params.id, {
    $set: { status, updatedBy: req.user.id },
  }, { new: true });
  if (!doc) return res.status(404).json({ message: "Employee not found" });
  await audit(req, "STATUS_CHANGE", "Employee", doc.id, null, { status });
  res.json(clean(doc));
}));

export default router;
