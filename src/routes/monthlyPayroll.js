
import { Router } from "express";
import { z } from "zod";
import { PayrollEligibility, PayrollPolicy } from "../models/PayrollExtras.js";
import { Employee } from "../models/index.js";
import SalaryRevision from "../models/EmployeeSalaryRevision.js";
import {
  MonthlyAttendance,
  PayrollDeductionRule,
  PayrollMonth,
  PayrollEntry,
} from "../models/MonthlyPayroll.js";
import { authenticate, permit } from "../middleware/auth.js";
import { asyncHandler as wrap } from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";

const router = Router();
router.use(authenticate);

const ym = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

const money = z.number().finite().min(0).max(100000000);
const toPaise = (n) => Math.round(Number(n) * 100);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const startOf = (y, m) => `${y}-${String(m).padStart(2, "0")}-01`;
const daysOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const sum = (items) => items.reduce((s, x) => s + x.amountPaise, 0);

const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });

// Legacy monthly approvals remain locked per employee, without data migration.
// New entries explicitly have status DRAFT, even in an old approved month.
function resolvedStatus(entry, period) {
  if (!entry) return "NOT_PROCESSED";
  if (entry.status === "PENDING_APPROVAL" || entry.status === "APPROVED") return entry.status;
  // Older entries have no status field; approved months lock them.
  if (!entry.status && period?.status === "APPROVED") return "APPROVED";
  if (!entry.status && period?.status === "PENDING_APPROVAL") return "PENDING_APPROVAL";
  return "DRAFT";
}
async function ensureEmployeeWritable(year, month, employeeId) {
  const period = await PayrollMonth.findOne({year, month}).lean();
  if (!period) return;
  const entry = await PayrollEntry.findOne({period:period._id,employee:employeeId}).lean();
  const status = resolvedStatus(entry, period);
  if (status !== "NOT_PROCESSED" && status !== "DRAFT") {
    throw fail("This employee's payroll is submitted or approved and locked",409);
  }
}

function attendanceCalc(a, calendarDays) {
  const presentDays = Number(a.presentDays || 0);
  const paidLeaveDays = Number(a.paidLeaveDays || 0);
  const unpaidLeaveDays = Number(a.unpaidLeaveDays || 0);
  const casualLeaveDays = Number(a.casualLeaveDays || 0);
  const weeklyOffDays = Number(a.weeklyOffDays || 0);
  const holidayDays = Number(a.holidayDays || 0);
  const lateMarks = Number(a.lateMarks || 0);
  const approvedOverDays = Number(a.approvedOverDays || 0);
  const halfDays = Number(a.halfDays || 0);

  const inputs = [
    presentDays, paidLeaveDays, unpaidLeaveDays,
    casualLeaveDays, weeklyOffDays, holidayDays,
    lateMarks, halfDays, approvedOverDays,
  ];

  if (inputs.some(v => !Number.isFinite(v) || v < 0)) {
    throw fail("Attendance numbers must be valid and nonnegative");
  }

  if (!Number.isInteger(halfDays) || halfDays > presentDays) {
    throw fail("Half days must be whole numbers and cannot exceed present days");
  }

  if (!Number.isInteger(lateMarks)) {
    throw fail("Late marks must be whole numbers");
  }

  const allocated =
    presentDays + paidLeaveDays + unpaidLeaveDays +
    weeklyOffDays + holidayDays;

  if (Math.abs(allocated - calendarDays) > 0.000001) {
    throw fail(`Attendance must total ${calendarDays} days`);
  }

  if (paidLeaveDays !== casualLeaveDays) {
    throw fail("Paid leave must equal casual leave");
  }

  const latePenaltyDays = lateMarks * 0.25;
  const halfDayPenaltyDays = halfDays * 0.5;
  const totalDeductionDays = round2(
    unpaidLeaveDays + latePenaltyDays + halfDayPenaltyDays
  );

  const payableBeforeOvertime = round2(
    presentDays + paidLeaveDays +
    weeklyOffDays + holidayDays - latePenaltyDays - halfDayPenaltyDays
  );

  const payableDays = round2(
    payableBeforeOvertime + approvedOverDays
  );

  if (
    payableBeforeOvertime < 0 ||
    payableDays < 0 ||
    payableDays > calendarDays + approvedOverDays
  ) {
    throw fail("Invalid payable days");
  }

  return {
    calendarDays,
    presentDays,
    paidLeaveDays,
    unpaidLeaveDays,
    casualLeaveDays,
    totalLeaves: paidLeaveDays + unpaidLeaveDays,
    weeklyOffDays,
    holidayDays,
    lateMarks,
    halfDays,
    halfDayPenaltyDays,
    latePenaltyDays,
    totalDeductionDays,
    approvedOverDays,
    payableBeforeOvertime,
    payableDays,
  };
}

