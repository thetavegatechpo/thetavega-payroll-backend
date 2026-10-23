import mongoose from 'mongoose';
const { Schema } = mongoose;
const gpsSchema = new Schema({
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  accuracyMeters: { type: Number, required: true, min: 0, max: 10000 },
  capturedAt: { type: Date, required: true },
  distanceMeters: { type: Number, default: null },
  withinRadius: { type: Boolean, default: null }
}, { _id: false });
const schema = new Schema({
  employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  site: { type: Schema.Types.ObjectId, ref: 'Site', required: true },
  siteSnapshot: { code: String, name: String, city: String, radiusMeters: Number },
  checkIn: { type: gpsSchema, default: null },
  checkInMethod: { type: String, enum: ['GPS','HR_EXCEPTION'], default: 'GPS' },
  checkOutMethod: { type: String, enum: ['GPS','HR_EXCEPTION'], default: null },
  indoorCheckInReason: { type: String, default: '' },
  indoorCheckOutReason: { type: String, default: '' },
  reportingTime: { type: String, default: null },
  arrivalStatus: { type: String, enum: ['ON_TIME','LATE','UNCONFIGURED'], default: 'UNCONFIGURED' },
  lateMinutes: { type: Number, default: null, min: 0 },
  checkedInAt: { type: Date, required: true },
  checkOut: { type: gpsSchema, default: null },
  checkedOutAt: { type: Date, default: null },
  open: { type: Boolean, default: true, required: true },
  checkInRequestId: { type: String, required: true },
  checkOutRequestId: { type: String, default: null },
  verificationStatus: { type: String, enum: ['PENDING','APPROVED','REJECTED'], default: 'PENDING' },
  reviewReasons: { type: [String], default: [] },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, default: '' }
}, { timestamps: true });
schema.index({ employee: 1, open: 1 }, { unique: true, partialFilterExpression: { open: true }, name: 'one_active_site_attendance' });
schema.index({ employee: 1, checkInRequestId: 1 }, { unique: true });
schema.index({ employee: 1, checkOutRequestId: 1 }, { unique: true, partialFilterExpression: { checkOutRequestId: { $type: 'string' } } });
schema.index({ checkedInAt: -1 });
export default mongoose.models.SiteAttendance || mongoose.model('SiteAttendance', schema);
