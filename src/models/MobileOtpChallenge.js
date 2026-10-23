import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  mobile: { type: String, required: true },
  otpHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ mobile: 1, createdAt: -1 });
export default mongoose.models.MobileOtpChallenge || mongoose.model('MobileOtpChallenge', schema);
