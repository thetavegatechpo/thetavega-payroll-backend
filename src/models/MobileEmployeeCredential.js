import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, unique: true },
  passwordHash: { type: String, required: true, select: false },
  passwordChangedAt: { type: Date, default: Date.now },
  mustChangePassword: { type: Boolean, default: false },
  failedAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null }
}, { timestamps: true });
export default mongoose.models.MobileEmployeeCredential || mongoose.model('MobileEmployeeCredential', schema);