// ====================================================
// ATTENDANCE APIs
// ====================================================

router.get("/attendance", permit("employee:read"), wrap(async (req, res) => {
  const { year, month } = ym.parse(req.query);
  const rows = await MonthlyAttendance.find({ year, month })
    .populate("employee", "employeeCode firstName lastName")
    .lean();
  res.json(rows);
}));

router.put(
  "/attendance/:employeeId",
  permit("employee:write"),
  wrap(async (req, res) => {
    const data = ym.extend({
      presentDays: z.number().finite().min(0),
      paidLeaveDays: z.number().finite().min(0).default(0),
      unpaidLeaveDays: z.number().finite().min(0).default(0),
      casualLeaveDays: z.number().finite().min(0).default(0),
      weeklyOffDays: z.number().finite().min(0).default(0),
      holidayDays: z.number().finite().min(0).default(0),
      lateMarks: z.number().int().min(0).default(0),
      halfDays: z.number().int().min(0).default(0),
      approvedOverDays: z.number().finite().min(0).max(31).default(0),
      notes: z.string().max(500).optional(),
    }).parse(req.body);

    await ensureEmployeeWritable(data.year, data.month, req.params.employeeId);

    if (data.approvedOverDays > 0 && req.user.role.code !== "ADMIN") {
      return res.status(403).json({
        message: "Admin must approve overtime days",
      });
    }

    const exists = await Employee.exists({ _id: req.params.employeeId });
    if (!exists) {
      return res.status(404).json({ message: "Employee not found" });
    }

    const calculation = attendanceCalc(
      data,
      daysOf(data.year, data.month)
    );

    const doc = await MonthlyAttendance.findOneAndUpdate(
      {
        employee: req.params.employeeId,
        year: data.year,
        month: data.month,
      },
      { $set: { ...data, updatedBy: req.user.id } },
      { upsert: true, new: true, runValidators: true }
    );

    await audit(
      req, "UPSERT", "MonthlyAttendance", doc.id,
      null, { payableDays: calculation.payableDays }
    );

    res.json({ ...doc.toObject(), calculation });
  })
);

// Old monetary overtime endpoints disabled.
router.get("/overtime", permit("employee:read"), wrap(async (_req, res) => {
  res.json([]);
}));

router.put("/overtime/:employeeId", permit("employee:write"), (_req, res) => {
  res.status(410).json({
    message: "Use approved overtime days in attendance",
  });
});

router.post("/overtime/:id/approve", permit("salary:write"), (_req, res) => {
  res.status(410).json({
    message: "Separate overtime payment is discontinued",
  });
});

// ====================================================
// DEDUCTION RULES
// ====================================================

router.get(
  "/deduction-rules",
  permit("config:read"),
  wrap(async (_req, res) => {
    res.json(await PayrollDeductionRule.find().sort({ code: 1 }).lean());
  })
);

