import {EmployeeInsurance,AdvanceRecovery,PayrollOperation} from "../models/PayrollOperations.js";

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

// Only allowances explicitly approved by HR as CTC-adjustable may absorb
// employer costs. By default, only OTHER is flexible (existing behavior).
// Example after HR approval: CTC_ADJUSTABLE_COMPONENT_CODES=OTHER,CONVEYANCE,MEDICAL
const adjustableCtcCodes = new Set(
  (process.env.CTC_ADJUSTABLE_COMPONENT_CODES || "OTHER")
    .split(",").map(code => code.trim().toUpperCase()).filter(Boolean)
);
// BASIC and statutory contributions must never be treated as flexible allowances.
for (const code of ["BASIC", "PF", "ESIC", "EMPLOYER_PF", "EMPLOYER_ESIC", "PT", "TDS"]) {
  adjustableCtcCodes.delete(code);
}

function allocateEmployerCtc(components, employerCostPaise) {
  let outstanding = employerCostPaise;
  const allocations = [];
  for (const component of components) {
    const code = String(component.code || "").toUpperCase();
    if (!adjustableCtcCodes.has(code) || outstanding <= 0) continue;
    const deducted = Math.min(outstanding, Math.max(0, component.amountPaise));
    component.amountPaise -= deducted;
    outstanding -= deducted;
    if (deducted) allocations.push({ code, amountPaise: deducted });
  }
  return { outstanding, allocations };
}

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

