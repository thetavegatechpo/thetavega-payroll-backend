import {Router} from "express";
import bcrypt from "bcryptjs";
import {z} from "zod";
import {User} from "../models/index.js";
import {authenticate} from "../middleware/auth.js";
import {asyncHandler as wrap} from "../utils/asyncHandler.js";
import {audit} from "../utils/audit.js";
const router=Router();router.use(authenticate);
router.post("/change-password",wrap(async(req,res)=>{
 const parsed=z.object({currentPassword:z.string().min(1),newPassword:z.string().min(12).max(128)}).safeParse(req.body);
 if(!parsed.success)return res.status(400).json({message:"New password must be at least 12 characters"});
 if(!await bcrypt.compare(parsed.data.currentPassword,req.user.passwordHash))return res.status(400).json({message:"Current password is incorrect"});
 if(parsed.data.currentPassword===parsed.data.newPassword)return res.status(400).json({message:"Choose a different password"});
 await User.updateOne({_id:req.user._id},{$set:{passwordHash:await bcrypt.hash(parsed.data.newPassword,12),passwordChangedAt:new Date(),mustChangePassword:false}});
 await audit(req,"CHANGE_PASSWORD","User",req.user._id,null,{userId:String(req.user._id)});
 res.json({message:"Password changed. Please sign in again."});
}));
export default router;
