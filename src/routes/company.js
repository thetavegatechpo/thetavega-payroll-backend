import {Router} from "express";
import {z} from "zod";
import {CompanyProfile} from "../models/index.js";
import {authenticate,permit,requireAdmin} from "../middleware/auth.js";
import {asyncHandler as wrap} from "../utils/asyncHandler.js";
import {audit} from "../utils/audit.js";
const router=Router();router.use(authenticate);
const optionalText=(max=200)=>z.string().trim().max(max).optional();
const schema=z.object({
  companyName:z.string().trim().min(2).max(200),companyCode:z.string().trim().min(2).max(40),
  email:z.union([z.literal(""),z.string().email()]).optional(),phone:optionalText(30),website:optionalText(200),
  address:z.object({line1:optionalText(250),line2:optionalText(250),city:optionalText(100),state:optionalText(100),pincode:optionalText(15),country:optionalText(100)}).optional(),
  cin:optionalText(40),pan:optionalText(20),gstin:optionalText(30),pfEstablishmentCode:optionalText(60),esicEmployerCode:optionalText(60),
  logoUrl:optionalText(1000),payslipFooter:optionalText(500)
}).strict();
router.get("/",permit("config:read"),wrap(async(req,res)=>{
  const doc=await CompanyProfile.findOne({singletonKey:"THETAVEGA"}).lean();
  res.json(doc||{singletonKey:"THETAVEGA",companyName:"THETAVEGA TECH PVT LTD",companyCode:"THETAVEGA"});
}));
router.put("/",requireAdmin,permit("config:write"),wrap(async(req,res)=>{
  const parsed=schema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({message:"Invalid company details",errors:parsed.error.flatten()});
  const before=await CompanyProfile.findOne({singletonKey:"THETAVEGA"}).lean();
  const doc=await CompanyProfile.findOneAndUpdate({singletonKey:"THETAVEGA"},{$set:{...parsed.data,updatedBy:req.user._id}}, {upsert:true,new:true,runValidators:true,setDefaultsOnInsert:true});
  await audit(req,"UPDATE","CompanyProfile",doc._id,before?{companyName:before.companyName,companyCode:before.companyCode}:null,{companyName:doc.companyName,companyCode:doc.companyCode});
  res.json(doc);
}));
export default router;
