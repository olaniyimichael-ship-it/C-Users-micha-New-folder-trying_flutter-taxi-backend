require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();
const JWT_SECRET = process.env.JWT_SECRET;

if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI in environment variables");
}

if (!JWT_SECRET) {
    throw new Error("Missing JWT_SECRET in environment variables");
}

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
.then(() => console.log("Database connected"))
.catch(err => console.log(err));

app.use(cors());

app.use(express.json());

const User = require("./User");
const Ride = require("./models/Ride");

function authMiddleware(req, res, next) {

    const authHeader = req.headers["authorization"];

    if (!authHeader) {
        return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.startsWith("Bearer ")
        ? authHeader.split(" ")[1]
        : authHeader;

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ message: "Invalid token" });
    }
}

// Test route
app.get("/", (req, res) => {
    res.send("Taxi Backend Running");
});


app.post("/register", async (req, res) => {

    const { name, email, password, role } = req.body;

    const normalizedEmail = String(email || "").trim().toLowerCase();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
        return res.status(400).json({ message: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
        name,
        email: normalizedEmail,
        password: hashedPassword,
        role
    });

    await newUser.save();

    res.json({ message: "User registered" });
});

app.post("/login", async (req, res) => {

    const { email, password } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();

    const users = await User.find({ email: normalizedEmail }).sort({ _id: -1 });

    if (!users.length) {
        return res.status(400).json({ message: "User not found" });
    }

    let matchedUser = null;

    for (const user of users) {
        const storedPassword = String(user.password || "");
        const hashLooksValid = storedPassword.startsWith("$2a$") || storedPassword.startsWith("$2b$") || storedPassword.startsWith("$2y$");

        if (hashLooksValid) {
            const isMatch = await bcrypt.compare(password, storedPassword);
            if (isMatch) {
                matchedUser = user;
                break;
            }
        } else if (storedPassword === password) {
            user.password = await bcrypt.hash(password, 10);
            await user.save();
            matchedUser = user;
            break;
        }
    }

    if (!matchedUser) {
        return res.status(400).json({ message: "Invalid credentials" });
    }

    const user = matchedUser;

    const token = jwt.sign(
        { userId: user._id, role: user.role },
        JWT_SECRET,
        { expiresIn: "1d" }
    );

    res.json({
        message: "Login successful",
        token: token,
        role: user.role
    });
});

app.use(authMiddleware);

app.post("/book-ride", authMiddleware, async (req, res) => {
    const riderId = req.user.userId;

    const ride = new Ride({
        riderId: riderId,
        pickup: req.body.pickup,
        drop: req.body.drop,
        status: "pending"
    });

    await ride.save();

    res.json({
        message: "Ride Booked",
        rideId: ride._id.toString()
    });
});

app.get("/rides", async (req, res) => {
    try {
        const rides = await Ride.find();
        res.json(rides);
    } catch (err) {
        res.status(500).send("Error fetching rides");
    }
});

app.get("/my-rides/:userId", async (req, res) => {
    try {
        const rides = await Ride.find({ riderId: req.user.userId });
        res.json(rides);
    } catch (err) {
        res.status(500).send("Error fetching rides");
    }
});

app.get("/rides/:riderId", async (req, res) => {
    try {
        const rides = await Ride.find({ riderId: req.user.userId });
        res.json(rides);
    } catch (err) {
        res.status(500).send("Error fetching rides");
    }
});

app.get("/ride/:id", async (req, res) => {
    try {
        const ride = await Ride.findById(req.params.id);
        res.json(ride);
    } catch (err) {
        res.status(500).send("Error fetching ride");
    }
});

app.put("/ride/:id", async (req, res) => {
    try {
        const ride = await Ride.findByIdAndUpdate(
            req.params.id,
            { status: req.body.status },
            { returnDocument: 'after' }
        );
        res.json(ride);
    } catch (err) {
        res.status(500).send("Error updating ride");
    }
});

app.put("/accept-ride/:rideId", async (req, res) => {
    try {
        const driverId = req.user.userId;

        const ride = await Ride.findByIdAndUpdate(
            req.params.rideId,
            { 
              status: "accepted",
              driverId: driverId
            },
                        { returnDocument: 'after' }
        );

        res.json({
            message: "Ride accepted successfully",
            ride: ride
        });
    } catch (err) {
        res.status(500).send("Error accepting ride");
    }
});

app.put("/update-ride-status/:rideId", async (req, res) => {
    try {
        const { status } = req.body;
        const driverId = req.user.userId;

        const existingRide = await Ride.findById(req.params.rideId);
        if (!existingRide) {
            return res.status(404).json({ message: "Ride not found" });
        }

        if (String(existingRide.driverId || "") !== String(driverId)) {
            return res.status(403).json({ message: "Not authorized for this ride" });
        }

        const ride = await Ride.findByIdAndUpdate(
            req.params.rideId,
            { status: status },
            { returnDocument: 'after' }
        );

        res.json(ride);
    } catch (err) {
        res.status(500).send("Error updating ride status");
    }
});

app.get("/pending-rides", async (req, res) => {
    try {
        const rides = await Ride.find({ status: "pending" });
        res.json(rides);
    } catch (err) {
        res.status(500).send("Error fetching pending rides");
    }
});

app.get("/driver-rides", async (req, res) => {
    try {
        const driverId = req.user.userId;
        const rides = await Ride.find({
            $or: [
                { status: "pending" },
                { driverId: driverId }
            ]
        });
        res.json(rides);
    } catch (err) {
        res.status(500).send("Error fetching driver rides");
    }
});

app.listen(5000, () => {
    console.log("Server running on port 5000");
});
