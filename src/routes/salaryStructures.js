import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Employee, SalaryComponent, Counter } from "../models/index.js";
import Revision from "../models/EmployeeSalaryRevision.js";
import { authenticate, permit } from "../middleware/auth.js";
import { asyncHandler as wrap } from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";

const router = Router();
router.use(authenticate);
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s) { if (!dateRe.test(s)) return false; const d=new Date(s+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===s; }
const money = z.union([z.string(), z.number()]).transform(v=>String(v)).refine(v=>/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(v),"Use a nonnegative amount with up to two decimals");
const inputSchema=z.object({
 effectiveFrom:z.string().refine(validDate,"Use a valid YYYY-MM-DD date"),
 notes:z.string().trim().max(500).optional(),
 items:z.array(z.object({componentId:z.string().refine(mongoose.isValidObjectId),amount:money}).strict()).min(1).max(50)
}).strict();
const toPaise = amount => {const [whole,frac='']=amount.split('.');return Number(whole)*100+Number(frac.padEnd(2,'0'));};
const toAmount = paise => (paise/100).toFixed(2);
const present = doc => ({
 id:String(doc._id), employee:doc.employee, revision:doc.revision,
 effectiveFrom:doc.effectiveFrom,notes:doc.notes,
 monthlyGross:doc.monthlyGross.toString(),
 items:doc.items.map(i=>({componentId:String(i.component),code:i.code,name:i.name,proratable:i.proratable,amount:i.amount.toString()})),
 createdAt:doc.createdAt,createdBy:doc.createdBy
});
const employeeExists=async id=>mongoose.isValidObjectId(id)&&await Employee.exists({_id:id});
// All records as immutable effective-dated salary revisions.
router.get("/employee/:employeeId",permit("employee:read"),wrap(async(req,res)=>{
 if(!await employeeExists(req.params.employeeId))return res.status(404).json({message:"Employee not found"});
 const docs=await Revision.find({employee:req.params.employeeId}).sort({effectiveFrom:-1,createdAt:-1}).lean();
 res.json(docs.map(present));
}));
router.get("/employee/:employeeId/current",permit("employee:read"),wrap(async(req,res)=>{
 if(!await employeeExists(req.params.employeeId))return res.status(404).json({message:"Employee not found"});
 const asOf=String(req.query.asOf||new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}));
 if(!validDate(asOf))return res.status(400).json({message:"asOf must be YYYY-MM-DD"});
 const doc=await Revision.findOne({employee:req.params.employeeId,effectiveFrom:{$lte:asOf}}).sort({effectiveFrom:-1}).lean();
 res.json({asOf,data:doc?present(doc):null});
}));
router.post("/employee/:employeeId",permit("salary:write"),wrap(async(req,res)=>{
 if(!await employeeExists(req.params.employeeId))return res.status(404).json({message:"Employee not found"});
 const parsed=inputSchema.safeParse(req.body);
 if(!parsed.success)return res.status(400).json({message:"Invalid salary structure",details:parsed.error.flatten()});
 const input=parsed.data;
 const ids=input.items.map(i=>i.componentId);
 if(new Set(ids).size!==ids.length)return res.status(400).json({message:"Duplicate salary components are not permitted"});
 const components=await SalaryComponent.find({_id:{$in:ids},active:true}).lean();
 if(components.length!==ids.length)return res.status(400).json({message:"One or more components do not exist or are inactive"});
 const byId=new Map(components.map(c=>[String(c._id),c]));
 let total=0;const rows=[];
 for(const item of input.items){
   const c=byId.get(item.componentId);
   if(c.type!=="EARNING")return res.status(400).json({message:`${c.code} is a deduction. Deduction rules are configured separately.`});
   if(!["FIXED","MANUAL"].includes(c.calculationType))return res.status(400).json({message:`${c.code}: percentage/formula calculation is not supported for salary revisions yet`});
   total+=toPaise(item.amount);if(!Number.isSafeInteger(total))return res.status(400).json({message:"Amount exceeds supported range"});
   rows.push({component:c._id,code:c.code,name:c.name,proratable:c.proratable,amount:mongoose.Types.Decimal128.fromString(toAmount(toPaise(item.amount)))});
 }
 if(total===0)return res.status(400).json({message:"Monthly gross must be greater than zero"});
 // Employee-scoped atomic sequence; unique effectiveFrom prevents replacing an existing revision.
 const counter=await Counter.findOneAndUpdate({_id:`salary_revision_${req.params.employeeId}`},{$inc:{seq:1}},{new:true,upsert:true});
 const doc=await Revision.create({employee:req.params.employeeId,revision:counter.seq,effectiveFrom:input.effectiveFrom,notes:input.notes||"",items:rows,monthlyGross:mongoose.Types.Decimal128.fromString(toAmount(total)),createdBy:req.user._id});
 await audit(req,"CREATE","EmployeeSalaryRevision",doc._id,null,{employee:req.params.employeeId,revision:doc.revision,effectiveFrom:doc.effectiveFrom,monthlyGross:doc.monthlyGross.toString()});
 res.status(201).json(present(doc));
}));
export default router;
