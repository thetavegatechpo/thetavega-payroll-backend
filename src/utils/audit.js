import {AuditLog} from "../models/index.js";
export async function audit(req,action,entity,entityId,before,after){await AuditLog.create({actor:req.user?._id,action,entity,entityId:String(entityId),before,after,ip:req.ip});}
