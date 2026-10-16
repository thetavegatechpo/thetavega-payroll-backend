import mongoose from "mongoose";
const { Schema } = mongoose;
// New model: preserved effective-dated revisions; existing Phase 1 models remain unchanged.
const itemSchema = new Schema({
  component: { type: Schema.Types.ObjectId, ref: "SalaryComponent", required: true },
  code: { type: String, required: true },
  name: { type: String, required: true },
  amount: { type: Schema.Types.Decimal128, required: true },
  proratable: { type: Boolean, required: true }
}, { _id: false });
const schema = new Schema({
 employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
 revision: { type: Number, required: true },
 effectiveFrom: { type: String, required: true }, // YYYY-MM-DD, company-local calendar date
 notes: { type: String, default: "" },
 items: { type: [itemSchema], required: true },
 monthlyGross: { type: Schema.Types.Decimal128, required: true },
 createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true, collection: "employee_salary_revisions" });
schema.index({ employee: 1, effectiveFrom: 1 }, { unique: true });
schema.index({ employee: 1, revision: 1 }, { unique: true });
export default mongoose.model("EmployeeSalaryRevision", schema);