// Apply one paid CL against an existing leave day only after at least
// 20 equivalent days of attendance, counting two half-days as one day.
function grantEligibleCasualLeave(a) {
  const worked = Number(a.presentDays || 0) - Number(a.halfDays || 0) * 0.5;
  const alreadyPaid = Number(a.casualLeaveDays || 0);
  const unpaid = Number(a.unpaidLeaveDays || 0);
  if (worked >= 20 && alreadyPaid === 0 &&
      Number(a.paidLeaveDays || 0) === 0 && unpaid >= 1) {
    return {...a,casualLeaveDays:1,paidLeaveDays:1,unpaidLeaveDays:unpaid-1};
  }
  return a;
}
function attendanceCalc(a, calendarDays) {
  const presentDays = Number(a.presentDays || 0);
  const paidLeaveDays = Number(a.paidLeaveDays || 0);
  const unpaidLeaveDays = Number(a.unpaidLeaveDays || 0);
  const casualLeaveDays = Number(a.casualLeaveDays || 0);
  const weeklyOffDays = Number(a.weeklyOffDays || 0);
  const holidayDays = Number(a.holidayDays || 0);
  const lateMarks = Number(a.lateMarks || 0);
  const earlyLeaves = Number(a.earlyLeaves || 0);
  const approvedOverDays = Number(a.approvedOverDays || 0);
  const halfDays = Number(a.halfDays || 0);

  const inputs = [
    presentDays, paidLeaveDays, unpaidLeaveDays,
    casualLeaveDays, weeklyOffDays, holidayDays,
    lateMarks, earlyLeaves, halfDays, approvedOverDays,
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
  if (!Number.isInteger(earlyLeaves) || earlyLeaves > presentDays - halfDays) {
    throw fail("Early leaves must be a whole number no greater than full attendance days (excluding half-days)");
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
  
  // ============================================
  // CASUAL LEAVE ELIGIBILITY VALIDATION
  // Minimum 20 actual working days = 1 paid CL
  // ============================================

  const actualWorkedDays = presentDays - (halfDays * 0.5);

  const allowedCasualLeave =
    actualWorkedDays >= 20 ? 1 : 0;

  if (!Number.isInteger(casualLeaveDays) || !Number.isInteger(paidLeaveDays)) {
    throw fail("Casual leave must be either 0 or 1 whole day");
  }
  if (casualLeaveDays > allowedCasualLeave) {
    throw fail(
      actualWorkedDays < 20
        ? `Casual Leave not allowed. Employee worked only ${actualWorkedDays} days. Minimum 20 working days required.`
        : "Maximum 1 paid Casual Leave is allowed per month."
    );
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
    casualLeaveEligible: actualWorkedDays >= 20,
    workedEquivalentDays: actualWorkedDays,
    totalLeaves: paidLeaveDays + unpaidLeaveDays,
    weeklyOffDays,
    holidayDays,
    lateMarks,
    earlyLeaves,
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
      earlyLeaves: z.number().int().min(0).default(0),
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

    // One paid CL is applied to an existing leave day after 20 equivalent
    // days actually worked (two half-days count as one). Never create an
    // extra attendance day or overwrite a locked employee payroll.
    Object.assign(data, grantEligibleCasualLeave(data));
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
        const normalizedAttendance = grantEligibleCasualLeave(attendance);
        a = attendanceCalc(normalizedAttendance, calendarDays);
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
      // Reference amounts only: these do not alter statutory deductions.
      const basicBasedContributions = {
        employeePfPaise: eligibility?.pf ? Math.round(basic * Number(policy.employeePfRate) / 100) : 0,
        employerPfPaise: eligibility?.pf ? Math.round(basic * Number(policy.employerPfRate) / 100) : 0,
        employeeEsicPaise: eligibility?.esic ? Math.round(basic * Number(policy.employeeEsicRate) / 100) : 0,
        employerEsicPaise: eligibility?.esic ? Math.round(basic * Number(policy.employerEsicRate) / 100) : 0,
      };

      // Excel comparison: earned CTC used as ESIC reference wage base.
      // Employer shares remain employer costs, not employee wage deductions.
      const excelCalculation = {
        salaryToBeGivenPaise: earnedCtcPaise,
        employeePfPaise: basicBasedContributions.employeePfPaise,
        employerPfPaise: basicBasedContributions.employerPfPaise,
        employeeEsicPaise: eligibility?.esic ? Math.round(earnedCtcPaise * Number(policy.employeeEsicRate) / 100) : 0,
        employerEsicPaise: eligibility?.esic ? Math.round(earnedCtcPaise * Number(policy.employerEsicRate) / 100) : 0,
      };

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

      // Employer costs remain part of the agreed CTC, not employee deductions.
      // Spreadsheet reconciliation uses the pre-allocation earned CTC as its
      // ESIC percentage base. Before statutory filing, HR must verify that
      // this amount is also the employee's legally applicable ESIC wages.
      let employerEsic = 0;
      let employeeEsic = 0;
   if (eligibility?.esic) {
  // ESIC applicability is determined through the
  // employee's HR-maintained statutory eligibility record.
  // Do not reject payroll based on monthly CTC.

  const empRate = Number(policy.employerEsicRate) / 100;
        const employeeRate = Number(policy.employeeEsicRate) / 100;
        if (![empRate, employeeRate].every(r => Number.isFinite(r) && r >= 0 && r <= 1)) {
          skipped.push({ employeeCode: employee.employeeCode, reason: "Invalid ESIC policy rates" });
          continue;
        }
        // Excel calculation: salary to be given x employer ESIC percentage.
        employerEsic = Math.round(earnedCtcPaise * empRate);
      }
      const employerCtcCostPaise = employerPf + employerEsic;
      const { outstanding, allocations: employerCtcAllocations } =
        allocateEmployerCtc(components, employerCtcCostPaise);
      if (outstanding > 0) {
        skipped.push({ employeeCode: employee.employeeCode,
          reason: `Insufficient HR-approved adjustable CTC allowances: ₹${(outstanding / 100).toFixed(2)} short for employer PF/ESIC. Review salary structure or approved adjustable allowance codes.` });
        continue;
      }
      if (eligibility?.esic) {
        employerContributions.push({ code: "EMPLOYER_ESIC",
          name: "Employer ESIC (included in CTC)", amountPaise: employerEsic });
        // Excel calculation: salary to be given x employee ESIC percentage.
        // Do not calculate on the gross AFTER employer CTC allocation.
        employeeEsic = Math.round(earnedCtcPaise * Number(policy.employeeEsicRate) / 100);
        deductions.push({ code: "ESIC", name: "Employee ESIC", amountPaise: employeeEsic });
      }
      const finalEarnedGrossPaise = sum(components);

      // Requested company PT configuration. Validate state statutory obligations separately.
      if (eligibility?.pt && String(employee.gender||'').trim().toUpperCase()==='MALE') {
        const amountPaise=toPaise(policy.ptAmount ?? 200);
        if(amountPaise)deductions.push({code:'PT',name:'Professional Tax',amountPaise});
      }
      if (eligibility?.tds) {
        const rate = Number(eligibility.tdsPercent ?? 0);
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
          skipped.push({employeeCode:employee.employeeCode,reason:"Invalid TDS percentage"});
          continue;
        }
        // Gross-based configured withholding estimate; not a substitute for annual statutory TDS computation.
        const amountPaise = Math.round(finalEarnedGrossPaise * rate / 100);
        if (amountPaise) deductions.push({code:"TDS",name:`TDS (${rate}%)`,amountPaise});
      }

      const excluded = new Set([
        "PF", "EMPLOYER_PF", "ESIC",
        "EMPLOYER_ESIC", "PT", "TDS", "INSURANCE", "ADVANCE_RECOVERY", "SITE_LATE", "EARLY_LEAVE",
      ]);

      for (const rule of rules) {
        if (excluded.has(String(rule.code).toUpperCase())) continue;

        const amountPaise = rule.mode === "FIXED"
          ? toPaise(rule.value)
          : Math.round(
              finalEarnedGrossPaise * Number(rule.value) / 100
            );

        deductions.push({
          code: rule.code,
          name: rule.name,
          amountPaise,
        });
      }

      // Additional approved operational records are additive to the existing
      // salary/CTC logic. TA is deliberately excluded from payroll.
      const periodStart = startOf(year, month);
      const periodEnd = `${year}-${String(month).padStart(2, "0")}-${String(calendarDays).padStart(2, "0")}`;
      const [insurance, recoveries, operations] = await Promise.all([
        EmployeeInsurance.findOne({employee:employee._id,active:true,effectiveFrom:{$lte:periodEnd},$or:[{effectiveTo:null},{effectiveTo:{$exists:false}},{effectiveTo:{$gte:periodStart}}]}).sort({effectiveFrom:-1}).lean(),
        AdvanceRecovery.find({employee:employee._id,year,month,status:"APPROVED"}).lean(),
        PayrollOperation.find({employee:employee._id,date:{$gte:periodStart,$lte:periodEnd},status:"APPROVED"}).sort({date:1}).lean(),
      ]);
      const insurancePaise = insurance?.amountPaise ?? toPaise(policy.insuranceAmount ?? 0);
      if (eligibility?.insurance && String(employee.gender || "").trim().toUpperCase() === "MALE" && insurancePaise > 0) deductions.push({code:"INSURANCE",name:"Employee insurance",amountPaise:insurancePaise});
      const advancePaise = recoveries.reduce((v,r)=>v+r.amountPaise,0);
      if (advancePaise) deductions.push({code:"ADVANCE_RECOVERY",name:"Approved advance recovery",amountPaise:advancePaise});
      // OT starts after 20:00; rate = monthly BASIC / (26 x 8), 1x.
      // An explicit hours value is required, with an approved site record.
      const monthlyBasicPaise = salary.items.filter(i=>String(i.code).toUpperCase()==="BASIC").reduce((v,i)=>v+toPaise(i.amount.toString()),0);
      if(a.approvedOverDays>0 && operations.some(o=>o.type==="OVERTIME")){
        skipped.push({employeeCode:employee.employeeCode,reason:"Both legacy overtime days and hourly overtime exist; resolve duplicate overtime before calculating"});
        continue;
      }
      const overtimePaise = operations.filter(o=>o.type==="OVERTIME").reduce((v,o)=>v+Math.round(monthlyBasicPaise*o.hours/(26*8)),0);
      // Eligible days are counted per trip, including earlier months.
      // Sundays never count toward the first four eligible days or allowance.
      const tripIds = [...new Set(operations.filter(o=>o.type==="OUTSTATION").map(o=>o.tripId).filter(Boolean))];
      const historicalTripDays = tripIds.length ? await PayrollOperation.find({employee:employee._id,type:"OUTSTATION",status:"APPROVED",tripId:{$in:tripIds},date:{$lte:periodEnd}}).sort({date:1}).lean() : [];
      const tripDayRanks = new Map();
      const eligibleTripDays = new Set();
      for(const o of historicalTripDays){
        if(new Date(o.date+"T00:00:00Z").getUTCDay()===0)continue;
        const n=(tripDayRanks.get(o.tripId)||0)+1;
        tripDayRanks.set(o.tripId,n);
        if(n>Number(policy.outstationFreeDays ?? 3))eligibleTripDays.add(String(o._id));
      }
      const outstationCount = operations.filter(o=>o.type==="OUTSTATION"&&eligibleTripDays.has(String(o._id))).length;
      const monthlyCtcPaise = toPaise(salary.monthlyGross.toString());
      const monthlyEmployerPfPaise = eligibility?.pf ? Math.round(monthlyBasicPaise*Number(policy.employerPfRate)/100) : 0;
      const monthlyEmployerEsicPaise = employerContributions.filter(x=>x.code==="EMPLOYER_ESIC").reduce((v,x)=>v+x.amountPaise,0);
      // All per-day employee allowances and CL bonus use configured Monthly Gross,
      // e.g. ₹31,000 / 31 days = ₹1,000. Employer costs are handled separately.
      const monthlyGrossForOutstation = monthlyCtcPaise;
      const outstationPaise = Math.round(outstationCount*(Number(policy.outstationGrossPercent ?? 20)/100)*monthlyGrossForOutstation/calendarDays);
      // Manual monthly early-leave count and approved site operations represent the
      // same category. Use the larger count, NEVER add both (prevents double penalty).
      // Before-4PM checkouts already recorded as half-days must not be included.
      const approvedEarlyCount = operations.filter(o=>o.type==="EARLY_LEAVE").length;
      const earlyCount = Math.max(a.earlyLeaves, approvedEarlyCount);
      const earlyPenaltyPaise = Math.round(Math.max(0,earlyCount-Number(policy.earlyLeaveFreeCount ?? 2))*(Number(policy.earlyLeavePenaltyPercent ?? 25)/100)*monthlyGrossForOutstation/calendarDays);
      if(earlyPenaltyPaise) deductions.push({code:"EARLY_LEAVE",name:"Early-leave penalty",amountPaise:earlyPenaltyPaise});
      const sitePenaltyPaise = operations.filter(o=>o.type==="SITE_LATE").reduce((v,o)=>v+o.amountPaise,0);
      if(sitePenaltyPaise) deductions.push({code:"SITE_LATE",name:"Approved site late penalty",amountPaise:sitePenaltyPaise});
      const cleanMonth = a.workedEquivalentDays >= 20 && a.unpaidLeaveDays===0 && a.paidLeaveDays===0 && a.halfDays===0 && a.lateMarks===0 && a.payableBeforeOvertime===calendarDays && earlyCount===0 && sitePenaltyPaise===0;
      // The configured monthlyGross is inclusive CTC in this system. For the CL
      // daily GROSS wage basis, exclude employer PF/ESIC embedded in that CTC.
      // Employer ESIC is estimated at full-month wages, not prorated overtime.
      const fullMonthEsicRate = eligibility?.esic ? Number(policy.employerEsicRate)/100 : 0;
      const monthlyEmployerEsicForClPaise = fullMonthEsicRate > 0
        ? Math.round(Math.max(0, monthlyCtcPaise-monthlyEmployerPfPaise)*fullMonthEsicRate/(1+fullMonthEsicRate)) : 0;
      const monthlyEmployeeGrossPaise = Math.max(0, monthlyCtcPaise-monthlyEmployerPfPaise-monthlyEmployerEsicForClPaise);
      const clBonusPaise = cleanMonth ? Math.round(monthlyEmployeeGrossPaise/calendarDays) : 0;
      if(clBonusPaise)components.push({code:'CL_EXTRA_DAY',name:'Unused Casual Leave Payment',amountPaise:clBonusPaise});
      if(overtimePaise)components.push({code:'OT_EARNING',name:'Approved overtime',amountPaise:overtimePaise});
      if(outstationPaise)components.push({code:'OUTSTATION_ALLOWANCE',name:'Outstation allowance',amountPaise:outstationPaise});
      const extraEarningsPaise = overtimePaise+outstationPaise+clBonusPaise;
      const totalDeductionPaise = sum(deductions);
      const netPaise = finalEarnedGrossPaise + extraEarningsPaise - totalDeductionPaise;

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
            status: "APPROVED",
            approvedBy: req.user._id || req.user.id,
            approvedAt: new Date(),

            // This field retains the original monthly
            // budget; it is now interpreted as monthly CTC.
            monthlyGrossPaise: toPaise(salary.monthlyGross.toString()),

            earnedGrossPaise: finalEarnedGrossPaise + extraEarningsPaise,
            overtimePaise,
            components,
            deductions,
            employerContributions,
            employeePfPaise: deductions.filter(x=>x.code==='PF').reduce((n,x)=>n+x.amountPaise,0),
            employerPfPaise: employerContributions.filter(x=>x.code==='EMPLOYER_PF').reduce((n,x)=>n+x.amountPaise,0),
            employeeEsicPaise: deductions.filter(x=>x.code==='ESIC').reduce((n,x)=>n+x.amountPaise,0),
            employerEsicPaise: employerContributions.filter(x=>x.code==='EMPLOYER_ESIC').reduce((n,x)=>n+x.amountPaise,0),
            totalDeductionPaise,
            netPaise,

            attendanceSnapshot: {
              ...attendance,
              ...a,
              payableDaysWithClBonus: a.payableDays + (clBonusPaise>0?1:0),
              earnedCtcPaise,
              operationalEarnings: {overtimePaise,outstationPaise,clBonusPaise},
              operationalDeductions: {insurancePaise:eligibility?.insurance&&String(employee.gender||"").toUpperCase()==="MALE"?insurancePaise:0,advancePaise,earlyPenaltyPaise,sitePenaltyPaise},
            },

            policySnapshot: {
              ...policy,
              eligibility,
              pfBasis: "BASIC",
              salaryBasis: "CTC_INCLUSIVE_EMPLOYER_PF",
              employerPfIncludedInCtc: true,
              basicBasedContributions,
              excelCalculation,
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
      await audit(req, "FINALIZE", "PayrollEntry", updatedEntry.id, null, {year,month,employeeId: String(employee._id), automatic: true});
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
