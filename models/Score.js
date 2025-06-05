const mongoose = require("mongoose")

const scoreSchema = new mongoose.Schema({
  playerName: {
    type: String,
    required: true,
    trim: true,
  },
  score: {
    type: Number,
    required: true,
    min: 0,
  },
  date: {
    type: Date,
    default: Date.now,
  },
})

// Index for better query performance
scoreSchema.index({ score: -1, date: -1 })

module.exports = mongoose.model("Score", scoreSchema)
