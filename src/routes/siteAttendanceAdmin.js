import { Router } from 'express';
import { z } from 'zod';
import SiteAttendance from '../models/SiteAttendance.js';
import { authenticate, permit } from '../middleware/auth.js';
import { asyncHandler as wrap } from '../utils/asyncHandler.js';
import mongoose from 'mongoose';
const router=Router();
router.use(authenticate);
router.get('/',permit('attendance:review'),wrap(async(req,res)=>{
 const results=await SiteAttendance.find({}).sort({checkedInAt:-1}).limit(100).populate('employee','employeeCode firstName lastName').lean();
 res.json({attendance:results});
}));
router.patch('/:id/review',permit('attendance:review'),wrap(async(req,res)=>{
 if(!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid attendance ID'});
 const parsed=z.object({status:z.enum(['APPROVED','REJECTED']),note:z.string().trim().max(500).default('')}).strict().safeParse(req.body);
 if(!parsed.success)return res.status(400).json({message:'Invalid review payload'});
 const current=await SiteAttendance.findById(req.params.id);
 if(!current)return res.status(404).json({message:'Attendance not found'});
 if(current.open)return res.status(409).json({message:'Checkout is required before approval. Use HR correction process for missing checkout.'});
 if(current.verificationStatus!=='PENDING')return res.status(409).json({message:'Already reviewed'});
 const isIndoor = current.checkInMethod === 'HR_EXCEPTION' || current.checkOutMethod === 'HR_EXCEPTION';
 if(isIndoor && parsed.data.status === 'APPROVED' && parsed.data.note.trim().length < 20)
   return res.status(400).json({message:'Indoor exception approval requires an independent verification note (at least 20 characters).'});
 const updated=await SiteAttendance.findOneAndUpdate({_id:current._id,open:false,verificationStatus:'PENDING'},
 {$set:{verificationStatus:parsed.data.status,reviewNote:parsed.data.note,reviewedBy:req.user._id,reviewedAt:new Date()}},{new:true});
 if(!updated)return res.status(409).json({message:'Already reviewed'});
 res.json({attendance:updated});
}));
export default router;
