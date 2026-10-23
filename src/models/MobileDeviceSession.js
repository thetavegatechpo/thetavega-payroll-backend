import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ employee: 1, revokedAt: 1 });
export default mongoose.models.MobileDeviceSession || mongoose.model('MobileDeviceSession', schema);
