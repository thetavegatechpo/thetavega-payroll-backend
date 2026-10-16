
import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";

import {
  Department,
  Designation
} from "../models/index.js";

import { authenticate, permit } from "../middleware/auth.js";
import { asyncHandler as wrap } from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";

const router = Router();
router.use(authenticate);

const baseSchema = z.object({
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(150),
  active: z.boolean().optional()
}).strict();

const designationSchema = baseSchema.extend({
  department: z.string().nullable().optional()
});

for (const [path, Model] of [
  ["departments", Department],
  ["designations", Designation]
]) {
  const isDesignation = path === "designations";
  const schema = isDesignation ? designationSchema : baseSchema;

  router.get(
    "/" + path,
    permit("master:read"),
    wrap(async (req, res) => {
      let query = Model.find({}).sort({ name: 1 });

      if (isDesignation) {
        query = query.populate("department", "code name active");
      }

      res.json(await query.lean());
    })
  );

  router.post(
    "/" + path,
    permit("master:write"),
    wrap(async (req, res) => {
      const data = schema.parse(req.body);

      if (isDesignation && data.department) {
        if (!mongoose.isValidObjectId(data.department)) {
          return res.status(400).json({
            message: "Invalid department ID"
          });
        }

        const exists = await Department.exists({
          _id: data.department,
          active: true
        });

        if (!exists) {
          return res.status(400).json({
            message: "Select an active department"
          });
        }
      }

      if (isDesignation && !data.department) {
        data.department = null;
      }

      const doc = await Model.create(data);

      await audit(
        req,
        "CREATE",
        path,
        doc.id,
        null,
        doc.toObject()
      );

      res.status(201).json(doc);
    })
  );

  router.patch(
    "/" + path + "/:id",
    permit("master:write"),
    wrap(async (req, res) => {
      const data = schema.partial().parse(req.body);

      if (isDesignation && data.department) {
        if (!mongoose.isValidObjectId(data.department)) {
          return res.status(400).json({
            message: "Invalid department ID"
          });
        }

        const exists = await Department.exists({
          _id: data.department,
          active: true
        });

        if (!exists) {
          return res.status(400).json({
            message: "Select an active department"
          });
        }
      }

      const before = await Model.findById(req.params.id);

      if (!before) {
        return res.status(404).json({
          message: "Not found"
        });
      }

      const after = await Model.findByIdAndUpdate(
        req.params.id,
        { $set: data },
        { new: true, runValidators: true }
      );

      await audit(
        req,
        "UPDATE",
        path,
        after.id,
        before.toObject(),
        after.toObject()
      );

      res.json(after);
    })
  );
}

export default router;
