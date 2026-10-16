import jwt from "jsonwebtoken";
import {User} from "../models/index.js";
export async function authenticate(req,res,next){
  try{
    const match=/^Bearer\s+(.+)$/i.exec(req.headers.authorization||"");
    if(!match)return res.status(401).json({message:"Authentication required"});
    const decoded=jwt.verify(match[1],process.env.JWT_SECRET,{algorithms:["HS256"]});
    const user=await User.findById(decoded.sub).populate("role");
    if(!user?.active||!user.role?.active)return res.status(401).json({message:"Unauthorized"});
    if(user.passwordChangedAt && decoded.iat*1000 < user.passwordChangedAt.getTime()-1000)return res.status(401).json({message:"Please log in again"});
    req.user=user;
    next();
  }catch(_){return res.status(401).json({message:"Invalid or expired token"});}
}
export function permit(permission){
  return (req,res,next)=>{
    if(!req.user?.role?.active)return res.status(403).json({message:"Permission denied"});
    const permissions=req.user.role.permissions||[];
    if(req.user.role.code==="SUPER_ADMIN"||req.user.role.code==="ADMIN"||permissions.includes("*")||permissions.includes(permission))return next();
    return res.status(403).json({message:"Permission denied"});
  };
}
export function requireAdmin(req,res,next){
  if(["SUPER_ADMIN","ADMIN"].includes(req.user?.role?.code))return next();
  return res.status(403).json({message:"Administrator access required"});
}
