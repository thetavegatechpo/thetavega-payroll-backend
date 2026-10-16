
import { Router } from "express";
import { z } from "zod";

import {
  PayrollEligibility,
  PayrollPolicy,
} from "../models/PayrollExtras.js";

import {
  authenticate,
  permit,
} from "../middleware/auth.js";

import { asyncHandler as wrap } from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";

const router = Router();

router.use(authenticate);

// Employee payroll eligibility - unchanged
const eligible = z.object({
  pf: z.boolean(),
  esic: z.boolean(),
  pt: z.boolean(),
  tds: z.boolean(),
  tdsAmountPaise: z.number().int().min(0).default(0),
}).strict();

// Get employee eligibility
router.get(
  "/eligibility/:employeeId",
  permit("employee:read"),
  wrap(async (req, res) => {
    const doc = await PayrollEligibility.findOne({
      employee: req.params.employeeId,
    });

    res.json(
      doc || {
        employee: req.params.employeeId,
        pf: false,
        esic: false,
        pt: false,
        tds: false,
        tdsAmountPaise: 0,
      }
    );
  })
);

// Update employee eligibility
router.put(
  "/eligibility/:employeeId",
  permit("salary:write"),
  wrap(async (req, res) => {
    const data = eligible.parse(req.body);

    const doc = await PayrollEligibility.findOneAndUpdate(
      { employee: req.params.employeeId },
      {
        $set: {
          ...data,
          updatedBy: req.user.id,
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
      }
    );

    await audit(
      req,
      "UPSERT",
      "PayrollEligibility",
      doc.id,
      null,
      {
        employee: req.params.employeeId,
        ...data,
      }
    );

    res.json(doc);
  })
);

// Payroll policy validation - no effective dates
const rule = z.object({
  code: z.string().regex(/^[A-Z0-9_]{2,40}$/),

  employeePfRate: z.number().min(0).max(100),
  employerPfRate: z.number().min(0).max(100),

  employeeEsicRate: z.number().min(0).max(100),
  employerEsicRate: z.number().min(0).max(100),

  esicWageCeiling: z.number().min(0),
  ptAmount: z.number().min(0),

  casualLeaveAccrual: z.number().min(0).max(31),

  lateMarksPerPenalty: z.number().int().min(1),
  latePenaltyDays: z.number().min(0).max(31),

  enabled: z.boolean().default(true),

  notes: z.string().max(500).optional(),
}).strict();

// Get payroll policies - latest first
router.get(
  "/policies",
  permit("config:read"),
  wrap(async (req, res) => {
    const policies = await PayrollPolicy.find()
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    res.json(policies);
  })
);

// Create payroll policy - Admin only
router.post(
  "/policies",
  permit("config:write"),
  wrap(async (req, res) => {
    if (req.user.role.code !== "ADMIN") {
      return res.status(403).json({
        message: "Admin required",
      });
    }

    const data = rule.parse(req.body);

    const doc = await PayrollPolicy.create(data);

    await audit(
      req,
      "CREATE",
      "PayrollPolicy",
      doc.id,
      null,
      data
    );

    res.status(201).json(doc);
  })
);

export default router;
