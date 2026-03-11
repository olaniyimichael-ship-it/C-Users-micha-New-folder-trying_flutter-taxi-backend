// User model for Node.js backend (example)

const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
    name: String,
    email: String,
    password: String,
    role: String
});

module.exports = mongoose.model("User", UserSchema);
