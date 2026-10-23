
import mongoose from "mongoose";

const { Schema } = mongoose;

// Employee payroll eligibility — unchanged
const eligibility = new Schema(
  {
    employee: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      unique: true,
    },
    pf: { type: Boolean, default: false },
    esic: { type: Boolean, default: false },
    pt: { type: Boolean, default: false },
    insurance: { type: Boolean, default: false },
    tds: { type: Boolean, default: false },
    tdsPercent: { type: Number, default: 0, min: 0, max: 100 },
    tdsAmountPaise: {
      type: Number,
      default: 0,
      min: 0,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

export const PayrollEligibility = mongoose.model(
  "PayrollEligibility",
  eligibility,
  "payroll_eligibility"
);

// Payroll Policy — effective dates removed
const policy = new Schema(
  {
    code: {
      type: String,
      required: true,
    },

    employeePfRate: {
      type: Number,
      default: 12,
    },

    employerPfRate: {
      type: Number,
      default: 12,
    },

    employeeEsicRate: {
      type: Number,
      default: 0.75,
    },

    employerEsicRate: {
      type: Number,
      default: 3.25,
    },

    esicWageCeiling: {
      type: Number,
      default: 21000,
    },

    insuranceAmount: { type: Number, default: 0, min: 0 },
    outstationFreeDays: { type: Number, default: 3, min: 0, max: 31 },
    outstationGrossPercent: { type: Number, default: 20, min: 0, max: 100 },
    ptAmount: {
      type: Number,
      default: 200,
    },

    earlyLeaveFreeCount: { type: Number, default: 2, min: 0 },
    earlyLeavePenaltyPercent: { type: Number, default: 25, min: 0, max: 100 },
    casualLeaveAccrual: {
      type: Number,
      default: 1,
    },

    lateMarksPerPenalty: {
      type: Number,
      default: 1,
    },

    latePenaltyDays: {
      type: Number,
      default: 0.25,
    },

    enabled: {
      type: Boolean,
      default: true,
    },

    notes: String,
  },
  { timestamps: true }
);

export const PayrollPolicy = mongoose.model(
  "PayrollPolicy",
  policy,
  "payroll_policies"
);
