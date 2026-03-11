const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/authRoutes");
const rideRoutes = require("./routes/rideRoutes");

const app = express();

const corsOriginRaw = process.env.CORS_ORIGIN || "*";
const corsOrigins = corsOriginRaw
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);

const corsOptions = {
	origin: (origin, callback) => {
		if (!origin || corsOrigins.includes("*") || corsOrigins.includes(origin)) {
			callback(null, true);
			return;
		}
		callback(new Error("Not allowed by CORS"));
	},
};

app.use(cors(corsOptions));
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/rides", rideRoutes);

module.exports = app;