router.post(
  "/deduction-rules",
  permit("config:write"),
  wrap(async (req, res) => {
    const data = z.object({
      code: z.string().regex(/^[A-Z0-9_]{2,30}$/),
      name: z.string().min(2),
      mode: z.enum(["FIXED", "PERCENT_GROSS"]),
      value: money,
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      enabled: z.boolean().default(true),
      notes: z.string().optional(),
    }).parse(req.body);

    if (data.mode === "PERCENT_GROSS" && data.value > 100) {
      return res.status(400).json({
        message: "Percentage cannot exceed 100",
      });
    }

    const doc = await PayrollDeductionRule.create(data);
    await audit(req, "CREATE", "DeductionRule", doc.id, null, data);
    res.status(201).json(doc);
  })
);

// ====================================================
// PAYROLL PERIOD APIs
// ====================================================

router.get("/periods", permit("employee:read"), wrap(async (_req, res) => {
  res.json(
    await PayrollMonth.find()
      .sort({ year: -1, month: -1 })
      .limit(100)
      .lean()
  );
}));

router.get(
  "/period/:year/:month",
  permit("employee:read"),
  wrap(async (req, res) => {
    const { year, month } = ym.parse(req.params);
    const period = await PayrollMonth.findOne({ year, month });
    const entries = period
      ? await PayrollEntry.find({ period: period.id })
          .sort({ employeeCode: 1 })
          .lean()
      : [];
    const annotatedEntries = entries.map(entry => ({
      ...entry, status: resolvedStatus(entry, period)
    }));
    res.json({ period, entries: annotatedEntries });
  })
);

// ====================================================
// CALCULATE PAYROLL — CTC INCLUSIVE OF EMPLOYER PF
// ====================================================

