
import "dotenv/config";
import dns from "node:dns";

// Fix MongoDB Atlas SRV DNS resolution in Node.js
dns.setServers(["8.8.8.8", "1.1.1.1"]);

// Load application modules after DNS configuration
const { app } = await import("./app.js");
const { connectDB } = await import("./config/db.js");

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must have at least 32 characters");
}

await connectDB();

app.listen(
  Number(process.env.PORT) || 5000,
  () => console.log("API running on port " + (process.env.PORT || 5000))
);
