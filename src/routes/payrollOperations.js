import {Router} from 'express';
import {z} from 'zod';
import {authenticate,permit,requireAdmin} from '../middleware/auth.js';
import {Employee} from '../models/index.js';
import Site from '../models/Site.js';
import {PayrollEntry,PayrollMonth} from '../models/MonthlyPayroll.js';
import {EmployeeInsurance,EmployeeAdvance,AdvanceRecovery,PayrollOperation} from '../models/PayrollOperations.js';
import {asyncHandler as wrap} from '../utils/asyncHandler.js';
const router=Router();router.use(authenticate);
const id=z.string().regex(/^[0-9a-fA-F]{24}$/);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v+'T00:00:00Z')),'Invalid date');
const amount=z.number().finite().positive().max(100000000);
const clock=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const minutes=v=>Number(v.slice(0,2))*60+Number(v.slice(3));
const paise=n=>Math.round(n*100);
const err=(msg,status=400)=>Object.assign(new Error(msg),{status});
async function employeeExists(employee){if(!await Employee.exists({_id:employee}))throw err('Employee not found',404);}
async function unlocked(employee,year,month){const period=await PayrollMonth.findOne({year,month}).lean();if(!period)return;const entry=await PayrollEntry.findOne({period:period._id,employee}).lean();if(entry&&(entry.status==='APPROVED'||entry.status==='PENDING_APPROVAL'||(!entry.status&&period.status!=='DRAFT')))throw err('Employee payroll is locked for this month',409);}
const periodOf=d=>({year:Number(d.slice(0,4)),month:Number(d.slice(5,7))});
router.get('/insurance',permit('employee:read'),wrap(async(req,res)=>res.json(await EmployeeInsurance.find().populate('employee','employeeCode firstName lastName').sort({effectiveFrom:-1}).lean())));
router.post('/insurance',permit('salary:write'),wrap(async(req,res)=>{const v=z.object({employee:id,amount:amount.or(z.literal(0)),effectiveFrom:date,effectiveTo:date.optional(),active:z.boolean().default(true)}).parse(req.body);await employeeExists(v.employee);
const insuredEmployee=await Employee.findById(v.employee).select('gender').lean();
if(String(insuredEmployee?.gender||'').trim().toUpperCase()!=="MALE") throw err("Company insurance premium applies only to male employees under this policy");
await unlocked(v.employee,...Object.values(periodOf(v.effectiveFrom)));if(v.effectiveTo&&v.effectiveTo<v.effectiveFrom)throw err('End date precedes start date');const doc=await EmployeeInsurance.findOneAndUpdate({employee:v.employee,effectiveFrom:v.effectiveFrom},{$set:{amountPaise:paise(v.amount),effectiveTo:v.effectiveTo||null,active:v.active,updatedBy:req.user._id}},{upsert:true,new:true,runValidators:true});res.json(doc)}));
router.get('/advances',permit('employee:read'),wrap(async(req,res)=>{const advances=await EmployeeAdvance.find().populate('employee','employeeCode firstName lastName').sort({date:-1}).lean();const recoveries=await AdvanceRecovery.find({status:'APPROVED'}).lean();res.json(advances.map(a=>({...a,recoveredPaise:recoveries.filter(r=>String(r.advance)===String(a._id)).reduce((s,r)=>s+r.amountPaise,0)})))}));
router.post('/advances',permit('salary:write'),wrap(async(req,res)=>{const v=z.object({employee:id,amount, date,reason:z.string().max(500).optional(),reference:z.string().max(100).optional()}).parse(req.body);await employeeExists(v.employee);res.status(201).json(await EmployeeAdvance.create({employee:v.employee,amountPaise:paise(v.amount),date:v.date,reason:v.reason,reference:v.reference,createdBy:req.user._id}))}));
router.post('/advances/:id/pay',requireAdmin,wrap(async(req,res)=>{const a=await EmployeeAdvance.findOneAndUpdate({_id:id.parse(req.params.id),paid:false},{$set:{paid:true,paidAt:new Date(),approvedBy:req.user._id}},{new:true});if(!a)throw err('Advance not found or already paid',409);res.json(a)}));
router.get('/recoveries',permit('employee:read'),wrap(async(req,res)=>res.json(await AdvanceRecovery.find().populate('employee','employeeCode firstName lastName').populate('advance','amountPaise date').sort({createdAt:-1}).lean())));
router.post('/recoveries',permit('salary:write'),wrap(async(req,res)=>{const v=z.object({advance:id,year:z.number().int().min(2020).max(2100),month:z.number().int().min(1).max(12),amount}).parse(req.body);const a=await EmployeeAdvance.findById(v.advance);if(!a?.paid)throw err('Advance must be paid before recovery');await unlocked(a.employee,v.year,v.month);const approved=await AdvanceRecovery.aggregate([{$match:{advance:a._id,status:'APPROVED'}},{$group:{_id:null,total:{$sum:'$amountPaise'}}}]);if((approved[0]?.total||0)+paise(v.amount)>a.amountPaise)throw err('Recovery exceeds outstanding advance');res.status(201).json(await AdvanceRecovery.create({...v,employee:a.employee,amountPaise:paise(v.amount),createdBy:req.user._id}))}));
router.post('/recoveries/:id/decision',requireAdmin,wrap(async(req,res)=>{const status=z.enum(['APPROVED','REJECTED']).parse(req.body.status);const r=await AdvanceRecovery.findById(id.parse(req.params.id));if(!r||r.status!=='PENDING')throw err('Recovery not pending',409);await unlocked(r.employee,r.year,r.month);if(status==='APPROVED'){const a=await EmployeeAdvance.findById(r.advance);const existing=await AdvanceRecovery.aggregate([{$match:{advance:r.advance,status:'APPROVED'}},{$group:{_id:null,total:{$sum:'$amountPaise'}}}]);if(!a?.paid||(existing[0]?.total||0)+r.amountPaise>a.amountPaise)throw err('Insufficient advance balance',409);}r.status=status;r.approvedBy=req.user._id;r.approvedAt=new Date();await r.save();res.json(r)}));
router.get('/operations',permit('employee:read'),wrap(async(req,res)=>{const filter={};if(req.query.type)filter.type=z.enum(['TA_FIXED','TA_ACTUAL','OUTSTATION','SITE_LATE','EARLY_LEAVE','OVERTIME']).parse(req.query.type);res.json(await PayrollOperation.find(filter).populate('employee','employeeCode firstName lastName').sort({date:-1}).lean())}));
router.post('/operations',permit('salary:write'),wrap(async(req,res)=>{const v=z.object({employee:id,type:z.enum(['TA_FIXED','TA_ACTUAL','OUTSTATION','SITE_LATE','EARLY_LEAVE','OVERTIME']),date,tripId:z.string().max(80).optional(),site:z.string().max(150).optional(),siteId:id.optional().or(z.literal('')),department:z.string().max(120).optional(),description:z.string().max(1000).optional(),checkInLatitude:z.number().min(-90).max(90).nullable().optional(),checkInLongitude:z.number().min(-180).max(180).nullable().optional(),checkOutLatitude:z.number().min(-90).max(90).nullable().optional(),checkOutLongitude:z.number().min(-180).max(180).nullable().optional(),scheduledTime:clock.optional().or(z.literal('')),checkIn:clock.optional().or(z.literal('')),checkOut:clock.optional().or(z.literal('')),reason:z.string().max(500).optional(),amount:z.number().finite().min(0).max(100000000).default(0),hours:z.number().finite().min(0).max(24).default(0)}).parse(req.body);await employeeExists(v.employee);await unlocked(v.employee,...Object.values(periodOf(v.date)));if(v.siteId){const matched=await Site.findOne({_id:v.siteId,active:true}).lean();if(!matched)throw err('Select a valid active Site Master record');v.site=matched.name;if(v.type==='SITE_LATE'&&!v.scheduledTime)v.scheduledTime=matched.reportingTime;}else{delete v.siteId;}if(v.type==='OUTSTATION'&&!v.tripId)throw err('Outstation trip ID is required to track first four days');if(v.type==='OVERTIME'&&(!v.checkOut||minutes(v.checkOut)<=1200))throw err('Overtime checkout must be after 20:00');if(v.type==='OVERTIME'&&(v.hours<=0||v.hours>(minutes(v.checkOut)-1200)/60))throw err('OT hours exceed time worked after 20:00');if(v.type==='EARLY_LEAVE'&&(!v.checkOut||minutes(v.checkOut)<960||minutes(v.checkOut)>=1110))throw err('Early leave must be from 16:00 to before 18:30');if(v.type==='SITE_LATE'&&(!v.scheduledTime||!v.checkIn||minutes(v.checkIn)<=minutes(v.scheduledTime)))throw err('Site late requires actual check-in after scheduled time');if(v.type==='SITE_LATE'&&v.amount<=0)throw err('Enter approved site late penalty amount');if(v.type.startsWith('TA_')&&v.amount<=0)throw err('TA claim amount must be greater than zero');if(v.type==='OUTSTATION'&&new Date(v.date+'T00:00:00Z').getUTCDay()===0)throw err('Sunday is excluded from outstation eligible days');const doc=await PayrollOperation.create({...v,amountPaise:paise(v.amount),createdBy:req.user._id});res.status(201).json(doc)}));
router.post('/operations/:id/decision',requireAdmin,wrap(async(req,res)=>{const status=z.enum(['APPROVED','REJECTED']).parse(req.body.status);const op=await PayrollOperation.findById(id.parse(req.params.id));if(!op||op.status!=='PENDING')throw err('Operation not pending',409);await unlocked(op.employee,...Object.values(periodOf(op.date)));op.status=status;op.approvedBy=req.user._id;op.approvedAt=new Date();await op.save();res.json(op)}));
router.delete('/operations/:id',permit('salary:write'),wrap(async(req,res)=>{
 const op=await PayrollOperation.findById(id.parse(req.params.id));if(!op)throw err('Record not found',404);
 await unlocked(op.employee,...Object.values(periodOf(op.date)));
 if(op.status!=='PENDING'||op.paid)throw err('Only unpaid pending records can be deleted',409);
 await op.deleteOne();res.json({deleted:true});
}));
router.delete('/recoveries/:id',permit('salary:write'),wrap(async(req,res)=>{
 const r=await AdvanceRecovery.findById(id.parse(req.params.id));if(!r)throw err('Recovery not found',404);
 await unlocked(r.employee,r.year,r.month);
 if(r.status!=='PENDING')throw err('Only pending recoveries can be deleted',409);
 await r.deleteOne();res.json({deleted:true});
}));
router.delete('/advances/:id',permit('salary:write'),wrap(async(req,res)=>{
 const a=await EmployeeAdvance.findById(id.parse(req.params.id));if(!a)throw err('Advance not found',404);
 if(a.paid||await AdvanceRecovery.exists({advance:a._id}))throw err('Paid or scheduled advances cannot be deleted',409);
 await a.deleteOne();res.json({deleted:true});
}));
router.delete('/insurance/:id',permit('salary:write'),wrap(async(req,res)=>{
 const premium=await EmployeeInsurance.findById(id.parse(req.params.id));if(!premium)throw err('Insurance record not found',404);
 // Deactivate; do not remove historical payroll evidence.
 premium.active=false;premium.updatedBy=req.user._id;await premium.save();res.json(premium);
}));
router.post('/operations/:id/pay' ,requireAdmin,wrap(async(req,res)=>{const reference=z.string().min(1).max(100).parse(req.body.reference);const op=await PayrollOperation.findOneAndUpdate({_id:id.parse(req.params.id),type:{$in:['TA_FIXED','TA_ACTUAL']},status:'APPROVED',paid:false},{$set:{paid:true,paidAt:new Date(),paymentReference:reference}},{new:true});if(!op)throw err('Approved unpaid TA claim not found',409);res.json(op)}));
export default router;