router.post(
  "/calculate",
  permit("salary:write"),
  wrap(async (req, res) => {
    const { year, month } = ym.parse(req.body);
    // Explicit employee selection is mandatory to protect other employees.
    const employeeId = z.string().regex(/^[0-9a-fA-F]{24}$/).parse(req.body.employeeId);
    await ensureEmployeeWritable(year, month, employeeId);

    const start = startOf(year, month);
    const calendarDays = daysOf(year, month);
const policy = await PayrollPolicy.findOne({
  enabled: true,
})
  .sort({
    createdAt: -1,
    _id: -1,
  })
  .lean();
    

    if (!policy) {
      return res.status(400).json({
        message: "No active payroll policy for selected month",
      });
    }

    const rules = await PayrollDeductionRule.find({
      enabled: true,
      effectiveFrom: { $lte: start },
      $or: [
        { effectiveTo: { $exists: false } },
        { effectiveTo: null },
        { effectiveTo: { $gte: start } },
      ],
    }).lean();

    const employees = await Employee.find({ status: "ACTIVE", _id: employeeId }).lean();
    if (!employees.length) throw fail("Active employee not found",404);

    const period = await PayrollMonth.findOneAndUpdate(
      { year, month },
      { $setOnInsert: { status: "DRAFT" } },
      { upsert: true, new: true }
    );

    let calculated = 0;
    const skipped = [];

    for (const employee of employees) {
      const [salary, attendance, eligibility] = await Promise.all([
        SalaryRevision.findOne({
          employee: employee._id,
          effectiveFrom: { $lte: start },
        }).sort({ effectiveFrom: -1 }).lean(),

        MonthlyAttendance.findOne({
          employee: employee._id, year, month,
        }).lean(),

        PayrollEligibility.findOne({
          employee: employee._id,
        }).lean(),
      ]);

      if (!salary || !attendance) {
        skipped.push({
          employeeCode: employee.employeeCode,
          reason: !salary ? "No salary structure" : "No attendance",
        });
        continue;
      }

      let a;
      try {
        a = attendanceCalc(attendance, calendarDays);
      } catch (error) {
        skipped.push({
          employeeCode: employee.employeeCode,
          reason: error.message,
        });
        continue;
      }

      // Salary structure's five amounts are a CTC budget.
      // First prorate that budget by payable days.
      const components = salary.items.map(item => {
        const monthlyPaise = toPaise(item.amount.toString());
        const earnedPaise = item.proratable
          ? Math.round(monthlyPaise * a.payableDays / calendarDays)
          : monthlyPaise;

        return {
          code: item.code,
          name: item.name,
          amountPaise: earnedPaise,
        };
      });

      const earnedCtcPaise = sum(components);

      const basic = components
        .filter(x => String(x.code).toUpperCase() === "BASIC")
        .reduce((s, x) => s + x.amountPaise, 0);

      const deductions = [];
      const employerContributions = [];

      let employeePf = 0;
      let employerPf = 0;

      if (eligibility?.pf) {
        if (basic <= 0) {
          skipped.push({
            employeeCode: employee.employeeCode,
            reason: "BASIC salary component missing",
          });
          continue;
        }

        employeePf = Math.round(
          basic * Number(policy.employeePfRate) / 100
        );

        employerPf = Math.round(
          basic * Number(policy.employerPfRate) / 100
        );

        deductions.push({
          code: "PF",
          name: "Employee PF",
          amountPaise: employeePf,
        });

        employerContributions.push({
          code: "EMPLOYER_PF",
          name: "Employer PF (included in CTC)",
          amountPaise: employerPf,
        });
      }

      // Reconcile the employer PF within CTC by adjusting
      // the OTHER allowance, while keeping BASIC unchanged.
      //
      // Do not represent employer PF as a wage deduction.
      const other = components.find(
        x => String(x.code).toUpperCase() === "OTHER"
      );

      if (employerPf > 0) {
        if (!other || other.amountPaise < employerPf) {
          skipped.push({
            employeeCode: employee.employeeCode,
            reason:
              "OTHER allowance is insufficient to absorb employer PF. " +
              "Review this employee's CTC structure.",
          });
          continue;
        }

        other.amountPaise -= employerPf;
      }

      // Components now reflect employee's actual gross
      // earnings rather than inclusive CTC.
      const earnedGrossPaise = sum(components);

      // Employer ESIC is not automatically removed from
      // CTC in this simplified structure. Flag ESIC-eligible
      // cases until CTC allocation is properly configured.
      if (eligibility?.esic) {
        skipped.push({
          employeeCode: employee.employeeCode,
          reason:
            "ESIC-eligible CTC requires separate employer ESIC " +
            "allocation before calculation",
        });
        continue;
      }

      if (eligibility?.pt) {
        deductions.push({
          code: "PT",
          name: "Professional Tax",
          amountPaise: toPaise(policy.ptAmount),
        });
      }

      if (eligibility?.tds) {
        deductions.push({
          code: "TDS",
          name: "Approved TDS",
          amountPaise: Number(eligibility.tdsAmountPaise || 0),
        });
      }

      const excluded = new Set([
        "PF", "EMPLOYER_PF", "ESIC",
        "EMPLOYER_ESIC", "PT", "TDS",
      ]);

      for (const rule of rules) {
        if (excluded.has(String(rule.code).toUpperCase())) continue;

        const amountPaise = rule.mode === "FIXED"
          ? toPaise(rule.value)
          : Math.round(
              earnedGrossPaise * Number(rule.value) / 100
            );

        deductions.push({
          code: rule.code,
          name: rule.name,
          amountPaise,
        });
      }

      const totalDeductionPaise = sum(deductions);
      const netPaise = earnedGrossPaise - totalDeductionPaise;

      if (netPaise < 0) {
        skipped.push({
          employeeCode: employee.employeeCode,
          reason: "Employee deductions exceed gross earnings",
        });
        continue;
      }

      const existingEntry = await PayrollEntry.findOne({
        period: period.id, employee: employee._id
      }).lean();
      if (resolvedStatus(existingEntry, period) !== "NOT_PROCESSED" &&
          resolvedStatus(existingEntry, period) !== "DRAFT") {
        skipped.push({employeeCode:employee.employeeCode,reason:"Employee payroll is locked"});
        continue;
      }
      const updatedEntry = await PayrollEntry.findOneAndUpdate(
        existingEntry
          ? {_id:existingEntry._id, status:existingEntry.status || {$exists:false}}
          : {period:period.id,employee:employee._id},
        {
          $set: {
            employeeCode: employee.employeeCode,
            employeeName:
              `${employee.firstName} ${employee.lastName}`,
            calendarDays,
            payableDays: a.payableDays,
            status: "DRAFT",

            // This field retains the original monthly
            // budget; it is now interpreted as monthly CTC.
            monthlyGrossPaise: toPaise(salary.monthlyGross.toString()),

            earnedGrossPaise,
            overtimePaise: 0,
            components,
            deductions,
            employerContributions,
            totalDeductionPaise,
            netPaise,

            attendanceSnapshot: {
              ...attendance,
              ...a,
              earnedCtcPaise,
            },

            policySnapshot: {
              ...policy,
              eligibility,
              pfBasis: "BASIC",
              salaryBasis: "CTC_INCLUSIVE_EMPLOYER_PF",
              employerPfIncludedInCtc: true,
            },

            salaryRevision: salary.revision,
            ruleSnapshot: rules.map(r => ({
              code: r.code,
              mode: r.mode,
              value: r.value,
              effectiveFrom: r.effectiveFrom,
            })),
          },
        },
        { upsert: !existingEntry, new: true, runValidators: true }
      );
      if (!updatedEntry) throw fail("Payroll status changed; refresh and retry",409);
      calculated++;
    }


    await audit(
      req, "CALCULATE", "PayrollMonth", period.id,
      null, { year, month, calculated, skipped: skipped.length }
    );

    res.json({ period, calculated, skipped });
  })
);

