import mobilePayroll from "./routes/mobilePayroll.js";
import sites from "./routes/sites.js";
import payrollOperations from "./routes/payrollOperations.js";
import company from "./routes/company.js";
import users from "./routes/users.js";
import roles from "./routes/roles.js";
import account from "./routes/account.js";
import payslips from "./routes/payslips.js";
import payrollPolicy from "./routes/payrollPolicy.js";
import monthlyPayroll from "./routes/monthlyPayroll.js";
import mobileAuth from "./routes/mobileAuth.js";

import mobileAttendance from "./routes/mobileAttendance.js";
import siteAttendanceAdmin from "./routes/siteAttendanceAdmin.js";

import express from "express";import cors from "cors";import helmet from "helmet";import morgan from "morgan";import rateLimit from "express-rate-limit";import auth from "./routes/auth.js";import masters from "./routes/master.js";import employees from "./routes/employees.js";import config from "./routes/config.js";import {errors} from "./middleware/errors.js";import salaryStructures from "./routes/salaryStructures.js";
export const app=express();app.use(helmet());app.use(cors({origin:(process.env.CORS_ORIGIN||"http://localhost:5173").split(",")}));app.use(express.json({limit:"100kb"}));app.use(morgan("combined"));
app.get("/api/health",(req,res)=>res.json({success:true,service:"thetavega-payroll",status:"UP"}));
app.use("/api/auth",rateLimit({windowMs:15*60*1000,limit:15,standardHeaders:"draft-7",legacyHeaders:false}),auth);
app.use("/api/company",company);app.use("/api/users",users);app.use("/api/roles",roles);app.use("/api/account",account);app.use("/api/masters",masters);app.use("/api/sites",sites);app.use("/api/employees",employees);app.use("/api/config",config);app.use("/api/salary-structures",salaryStructures);app.use("/api/payroll",monthlyPayroll);app.use("/api/payroll-policy",payrollPolicy);app.use("/api/payslips",payslips);app.use("/api/payroll-operations",payrollOperations);
app.use("/api/mobile/auth", mobileAuth);

app.use("/api/mobile", mobileAttendance);
app.use("/api/mobile/payroll", mobilePayroll);

app.use(
  "/api/admin/site-attendance",
  siteAttendanceAdmin
);

app.use((req,res)=>res.status(404).json({message:"Route not found"}));app.use(errors);
