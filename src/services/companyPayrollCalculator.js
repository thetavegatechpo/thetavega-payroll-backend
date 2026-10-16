
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
  approvedTdsAmount = 0
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

  const pt = eligibility.ptApplicable
    ? D(policy.ptAmount)
    : D(0);

  const tds = eligibility.tdsApplicable
    ? D(approvedTdsAmount)
    : D(0);

  const overtime = D(approvedOvertimeAmount);

  const deductions = D(money(employeePf))
    .plus(money(employeeEsic))
    .plus(money(pt))
    .plus(money(tds));

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
      total: money(deductions)
    },
    employerCosts: {
      employerPf: money(employerPf),
      employerEsic: money(employerEsic)
    },
    netSalary: money(netSalary)
  };
}