// ====================================================
// EMPLOYEE-WISE SUBMISSION AND APPROVAL
// ====================================================
router.post("/period/:year/:month/employee/:employeeId/submit", permit("salary:write"), wrap(async(req,res)=>{
  const {year,month}=ym.parse(req.params);
  const period=await PayrollMonth.findOne({year,month});
  if(!period)throw fail("Payroll period not found",404);
  const entry=await PayrollEntry.findOne({period:period._id,employee:req.params.employeeId}).lean();
  if(!entry || resolvedStatus(entry,period)!=="DRAFT")throw fail("Draft employee payroll not found",409);
  const updated=await PayrollEntry.findOneAndUpdate({_id:entry._id,status:"DRAFT"},{$set:{status:"PENDING_APPROVAL",submittedBy:req.user._id,submittedAt:new Date()}},{new:true});
  if(!updated)throw fail("Payroll status changed; refresh and retry",409);
  await audit(req,"SUBMIT","PayrollEntry",updated.id,{status:"DRAFT"},{status:"PENDING_APPROVAL",year,month,employeeId:req.params.employeeId});
  res.json(updated);
}));

router.post("/period/:year/:month/employee/:employeeId/approve", permit("salary:write"), wrap(async(req,res)=>{
  if(!["ADMIN","SUPER_ADMIN"].includes(req.user.role.code))throw fail("Admin approval required",403);
  const {year,month}=ym.parse(req.params);
  const period=await PayrollMonth.findOne({year,month});
  if(!period)throw fail("Payroll period not found",404);
  const entry=await PayrollEntry.findOneAndUpdate({period:period._id,employee:req.params.employeeId,status:"PENDING_APPROVAL"},{$set:{status:"APPROVED",approvedBy:req.user._id,approvedAt:new Date()}},{new:true});
  if(!entry)throw fail("Employee payroll must be submitted first",409);
  await audit(req,"APPROVE","PayrollEntry",entry.id,{status:"PENDING_APPROVAL"},{status:"APPROVED",year,month,employeeId:req.params.employeeId});
  res.json(entry);
}));

// Do not allow the legacy bulk endpoints to bypass employee-wise approval.
router.post("/period/:year/:month/submit", permit("salary:write"), (_req,res)=>{
  res.status(409).json({message:"Use employee-wise submit endpoint"});
});
router.post("/period/:year/:month/approve", permit("salary:write"), (_req,res)=>{
  res.status(409).json({message:"Use employee-wise approve endpoint"});
});

export default router;
