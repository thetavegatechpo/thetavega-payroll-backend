import mongoose from "mongoose";
const { Schema } = mongoose;
const siteSchema = new Schema({
  code: { type: String, required: true, trim: true, uppercase: true, unique: true, maxlength: 30 },
  customerName: { type: String, required: true, trim: true, maxlength: 150 },
  name: { type: String, required: true, trim: true, maxlength: 150 },
  city: { type: String, required: true, trim: true, maxlength: 100 },
  state: { type: String, required: true, trim: true, maxlength: 100 },
  distanceKm: { type: Number, default: 0, min: 0 },
  address: { type: String, required: true, trim: true, maxlength: 500 },
  reportingTime: { type: String, required: true, default: "09:30", match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  taPolicy: { type: String, enum: ["NONE", "FIXED", "ACTUAL", "BOTH"], default: "NONE" },
  fixedDailyTA: { type: Number, default: 0, min: 0 },
  gps: { latitude: { type: Number, min: -90, max: 90 }, longitude: { type: Number, min: -180, max: 180 }, radiusMeters: { type: Number, min: 50, max: 10000, default: 200 } },
  active: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User" }
}, { timestamps: true });
export default mongoose.models.Site || mongoose.model("Site", siteSchema);
