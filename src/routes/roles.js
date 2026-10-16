import {Router} from "express";
import {Role} from "../models/index.js";
import {authenticate,requireAdmin} from "../middleware/auth.js";
import {asyncHandler as wrap} from "../utils/asyncHandler.js";
const router=Router();router.use(authenticate,requireAdmin);
router.get("/",wrap(async(req,res)=>res.json(await Role.find({active:true}).select("code name permissions active").sort({code:1}).lean())));
export default router;
