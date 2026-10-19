import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import Site from "../models/Site.js";
import { authenticate, permit } from "../middleware/auth.js";
import { asyncHandler as wrap } from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";
const router = Router();
router.use(authenticate);
const schema = z.object({
  code: z.string().trim().min(1).max(30).regex(/^[a-zA-Z0-9_-]+$/),
  customerName: z.string().trim().min(1).max(150),
  name: z.string().trim().min(1).max(150),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  distanceKm: z.number().finite().min(0).default(0),
  address: z.string().trim().min(1).max(500),
  reportingTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  taPolicy: z.enum(["NONE", "FIXED", "ACTUAL", "BOTH"]),
  fixedDailyTA: z.number().finite().min(0),
  gps: z.object({ latitude: z.number().min(-90).max(90).nullable().optional(), longitude: z.number().min(-180).max(180).nullable().optional(), radiusMeters: z.number().min(50).max(10000) }).strict(),
  active: z.boolean()
}).strict().superRefine((v,ctx)=>{
 if ((v.gps.latitude == null) !== (v.gps.longitude == null)) ctx.addIssue({code:"custom",path:["gps"],message:"Latitude and longitude must both be provided"});
 if (!["FIXED","BOTH"].includes(v.taPolicy) && v.fixedDailyTA !== 0) ctx.addIssue({code:"custom",path:["fixedDailyTA"],message:"Fixed TA must be zero unless policy is FIXED or BOTH"});
});
router.get("/",permit("master:read"),wrap(async(req,res)=>res.json(await Site.find({}).sort({customerName:1,name:1}).lean())));
router.post("/",permit("master:write"),wrap(async(req,res)=>{
 const data=schema.parse(req.body); const doc=await Site.create({...data,code:data.code.toUpperCase(),createdBy:req.user._id,updatedBy:req.user._id});
 await audit(req,"CREATE","sites",doc.id,null,doc.toObject());res.status(201).json(doc);
}));
router.patch("/:id",permit("master:write"),wrap(async(req,res)=>{
 if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:"Invalid site ID"});
 const before=await Site.findById(req.params.id).lean();if(!before)return res.status(404).json({message:"Site not found"});
 const {createdBy,updatedBy,_id,createdAt,updatedAt,__v,...existing}=before;
 const data=schema.parse({...existing,...req.body,gps:{...existing.gps,...req.body.gps}});
 const doc=await Site.findByIdAndUpdate(req.params.id,{$set:{...data,code:data.code.toUpperCase(),updatedBy:req.user._id}},{new:true,runValidators:true});
 await audit(req,"UPDATE","sites",doc.id,before,doc.toObject());res.json(doc);
}));
// Soft-delete protects historical attendance, TA and payroll references.
router.delete('/:id',permit('master:write'),wrap(async(req,res)=>{
 if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid site ID'});
 const before=await Site.findById(req.params.id).lean();if(!before)return res.status(404).json({message:'Site not found'});
 const doc=await Site.findByIdAndUpdate(req.params.id,{$set:{active:false,updatedBy:req.user._id}},{new:true});
 await audit(req,'DEACTIVATE','Site',doc.id,before,doc.toObject());res.json(doc);
}));
export default router;
