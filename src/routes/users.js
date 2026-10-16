import {Router} from "express";
import bcrypt from "bcryptjs";
import {z} from "zod";
import mongoose from "mongoose";
import {User,Role} from "../models/index.js";
import {authenticate,requireAdmin} from "../middleware/auth.js";
import {asyncHandler as wrap} from "../utils/asyncHandler.js";
import {audit} from "../utils/audit.js";
const router=Router();router.use(authenticate,requireAdmin);
const createSchema=z.object({name:z.string().trim().min(2).max(120),email:z.string().trim().email().max(200),password:z.string().min(12).max(128),roleId:z.string(),active:z.boolean().optional()}).strict();
const patchSchema=z.object({name:z.string().trim().min(2).max(120).optional(),email:z.string().trim().email().max(200).optional(),roleId:z.string().optional(),active:z.boolean().optional()}).strict();
const passwordSchema=z.object({newPassword:z.string().min(12).max(128)}).strict();
const safe=user=>({id:String(user._id),name:user.name,email:user.email,active:user.active,role:user.role?.code||null,roleId:String(user.role?._id||user.role),mustChangePassword:!!user.mustChangePassword,lastLoginAt:user.lastLoginAt,createdAt:user.createdAt});
const validId=id=>mongoose.isValidObjectId(id);
const validRole=async id=>validId(id)?Role.findOne({_id:id,active:true}):null;
async function lastAdminProtected(id, nextRoleId, active){
 const target=await User.findById(id).populate("role");
 if(!target)return {error:"User not found",status:404};
 if(!["ADMIN","SUPER_ADMIN"].includes(target.role?.code))return {target};
 const nextRole=nextRoleId ? await validRole(nextRoleId):target.role;
 const removing=active===false||!["ADMIN","SUPER_ADMIN"].includes(nextRole?.code);
 if(removing){
  const roles=await Role.find({code:{$in:["ADMIN","SUPER_ADMIN"]}}).select("_id");
  const count=await User.countDocuments({role:{$in:roles.map(x=>x._id)},active:true,_id:{$ne:id}});
  if(count===0)return {error:"Cannot remove the last active administrator",status:409};
 }
 return {target};
}
router.get("/",wrap(async(req,res)=>{
 const users=await User.find().select("-passwordHash").populate("role","code name active").sort({createdAt:-1}).limit(500).lean();
 res.json(users.map(safe));
}));
router.post("/",wrap(async(req,res)=>{
 const parsed=createSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({message:"Invalid user details",errors:parsed.error.flatten()});
 const {roleId,password,...rest}=parsed.data;const role=await validRole(roleId);
 if(!role)return res.status(400).json({message:"Select an active role"});
 const email=rest.email.toLowerCase();if(await User.exists({email}))return res.status(409).json({message:"Email is already registered"});
 const user=await User.create({...rest,email,role:role._id,passwordHash:await bcrypt.hash(password,12),mustChangePassword:true});
 await audit(req,"CREATE","User",user.id,null,{email:user.email,role:role.code});
 await user.populate("role","code name");res.status(201).json(safe(user));
}));
router.patch("/:id",wrap(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({message:"Invalid user ID"});
 const parsed=patchSchema.safeParse(req.body);if(!parsed.success||!Object.keys(parsed.data||{}).length)return res.status(400).json({message:"Invalid update"});
 const data=parsed.data;
 if(String(req.user._id)===req.params.id && (data.active===false||data.roleId))return res.status(400).json({message:"Cannot disable or change your own role"});
 const guard=await lastAdminProtected(req.params.id,data.roleId,data.active);if(guard.error)return res.status(guard.status).json({message:guard.error});
 if(data.roleId){const role=await validRole(data.roleId);if(!role)return res.status(400).json({message:"Invalid role"});data.role=role._id;delete data.roleId;}
 if(data.email){data.email=data.email.toLowerCase();const duplicate=await User.exists({email:data.email,_id:{$ne:req.params.id}});if(duplicate)return res.status(409).json({message:"Email is already registered"});}
 const before={name:guard.target.name,email:guard.target.email,active:guard.target.active,role:String(guard.target.role?._id)};
 const user=await User.findByIdAndUpdate(req.params.id,{$set:data},{new:true,runValidators:true}).populate("role","code name");
 await audit(req,"UPDATE","User",user.id,before,{name:user.name,email:user.email,active:user.active,role:user.role?.code});
 res.json(safe(user));
}));
router.post("/:id/reset-password",wrap(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({message:"Invalid user ID"});
 if(String(req.user._id)===req.params.id)return res.status(400).json({message:"Use change-password for your own account"});
 const parsed=passwordSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({message:"Password must be at least 12 characters"});
 const user=await User.findByIdAndUpdate(req.params.id,{$set:{passwordHash:await bcrypt.hash(parsed.data.newPassword,12),passwordChangedAt:new Date(),mustChangePassword:true}},{new:true});
 if(!user)return res.status(404).json({message:"User not found"});
 await audit(req,"RESET_PASSWORD","User",user.id,null,{userId:user.id});
 res.json({message:"Password reset. User must change password after login."});
}));
export default router;
