import { Router } from 'express';
import { authenticateMobile } from '../middleware/mobileAuth.js';
import { asyncHandler as wrap } from '../utils/asyncHandler.js';
import { PayrollMonth, PayrollEntry } from '../models/MonthlyPayroll.js';
import SiteAttendance from '../models/SiteAttendance.js';

const router = Router();
router.use(authenticateMobile);
const employeeId = req => req.mobileEmployee._id;
const periodOK = (y,m) => Number.isInteger(y) && y>=2020 && y<=2100 && Number.isInteger(m) && m>=1 && m<=12;
const approved = (entry, period) => entry && (entry.status === 'APPROVED' || (!entry.status && period?.status === 'APPROVED'));
const moneyParts = rows => (rows || []).map(x => ({ code: x.code || '', name: x.name || x.code || '', amountPaise: Number(x.amountPaise || 0) }));
const attendanceFields = entry => {
  const a = entry.attendanceSnapshot || {};
  return {
    presentDays: a.presentDays ?? null, paidLeaveDays: a.paidLeaveDays ?? null,
    unpaidLeaveDays: a.unpaidLeaveDays ?? null, casualLeaveDays: a.casualLeaveDays ?? null,
    weeklyOffDays: a.weeklyOffDays ?? null, holidayDays: a.holidayDays ?? null,
    lateMarks: a.lateMarks ?? null, earlyLeaves: a.earlyLeaves ?? null,
    halfDays: a.halfDays ?? null, approvedOverDays: a.approvedOverDays ?? null,
    payableDays: entry.payableDays ?? null, calendarDays: entry.calendarDays ?? null,
  };
};
// Employee-specific released months only. Never reveal other employees or DRAFT entries.
router.get('/months', wrap(async (req,res) => {
  const entries = await PayrollEntry.find({ employee:employeeId(req), $or:[{status:'APPROVED'},{status:{$exists:false}}] })
    .select('period status approvedAt').sort({createdAt:-1}).limit(120).lean();
  const ids = entries.map(e=>e.period);
  const periods = await PayrollMonth.find({_id:{$in:ids}}).select('year month status approvedAt').lean();
  const byId = new Map(periods.map(p=>[String(p._id),p]));
  const months = entries.filter(e=>approved(e,byId.get(String(e.period))))
    .map(e=>({year:byId.get(String(e.period)).year,month:byId.get(String(e.period)).month,
      approvedAt:e.approvedAt || byId.get(String(e.period)).approvedAt || null}))
    .sort((a,b)=>b.year-a.year || b.month-a.month);
  res.json({months});
}));
router.get('/month/:year/:month', wrap(async (req,res) => {
  const year=Number(req.params.year), month=Number(req.params.month);
  if(!periodOK(year,month)) return res.status(400).json({message:'Invalid payroll month'});
  const period=await PayrollMonth.findOne({year,month}).lean();
  if(!period) return res.status(404).json({message:'No published payslip for this month'});
  const entry=await PayrollEntry.findOne({period:period._id,employee:employeeId(req)}).lean();
  if(!approved(entry,period)) return res.status(404).json({message:'This month has not been approved for your account'});
  res.json({year,month,approvedAt:entry.approvedAt || period.approvedAt || null,
    employee:{employeeCode:req.mobileEmployee.employeeCode,name:`${req.mobileEmployee.firstName} ${req.mobileEmployee.lastName}`.trim()},
    attendance:attendanceFields(entry),payslip:{
      calendarDays:entry.calendarDays??null,payableDays:entry.payableDays??null,
      earnedGrossPaise:Number(entry.earnedGrossPaise||0), monthlyGrossPaise:Number(entry.monthlyGrossPaise||0),
      overtimePaise:Number(entry.overtimePaise||0), totalDeductionPaise:Number(entry.totalDeductionPaise||0),
      netPaise:Number(entry.netPaise||0), earnings:moneyParts(entry.components),
      deductions:moneyParts(entry.deductions), employerContributions:moneyParts(entry.employerContributions)
    }});
}));
// TA evidence/status only; no fabricated payable amounts or automatic salary changes.
router.get('/site-visits', wrap(async (req,res) => {
  const year=Number(req.query.year),month=Number(req.query.month);
  if(!periodOK(year,month)) return res.status(400).json({message:'Invalid year/month'});
  const start=new Date(Date.UTC(year,month-1,1,-5,-30));
  const end=new Date(Date.UTC(year,month,1,-5,-30));
  const visits=await SiteAttendance.find({employee:employeeId(req),checkedInAt:{$gte:start,$lt:end}})
    .sort({checkedInAt:-1}).limit(100).lean();
  res.json({visits:visits.map(v=>({id:v._id,siteName:v.siteSnapshot?.name||'Site',
    checkedInAt:v.checkedInAt,checkedOutAt:v.checkedOutAt,open:v.open,
    verificationStatus:v.verificationStatus,checkInMethod:v.checkInMethod,checkOutMethod:v.checkOutMethod,
    reviewNote:v.reviewNote || ''})),note:'Visit approval does not automatically establish a payable TA amount.'});
}));
export default router;
