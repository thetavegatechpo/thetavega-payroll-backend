
import { Router } from "express";
import {
  PayrollMonth,
  PayrollEntry,
} from "../models/MonthlyPayroll.js";

import {
  Employee,
  Setting,
} from "../models/index.js";

import {
  authenticate,
  permit,
} from "../middleware/auth.js";

import { asyncHandler as wrap } from "../utils/asyncHandler.js";

const router = Router();

router.use(authenticate, permit("employee:read"));

// =====================================================
// HELPERS
// =====================================================

const amount = (value) => {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
};

const sumAmounts = (items = []) =>
  items.reduce(
    (total, item) => total + amount(item.amountPaise),
    0
  );

const getAmountByCode = (items = [], code) =>
  items
    .filter(
      (item) =>
        String(item.code || "").toUpperCase() === code
    )
    .reduce(
      (total, item) => total + amount(item.amountPaise),
      0
    );

// =====================================================
// BUILD PAYSLIP BREAKDOWN
// Amounts are expressed in paise.
// Uses approved payroll snapshot values.
// =====================================================

function buildBreakdown(entry) {
  const earnings = entry.components || [];
  const deductions = entry.deductions || [];
  const employerContributions =
    entry.employerContributions || [];

  const employeePfPaise = getAmountByCode(
    deductions,
    "PF"
  );

  const employerPfPaise = getAmountByCode(
    employerContributions,
    "EMPLOYER_PF"
  );

  const employeeEsicPaise = getAmountByCode(
    deductions,
    "ESIC"
  );

  const employerEsicPaise = getAmountByCode(
    employerContributions,
    "EMPLOYER_ESIC"
  );

  const ptPaise = getAmountByCode(deductions, "PT");
  const tdsPaise = getAmountByCode(deductions, "TDS");

  const earnedGrossPaise = amount(entry.earnedGrossPaise);

  const totalEmployeeDeductionsPaise =
    sumAmounts(deductions);

  const totalEmployerContributionsPaise =
    sumAmounts(employerContributions);

  const netSalaryPaise = amount(entry.netPaise);

  // Employer contribution is informational and
  // must not reduce employee net salary.
  const combinedPfPaise =
    employeePfPaise + employerPfPaise;

  return {
    calendarDays: amount(entry.calendarDays),
    payableDays: amount(entry.payableDays),

    earnings,

    earnedGrossPaise,

    employeePfPaise,
    employerPfPaise,
    combinedPfPaise,

    employeeEsicPaise,
    employerEsicPaise,

    ptPaise,
    tdsPaise,

    deductions,
    employerContributions,

    totalEmployeeDeductionsPaise,
    totalEmployerContributionsPaise,

    // Preserve approved take-home pay.
    netSalaryPaise,

    // Informational employer cost summary.
    grossPlusEmployerCostPaise:
      earnedGrossPaise + totalEmployerContributionsPaise,
  };
}

// =====================================================
// GET APPROVED EMPLOYEE PAYSLIP
// GET /:year/:month/:employeeId
// =====================================================

router.get(
  "/:year/:month/:employeeId",
  wrap(async (req, res) => {
    const year = Number(req.params.year);
    const month = Number(req.params.month);

    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      year < 2020 ||
      year > 2100 ||
      month < 1 ||
      month > 12
    ) {
      return res.status(400).json({
        message: "Invalid payroll period",
      });
    }

    const period = await PayrollMonth.findOne({
      year,
      month,
    });

    if (!period) {
      return res.status(404).json({
        message: "Approved period not found",
      });
    }

    const [entry, employee, settings] = await Promise.all([
      PayrollEntry.findOne({
        period: period.id,
        employee: req.params.employeeId,
      }).lean(),

      Employee.findById(req.params.employeeId)
        .select(
          "employeeCode firstName lastName designation department"
        )
        .populate("designation", "name")
        .populate("department", "name")
        .lean(),

      Setting.find({
        key: {
          $in: [
            "companyName",
            "companyAddress",
            "companyPhone",
            "companyEmail",
            "companyCIN",
          ],
        },
      }).lean(),
    ]);

    const isEntryApproved = entry && (
      entry.status === "APPROVED" ||
      (!entry.status && period.status === "APPROVED")
    );
    if (!isEntryApproved) {
      return res.status(404).json({ message: "Approved employee payslip not found" });
    }

    if (!entry || !employee) {
      return res.status(404).json({
        message: "Payslip not found",
      });
    }

    const breakdown = buildBreakdown(entry);

    res.json({
      success: true,

      period: {
        year,
        month,
        approvedAt: entry.approvedAt || period.approvedAt,
        status: "APPROVED",
      },

      employee: {
        employeeCode: employee.employeeCode,
        name: `${employee.firstName} ${employee.lastName}`,
        designation: employee.designation?.name || "",
        department: employee.department?.name || "",
      },

      company: Object.fromEntries(
        settings.map((setting) => [
          setting.key,
          setting.value,
        ])
      ),

      entry,

      breakdown,
    });
  })
);

// =====================================================
// EMPLOYEE SALARY STATEMENT
// GET /statement/:employeeId?from=2026-08&to=2026-10
// =====================================================

router.get(
  "/statement/:employeeId",
  wrap(async (req, res) => {
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");

    if (
      !/^\d{4}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}$/.test(to) ||
      from > to
    ) {
      return res.status(400).json({
        message: "Use from/to YYYY-MM",
      });
    }

    const fromYear = Number(from.slice(0, 4));
    const fromMonth = Number(from.slice(5, 7));
    const toYear = Number(to.slice(0, 4));
    const toMonth = Number(to.slice(5, 7));

    if (
      fromMonth < 1 ||
      fromMonth > 12 ||
      toMonth < 1 ||
      toMonth > 12
    ) {
      return res.status(400).json({
        message: "Invalid month",
      });
    }

    const periods = await PayrollMonth.find({
      $expr: {
        $and: [
          {
            $gte: [
              {
                $add: [
                  { $multiply: ["$year", 100] },
                  "$month",
                ],
              },
              Number(from.replace("-", "")),
            ],
          },
          {
            $lte: [
              {
                $add: [
                  { $multiply: ["$year", 100] },
                  "$month",
                ],
              },
              Number(to.replace("-", "")),
            ],
          },
        ],
      },
    })
      .sort({ year: 1, month: 1 })
      .lean();

    if (periods.length > 36) {
      return res.status(400).json({
        message: "Maximum 36 months",
      });
    }

    const entries = await PayrollEntry.find({
      employee: req.params.employeeId,
      period: {
        $in: periods.map((period) => period._id),
      },
    }).lean();

    const entryMap = new Map(
      entries.filter((entry) => entry.status === "APPROVED" ||
        (periods.some(p => String(p._id) === String(entry.period) && p.status === "APPROVED") &&
         !entry.submittedAt && !entry.approvedAt && !entry.status)).map((entry) => [
        String(entry.period),
        entry,
      ])
    );

    const statement = periods.map((period) => {
      const entry =
        entryMap.get(String(period._id)) || null;

      return {
        year: period.year,
        month: period.month,

        entry,

        breakdown: entry
          ? buildBreakdown(entry)
          : null,
      };
    });

    res.json({
      periods: statement,
    });
  })
);

export default router;
