import mongoose from 'mongoose';
const {Schema}=mongoose;

const attendance=new Schema({
 employee:{type:Schema.Types.ObjectId,ref:'Employee',required:true},
 year:{type:Number,required:true},
 month:{type:Number,required:true},
 presentDays:{type:Number,required:true,min:0},
 paidLeaveDays:{type:Number,default:0,min:0},
 unpaidLeaveDays:{type:Number,default:0,min:0},
 weeklyOffDays:{type:Number,default:0,min:0},
 holidayDays:{type:Number,default:0,min:0},
 casualLeaveDays:{type:Number,default:0,min:0},
 lateMarks:{type:Number,default:0,min:0},
 earlyLeaves:{type:Number,default:0,min:0,validate:{validator:Number.isInteger,message:'Early leaves must be a whole number'}},
 halfDays:{type:Number,default:0,min:0},
 approvedOverDays:{type:Number,default:0,min:0},
 notes:String,
 updatedBy:{type:Schema.Types.ObjectId,ref:'User'}
},{timestamps:true});
attendance.index({employee:1,year:1,month:1},{unique:true});
export const MonthlyAttendance=mongoose.model('MonthlyAttendanceV2',attendance,'monthly_attendance_v2');

const overtime=new Schema({employee:{type:Schema.Types.ObjectId,ref:'Employee',required:true},year:{type:Number,required:true},month:{type:Number,required:true},amountPaise:{type:Number,required:true,min:0},notes:String,approved:{type:Boolean,default:false},approvedBy:{type:Schema.Types.ObjectId,ref:'User'}},{timestamps:true});
overtime.index({employee:1,year:1,month:1},{unique:true});
export const MonthlyOvertime=mongoose.model('MonthlyOvertimeV2',overtime,'monthly_overtime_v2');

const deduction=new Schema({code:{type:String,required:true,unique:true},name:{type:String,required:true},mode:{type:String,enum:['FIXED','PERCENT_GROSS'],required:true},value:{type:Number,required:true,min:0},enabled:{type:Boolean,default:true},effectiveFrom:{type:String,required:true},effectiveTo:String,notes:String},{timestamps:true});
export const PayrollDeductionRule=mongoose.model('PayrollDeductionRuleV2',deduction,'payroll_deduction_rules_v2');

const period=new Schema({year:{type:Number,required:true},month:{type:Number,required:true},status:{type:String,enum:['DRAFT','PENDING_APPROVAL','APPROVED'],default:'DRAFT'},submittedBy:{type:Schema.Types.ObjectId,ref:'User'},approvedBy:{type:Schema.Types.ObjectId,ref:'User'},approvedAt:Date},{timestamps:true});
period.index({year:1,month:1},{unique:true});
export const PayrollMonth=mongoose.model('PayrollMonthV2',period,'payroll_months_v2');

const entry=new Schema({period:{type:Schema.Types.ObjectId,ref:'PayrollMonthV2',required:true},employee:{type:Schema.Types.ObjectId,ref:'Employee',required:true},employeeCode:String,employeeName:String,calendarDays:Number,payableDays:Number,monthlyGrossPaise:Number,earnedGrossPaise:Number,overtimePaise:Number,deductions:[{code:String,name:String,amountPaise:Number}],employerContributions:[{code:String,name:String,amountPaise:Number}],attendanceSnapshot:Schema.Types.Mixed,policySnapshot:Schema.Types.Mixed,totalDeductionPaise:Number,netPaise:Number,components:[{code:String,name:String,amountPaise:Number}],salaryRevision:Number,ruleSnapshot:Schema.Types.Mixed,status:{type:String,enum:['DRAFT','PENDING_APPROVAL','APPROVED'],default:'DRAFT'},submittedBy:{type:Schema.Types.ObjectId,ref:'User'},submittedAt:Date,approvedBy:{type:Schema.Types.ObjectId,ref:'User'},approvedAt:Date},{timestamps:true});
entry.index({period:1,employee:1},{unique:true});
export const PayrollEntry=mongoose.model('PayrollEntryV2',entry,'payroll_entries_v2');
