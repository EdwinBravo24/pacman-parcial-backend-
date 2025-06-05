const express = require("express")
const router = express.Router()
const Score = require("../models/Score")

// GET /api/leaderboard - Get top scores
router.get("/", async (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit) || 10

    const scores = await Score.find().sort({ score: -1, date: -1 }).limit(limit).select("playerName score date")

    res.json(scores)
  } catch (error) {
    console.error("Error fetching leaderboard:", error)
    res.status(500).json({ error: "Failed to fetch leaderboard data" })
  }
})

// POST /api/leaderboard - Add new score
router.post("/", async (req, res) => {
  try {
    const { playerName, score } = req.body

    if (!playerName || typeof score !== "number") {
      return res.status(400).json({ error: "Player name and score are required" })
    }

    const newScore = new Score({
      playerName: playerName.trim(),
      score: Math.max(0, score), // Ensure score is not negative
      date: new Date(),
    })

    await newScore.save()

    res.status(201).json({
      message: "Score saved successfully",
      score: newScore,
    })
  } catch (error) {
    console.error("Error saving score:", error)
    res.status(500).json({ error: "Failed to save score" })
  }
})

// GET /api/leaderboard/player/:name - Get scores for specific player
router.get("/player/:name", async (req, res) => {
  try {
    const playerName = req.params.name
    const limit = Number.parseInt(req.query.limit) || 10

    const scores = await Score.find({
      playerName: new RegExp(playerName, "i"),
    })
      .sort({ score: -1, date: -1 })
      .limit(limit)
      .select("playerName score date")

    res.json(scores)
  } catch (error) {
    console.error("Error fetching player scores:", error)
    res.status(500).json({ error: "Failed to fetch player scores" })
  }
})

module.exports = router
