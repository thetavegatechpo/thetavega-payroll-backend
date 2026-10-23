import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import SiteAttendance from '../models/SiteAttendance.js';
import { authenticate, permit } from '../middleware/auth.js';
import { asyncHandler as wrap } from '../utils/asyncHandler.js';

const router = Router();
router.use(authenticate);

// Only attendance reviewers can see location evidence and employee records.
router.get('/', permit('attendance:review'), wrap(async (req, res) => {
  const query = z.object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    status: z.enum(['ALL','PENDING','APPROVED','REJECTED']).default('ALL'),
    visit: z.enum(['ALL','OPEN','CLOSED']).default('ALL'),
    from: z.string().datetime({offset:true}).optional(),
    to: z.string().datetime({offset:true}).optional()
  }).strict().safeParse(req.query);
  if (!query.success) return res.status(400).json({message:'Invalid attendance filters'});
  const q = query.data;
  const filter = {};
  if (q.status !== 'ALL') filter.verificationStatus = q.status;
  if (q.visit !== 'ALL') filter.open = q.visit === 'OPEN';
  if (q.from || q.to) {
    filter.checkedInAt = {};
    if (q.from) filter.checkedInAt.$gte = new Date(q.from);
    if (q.to) filter.checkedInAt.$lt = new Date(q.to);
    if (q.from && q.to && new Date(q.from) >= new Date(q.to))
      return res.status(400).json({message:'Invalid date range'});
  }
  const [attendance, total] = await Promise.all([
    SiteAttendance.find(filter).sort({checkedInAt:-1,_id:-1})
      .skip((q.page-1)*q.limit).limit(q.limit)
      .populate('employee','employeeCode firstName lastName')
      .populate('site','code name city taPolicy fixedDailyTA')
      .lean(),
    SiteAttendance.countDocuments(filter)
  ]);
  res.json({attendance,total,page:q.page,limit:q.limit,pages:Math.ceil(total/q.limit)});
}));

router.patch('/:id/review', permit('attendance:review'), wrap(async (req,res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid attendance ID'});
  const parsed = z.object({
    status:z.enum(['APPROVED','REJECTED']),
    note:z.string().trim().max(500).default('')
  }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({message:'Invalid review payload'});
  const current = await SiteAttendance.findById(req.params.id);
  if (!current) return res.status(404).json({message:'Attendance not found'});
  if (current.open) return res.status(409).json({message:'Checkout is required before approval. Use HR correction process for missing checkout.'});
  if (current.verificationStatus !== 'PENDING') return res.status(409).json({message:'Already reviewed'});
  const indoor = current.checkInMethod === 'HR_EXCEPTION' || current.checkOutMethod === 'HR_EXCEPTION';
  if (indoor && parsed.data.status === 'APPROVED' && parsed.data.note.length < 20)
    return res.status(400).json({message:'Indoor exception approval requires an independent verification note (at least 20 characters).'});
  const updated = await SiteAttendance.findOneAndUpdate(
    {_id:current._id,open:false,verificationStatus:'PENDING'},
    {$set:{verificationStatus:parsed.data.status,reviewNote:parsed.data.note,reviewedBy:req.user._id,reviewedAt:new Date()}},
    {new:true}
  );
  if (!updated) return res.status(409).json({message:'Already reviewed'});
  res.json({attendance:updated});
}));
export default router;
