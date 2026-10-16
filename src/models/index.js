import mongoose from "mongoose";
const {Schema,model}=mongoose;
const opts={timestamps:true};
export const Role=model("Role",new Schema({code:{type:String,unique:true,required:true},name:String,permissions:[String],active:{type:Boolean,default:true}},opts));
export const User=model("User",new Schema({name:String,email:{type:String,unique:true,lowercase:true,required:true},passwordHash:{type:String,required:true},role:{type:Schema.Types.ObjectId,ref:"Role",required:true},active:{type:Boolean,default:true},mustChangePassword:{type:Boolean,default:false},lastLoginAt:Date,passwordChangedAt:Date},opts));
export const Department=model("Department",new Schema({code:{type:String,unique:true,required:true},name:{type:String,required:true},active:{type:Boolean,default:true}},opts));
export const Designation = model(
  "Designation",
  new Schema(
    {
      code: {
        type: String,
        unique: true,
        required: true
      },
      name: {
        type: String,
        required: true
      },
      department: {
        type: Schema.Types.ObjectId,
        ref: "Department",
        default: null
      },
      active: {
        type: Boolean,
        default: true
      }
    },
    opts
  )
);
export const Counter=model("Counter",new Schema({_id:String,seq:{type:Number,default:0}}));
export const Employee=model("Employee",new Schema({
employeeCode:{type:String,required:true,unique:true},firstName:{type:String,required:true},lastName:{type:String,required:true},email:{type:String,lowercase:true,trim:true},mobile:String,dateOfBirth:Date,gender:String,
department:{type:Schema.Types.ObjectId,ref:"Department",required:true},designation:{type:Schema.Types.ObjectId,ref:"Designation",required:true},joiningDate:{type:Date,required:true},employmentType:{type:String,default:"FULL_TIME"},status:{type:String,enum:["ACTIVE","INACTIVE","EXITED"],default:"ACTIVE"},
address:{line1:String,city:String,state:String,pincode:String},
bank:{accountHolder:String,bankName:String,accountNumber:String,ifsc:String},
statutory:{pan:String,uan:String,esicNumber:String,pfEligible:Boolean,esicEligible:Boolean},
exitDate:Date,createdBy:{type:Schema.Types.ObjectId,ref:"User"},updatedBy:{type:Schema.Types.ObjectId,ref:"User"}
},opts));
Employee.schema.index({email:1},{unique:true,partialFilterExpression:{email:{$type:"string"}}});
export const Setting=model("Setting",new Schema({key:{type:String,unique:true,required:true},value:Schema.Types.Mixed,description:String,updatedBy:{type:Schema.Types.ObjectId,ref:"User"}},opts));
export const Rule=model("Rule",new Schema({code:{type:String,required:true},name:String,category:{type:String,enum:["ATTENDANCE","EARNING","DEDUCTION","STATUTORY","APPROVAL"],required:true},config:{type:Schema.Types.Mixed,required:true},effectiveFrom:{type:Date,required:true},effectiveTo:Date,active:{type:Boolean,default:true},version:{type:Number,default:1}},opts));
Rule.schema.index({code:1,version:1},{unique:true});
export const SalaryComponent=model("SalaryComponent",new Schema({code:{type:String,unique:true,required:true},name:String,type:{type:String,enum:["EARNING","DEDUCTION"],required:true},calculationType:{type:String,enum:["FIXED","PERCENTAGE","FORMULA","MANUAL"],default:"FIXED"},config:Schema.Types.Mixed,proratable:{type:Boolean,default:true},active:{type:Boolean,default:true}},opts));
export const SalaryStructure=model("SalaryStructure",new Schema({employee:{type:Schema.Types.ObjectId,ref:"Employee",required:true},effectiveFrom:{type:Date,required:true},effectiveTo:Date,items:[{component:{type:Schema.Types.ObjectId,ref:"SalaryComponent"},amount:Number,config:Schema.Types.Mixed}],status:{type:String,enum:["DRAFT","ACTIVE","SUPERSEDED"],default:"DRAFT"},revision:{type:Number,default:1}},opts));
export const Attendance=model("Attendance",new Schema({employee:{type:Schema.Types.ObjectId,ref:"Employee",required:true},year:Number,month:Number,calendarDays:Number,presentDays:Number,paidLeaveDays:Number,unpaidLeaveDays:Number,weeklyOffDays:Number,holidayDays:Number,payableDays:Number,status:{type:String,default:"DRAFT"},enteredBy:{type:Schema.Types.ObjectId,ref:"User"}},opts));
Attendance.schema.index({employee:1,year:1,month:1},{unique:true});
export const Overtime=model("Overtime",new Schema({employee:{type:Schema.Types.ObjectId,ref:"Employee",required:true},year:Number,month:Number,hours:Number,approvedAmount:Number,reason:String,status:{type:String,enum:["DRAFT","APPROVED","REJECTED"],default:"DRAFT"}},opts));
export const PayrollPeriod=model("PayrollPeriod",new Schema({year:Number,month:Number,status:{type:String,enum:["OPEN","PROCESSING","PENDING_APPROVAL","APPROVED","LOCKED"],default:"OPEN"},approvedBy:{type:Schema.Types.ObjectId,ref:"User"},approvedAt:Date},opts));
PayrollPeriod.schema.index({year:1,month:1},{unique:true});
export const PayrollRecord=model("PayrollRecord",new Schema({period:{type:Schema.Types.ObjectId,ref:"PayrollPeriod",required:true},employee:{type:Schema.Types.ObjectId,ref:"Employee",required:true},salarySnapshot:Schema.Types.Mixed,attendanceSnapshot:Schema.Types.Mixed,ruleSnapshot:Schema.Types.Mixed,earnings:[{code:String,amount:Schema.Types.Decimal128}],deductions:[{code:String,amount:Schema.Types.Decimal128}],gross:{type:Schema.Types.Decimal128},net:{type:Schema.Types.Decimal128},status:{type:String,default:"DRAFT"},approvedBy:{type:Schema.Types.ObjectId,ref:"User"}},opts));
PayrollRecord.schema.index({period:1,employee:1},{unique:true});
export const AuditLog=model("AuditLog",new Schema({actor:{type:Schema.Types.ObjectId,ref:"User"},action:String,entity:String,entityId:String,before:Schema.Types.Mixed,after:Schema.Types.Mixed,ip:String},opts));

export const CompanyProfile=model("CompanyProfile",new Schema({singletonKey:{type:String,unique:true,default:"THETAVEGA",immutable:true},companyName:{type:String,required:true,default:"THETAVEGA TECH PVT LTD"},companyCode:{type:String,default:"THETAVEGA"},email:String,phone:String,website:String,address:{line1:String,line2:String,city:String,state:String,pincode:String,country:{type:String,default:"India"}},cin:String,pan:String,gstin:String,pfEstablishmentCode:String,esicEmployerCode:String,logoUrl:String,payslipFooter:String,updatedBy:{type:Schema.Types.ObjectId,ref:"User"}},opts));
