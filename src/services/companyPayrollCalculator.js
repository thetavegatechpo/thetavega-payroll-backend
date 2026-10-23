
import Decimal from "decimal.js";

const D = (value) => new Decimal(value ?? 0);

const money = (value) =>
  D(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();

export function calculateCompanyPayroll({
  year,
  month,
  salary,
  attendance,
  policy,
  eligibility,
  approvedOvertimeAmount = 0,
  approvedTdsAmount = 0,
  gender = "",
  earlyLeaveCount = 0,
  insuranceAmount = 0
}) {
  const calendarDays = new Date(year, month, 0).getDate();

  const absentDays = D(attendance.absentDays);
  const casualLeaveDays = D(attendance.casualLeaveDays);
  const lateMarks = Number(attendance.lateMarks || 0);
  const latePenaltyDays = D(attendance.latePenaltyDays);
  const overDays = D(attendance.approvedOverDays);

  // Validated by an authorized attendance approver.
  // Do not infer 0.75 days from 7 late marks until
  // the complete late-mark policy is confirmed.
  if (
    [absentDays, casualLeaveDays, latePenaltyDays, overDays]
      .some((x) => x.isNegative()) ||
    !Number.isInteger(lateMarks) ||
    lateMarks < 0
  ) {
    throw new Error("Invalid attendance values");
  }

  if (absentDays.plus(casualLeaveDays).gt(calendarDays)) {
    throw new Error("Attendance exceeds calendar days");
  }

  const payableDays = D(calendarDays)
    .minus(absentDays)
    .minus(latePenaltyDays)
    .plus(overDays);

  if (
    payableDays.isNegative() ||
    payableDays.gt(calendarDays)
  ) {
    throw new Error("Payable days require review");
  }

  const basic = D(salary.basic);
  const gross = [
    salary.basic,
    salary.hra,
    salary.conveyance,
    salary.medical,
    salary.other
  ].reduce((sum, amount) => sum.plus(D(amount)), D(0));

  const ratio = payableDays.div(calendarDays);

  const earnedBasic = basic.mul(ratio);
  const earnedGross = gross.mul(ratio);

  const employeePf = eligibility.pfApplicable
    ? earnedBasic.mul(D(policy.employeePfRate).div(100))
    : D(0);

  // Employer cost stays outside employee net deductions.
  const employerPf = eligibility.pfApplicable
    ? earnedBasic.mul(D(policy.employerPfRate).div(100))
    : D(0);

  // Supply these from validated statutory policy calculations.
  // ESIC eligibility alone does not implement all ESI rules.
  const employeeEsic = D(0);
  const employerEsic = D(0);

  const normalizedGender = String(gender).trim().toUpperCase();
  if (eligibility.ptApplicable && !["MALE","FEMALE"].includes(normalizedGender)) throw new Error("Gender required for Maharashtra PT");
  const ptWages = earnedGross.toNumber();
  const pt = eligibility.ptApplicable ? D(normalizedGender === "MALE"
    ? (ptWages <= 7500 ? 0 : ptWages <= 10000 ? 175 : month === 2 ? 300 : 200)
    : (ptWages <= 25000 ? 0 : month === 2 ? 300 : 200)) : D(0);

  const tdsRate = Number(eligibility.tdsPercent ?? 0);
  if (!Number.isFinite(tdsRate) || tdsRate < 0 || tdsRate > 100) throw new Error("Invalid TDS percentage");
  const tds = eligibility.tdsApplicable ? earnedGross.mul(tdsRate).div(100) : D(0);
  if (!Number.isInteger(earlyLeaveCount) || earlyLeaveCount < 0) throw new Error("Invalid early leave count");
  const earlyPenalty = gross.div(calendarDays)
    .mul(Math.max(0,earlyLeaveCount-Number(policy.earlyLeaveFreeCount ?? 2)))
    .mul(Number(policy.earlyLeavePenaltyPercent ?? 25)).div(100);
  const insurance = normalizedGender === "MALE" ? D(insuranceAmount) : D(0);

  const overtime = D(approvedOvertimeAmount);

  const deductions = D(money(employeePf))
    .plus(money(employeeEsic))
    .plus(money(pt))
    .plus(money(tds))
    .plus(money(earlyPenalty))
    .plus(money(insurance));

  const salaryPayable = D(money(earnedGross))
    .plus(money(overtime));

  const netSalary = salaryPayable.minus(deductions);

  return {
    attendance: {
      calendarDays,
      absentDays: absentDays.toNumber(),
      casualLeaveDays: casualLeaveDays.toNumber(),
      lateMarks,
      latePenaltyDays: latePenaltyDays.toNumber(),
      approvedOverDays: overDays.toNumber(),
      payableDays: payableDays.toNumber()
    },
    earnings: {
      monthlyBasic: money(basic),
      monthlyGross: money(gross),
      earnedBasic: money(earnedBasic),
      earnedGross: money(earnedGross),
      approvedOvertime: money(overtime),
      salaryPayable: money(salaryPayable)
    },
    deductions: {
      employeePf: money(employeePf),
      employeeEsic: money(employeeEsic),
      pt: money(pt),
      tds: money(tds),
      earlyLeave: money(earlyPenalty),
      insurance: money(insurance),
      total: money(deductions)
    },
    employerCosts: {
      employerPf: money(employerPf),
      employerEsic: money(employerEsic)
    },
    netSalary: money(netSalary)
  };
}
