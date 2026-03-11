const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../../User");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    throw new Error("Missing JWT_SECRET in environment variables");
}

router.post("/register", async (req, res) => {
    try {
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
    } catch (err) {
        res.status(500).json({ message: "Registration failed" });
    }
});

router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        const normalizedEmail = String(email || "").trim().toLowerCase();

        const users = await User.find({ email: normalizedEmail }).sort({ _id: -1 });

        if (!users.length) {
            return res.status(400).json({ message: "User not found" });
        }

        let matchedUser = null;

        for (const user of users) {
            const storedPassword = String(user.password || "");
            const hashLooksValid =
                storedPassword.startsWith("$2a$") ||
                storedPassword.startsWith("$2b$") ||
                storedPassword.startsWith("$2y$");

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

        const token = jwt.sign(
            { userId: matchedUser._id, role: matchedUser.role },
            JWT_SECRET,
            { expiresIn: "1d" }
        );

        res.json({
            message: "Login successful",
            token,
            userId: matchedUser._id.toString(),
            role: matchedUser.role
        });
    } catch (err) {
        res.status(500).json({ message: "Login failed" });
    }
});

module.exports = router;
