
import "dotenv/config";
import dns from "node:dns";

// Fix MongoDB Atlas SRV DNS resolution
dns.setServers(["8.8.8.8", "1.1.1.1"]);

// Import database-dependent modules after DNS setup
const { connectDB } = await import("../config/db.js");
const { Role, User, Setting, SalaryComponent } =
  await import("../models/index.js");

const { default: bcrypt } = await import("bcryptjs");

await connectDB();

// Create roles
const roles = [
  {
    code: "ADMIN",
    name: "Administrator",
    permissions: ["*"],
  },
  {
    code: "HR",
    name: "HR / Payroll",
    permissions: [
      "employee:read",
      "employee:write",
      "master:read",
      "master:write",
      "config:read",
      "salary:write",
    ],
  },
  {
    code: "VIEWER",
    name: "Read Only",
    permissions: [
      "employee:read",
      "master:read",
      "config:read",
    ],
  },
];

for (const role of roles) {
  await Role.updateOne(
    { code: role.code },
    { $setOnInsert: role },
    { upsert: true }
  );
}

// Create administrator
const admin = await Role.findOne({ code: "ADMIN" });

if (
  !process.env.ADMIN_EMAIL ||
  !process.env.ADMIN_PASSWORD ||
  process.env.ADMIN_PASSWORD.length < 12
) {
  throw new Error(
    "Set ADMIN_EMAIL and strong ADMIN_PASSWORD"
  );
}

await User.updateOne(
  { email: process.env.ADMIN_EMAIL.toLowerCase() },
  {
    $setOnInsert: {
      name: "System Administrator",
      email: process.env.ADMIN_EMAIL.toLowerCase(),
      passwordHash: await bcrypt.hash(
        process.env.ADMIN_PASSWORD,
        12
      ),
      role: admin._id,
    },
  },
  { upsert: true }
);

// Default settings
const settings = {
  companyName: "THETAVEGA TECH PVT LTD",
  currency: "INR",
  timezone: "Asia/Kolkata",
  salaryBasis: "CALENDAR_DAYS",
  weeklyOffPaid: true,
  holidayPaid: true,
  overtimeMode: "MANUAL_AMOUNT",
  deductionMode: "CONFIGURABLE",
  approvalRole: "ADMIN",
  employeeCodePrefix: "TT/E/",
};

for (const [key, value] of Object.entries(settings)) {
  await Setting.updateOne(
    { key },
    { $setOnInsert: { key, value } },
    { upsert: true }
  );
}

// Salary components
const components = [
  ["BASIC", "Basic Salary", "EARNING"],
  ["HRA", "House Rent Allowance", "EARNING"],
  ["CONVEYANCE", "Conveyance Allowance", "EARNING"],
  ["MEDICAL", "Medical Allowance", "EARNING"],
  ["OTHER", "Other Allowance", "EARNING"],
  ["PF", "Provident Fund", "DEDUCTION"],
  ["ESIC", "Employee State Insurance", "DEDUCTION"],
  ["PT", "Professional Tax", "DEDUCTION"],
  ["TDS", "Tax Deducted at Source", "DEDUCTION"],
];

for (const [code, name, type] of components) {
  await SalaryComponent.updateOne(
    { code },
    {
      $setOnInsert: {
        code,
        name,
        type,
        calculationType: "FIXED",
        active: true,
      },
    },
    { upsert: true }
  );
}

console.log(
  "Initial roles, administrator and configuration seeded"
);

process.exit(0);
