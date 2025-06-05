const express = require("express")
const { createServer } = require("http")
const { Server } = require("socket.io")
const mongoose = require("mongoose")
const cors = require("cors")
require("dotenv").config()

// Import routes
const leaderboardRoutes = require("./routes/leaderboard")

// Initialize Express app
const app = express()
const server = createServer(app)

// Configure CORS for production
const corsOptions = {
  origin: true, // Allow all origins for now
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
}

app.use(cors(corsOptions))
app.use(express.json())

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    message: "🎮 Pac-Man Multiplayer Backend is running!",
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    version: "1.0.0",
  })
})

// API routes
app.use("/api/leaderboard", leaderboardRoutes)

// Initialize Socket.IO
const io = new Server(server, {
  cors: corsOptions,
  transports: ["websocket", "polling"],
  allowEIO3: true,
})

// Game state
let gameState = {
  player1: { x: 1, y: 1, direction: "right", score: 0, lives: 5, invulnerable: false, invulnerableTime: 0 },
  player2: { x: 26, y: 1, direction: "left", score: 0, lives: 5, invulnerable: false, invulnerableTime: 0 },
  dots: [],
  powerPellets: [],
  ghosts: [
    { x: 13, y: 14, direction: "up", color: "red", speed: 1, target: null },
    { x: 14, y: 14, direction: "up", color: "pink", speed: 1, target: null },
    { x: 13, y: 15, direction: "left", color: "cyan", speed: 1, target: null },
    { x: 14, y: 15, direction: "right", color: "orange", speed: 1, target: null },
  ],
  gameOver: false,
  winner: null,
  powerMode: false,
  powerModeTime: 0,
}

// Arduino connection status
let arduinoConnected = false
const connectedBridges = new Set()

// Connect to MongoDB
const connectDB = async () => {
  try {
    if (process.env.MONGODB_URI) {
      await mongoose.connect(process.env.MONGODB_URI)
      console.log("✅ MongoDB connected")
    } else {
      console.log("⚠️ MongoDB URI not provided, using in-memory storage")
    }
  } catch (err) {
    console.error("❌ MongoDB connection error:", err)
    console.log("⚠️ Continuing without database...")
  }
}

connectDB()

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("👤 New client connected:", socket.id)

  // Send current Arduino status
  socket.emit("arduino-status", {
    connected: arduinoConnected || connectedBridges.size > 0,
    bridges: connectedBridges.size,
  })

  // Handle Arduino bridge registration
  socket.on("register-arduino-bridge", (data) => {
    console.log("🌉 Arduino Bridge connected:", socket.id)
    socket.isBridge = true
    connectedBridges.add(socket.id)
    arduinoConnected = true

    io.emit("arduino-status", {
      connected: true,
      bridge: true,
      bridges: connectedBridges.size,
    })
  })

  // Handle Arduino input from bridge
  socket.on("arduino-input", (input) => {
    console.log("🎮 Arduino input received:", input)
    updatePlayerDirection(gameState.player1, input)
    io.emit("arduino-input", input)
    io.emit("game-update", gameState)
  })

  // Handle player input
  socket.on("player-input", ({ player, input }) => {
    if (player === 1) {
      updatePlayerDirection(gameState.player1, input)
    } else if (player === 2) {
      updatePlayerDirection(gameState.player2, input)
    }
  })

  // Handle game start
  socket.on("start-game", ({ player1Name, player2Name }) => {
    console.log(`🎮 Starting game: ${player1Name} vs ${player2Name}`)
    resetGameState()
    gameState.player1.name = player1Name
    gameState.player2.name = player2Name

    if (!gameLoopInterval) {
      startGameLoop()
    }

    io.emit("game-started", { player1Name, player2Name })
  })

  // Manual Arduino control
  socket.on("arduino-manual-press", (direction) => {
    const input = { up: false, down: false, left: false, right: false }

    switch (direction.toUpperCase()) {
      case "UP":
        input.up = true
        break
      case "DOWN":
        input.down = true
        break
      case "LEFT":
        input.left = true
        break
      case "RIGHT":
        input.right = true
        break
    }

    updatePlayerDirection(gameState.player1, input)
    io.emit("arduino-input", input)
    io.emit("game-update", gameState)
  })

  // Handle disconnect
  socket.on("disconnect", () => {
    if (socket.isBridge) {
      console.log("🌉 Arduino Bridge disconnected:", socket.id)
      connectedBridges.delete(socket.id)

      if (connectedBridges.size === 0) {
        arduinoConnected = false
      }

      io.emit("arduino-status", {
        connected: connectedBridges.size > 0,
        bridge: connectedBridges.size > 0,
        bridges: connectedBridges.size,
      })
    }
  })
})

// Game functions
function updatePlayerDirection(player, input) {
  if (input.up) player.direction = "up"
  else if (input.down) player.direction = "down"
  else if (input.left) player.direction = "left"
  else if (input.right) player.direction = "right"
}

let gameLoopInterval = null

function startGameLoop() {
  if (gameLoopInterval) clearInterval(gameLoopInterval)

  gameLoopInterval = setInterval(() => {
    updateInvulnerability()
    updatePowerMode()
    movePlayer(gameState.player1)
    movePlayer(gameState.player2)
    moveGhosts()
    checkCollisions()
    checkGameOver()
    io.emit("game-update", gameState)

    if (gameState.gameOver) {
      clearInterval(gameLoopInterval)
      gameLoopInterval = null
      saveScores()
    }
  }, 150)
}

function updateInvulnerability() {
  const currentTime = Date.now()

  if (gameState.player1.invulnerable && currentTime - gameState.player1.invulnerableTime > 3000) {
    gameState.player1.invulnerable = false
  }

  if (gameState.player2.invulnerable && currentTime - gameState.player2.invulnerableTime > 3000) {
    gameState.player2.invulnerable = false
  }
}

function updatePowerMode() {
  if (gameState.powerMode) {
    const currentTime = Date.now()
    if (currentTime - gameState.powerModeTime > 10000) {
      gameState.powerMode = false
      gameState.ghosts.forEach((ghost) => {
        if (ghost.color === "blue" && ghost.originalColor) {
          ghost.color = ghost.originalColor
          delete ghost.originalColor
        }
      })
    }
  }
}

function resetGameState() {
  gameState = {
    player1: { x: 1, y: 1, direction: "right", score: 0, lives: 5, invulnerable: false, invulnerableTime: 0, name: "" },
    player2: { x: 26, y: 1, direction: "left", score: 0, lives: 5, invulnerable: false, invulnerableTime: 0, name: "" },
    dots: [],
    powerPellets: [],
    ghosts: [
      { x: 13, y: 14, direction: "up", color: "red", speed: 1, target: null },
      { x: 14, y: 14, direction: "up", color: "pink", speed: 1, target: null },
      { x: 13, y: 15, direction: "left", color: "cyan", speed: 1, target: null },
      { x: 14, y: 15, direction: "right", color: "orange", speed: 1, target: null },
    ],
    gameOver: false,
    winner: null,
    powerMode: false,
    powerModeTime: 0,
  }

  // Initialize maze
  const MAZE_LAYOUT = [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1],
    [1, 3, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 3, 1],
    [1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 2, 2, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 2, 2, 2, 2, 2, 2, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 2, 2, 2, 2, 2, 2, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1],
    [1, 3, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 3, 1],
    [1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1],
    [1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ]

  for (let y = 0; y < MAZE_LAYOUT.length; y++) {
    for (let x = 0; x < MAZE_LAYOUT[y].length; x++) {
      if (MAZE_LAYOUT[y][x] === 0) {
        gameState.dots.push({ x, y })
      } else if (MAZE_LAYOUT[y][x] === 3) {
        gameState.powerPellets.push({ x, y })
      }
    }
  }
}

function movePlayer(player) {
  const MAZE_LAYOUT = [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1],
    [1, 3, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 3, 1],
    [1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 2, 2, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 2, 2, 2, 2, 2, 2, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 2, 2, 2, 2, 2, 2, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1],
    [1, 3, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 3, 1],
    [1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1],
    [1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ]

  let newX = player.x
  let newY = player.y

  switch (player.direction) {
    case "up":
      newY--
      break
    case "down":
      newY++
      break
    case "left":
      newX--
      break
    case "right":
      newX++
      break
  }

  // Handle tunnel
  if (newX < 0) newX = 27
  if (newX > 27) newX = 0

  // Check bounds and walls
  if (
    newY >= 0 &&
    newY < MAZE_LAYOUT.length &&
    newX >= 0 &&
    newX < MAZE_LAYOUT[0].length &&
    MAZE_LAYOUT[newY][newX] !== 1
  ) {
    player.x = newX
    player.y = newY
  }
}

function moveGhosts() {
  gameState.ghosts.forEach((ghost, index) => {
    let target = null

    if (gameState.powerMode) {
      // Run away from players
      const player1Distance = Math.abs(ghost.x - gameState.player1.x) + Math.abs(ghost.y - gameState.player1.y)
      const player2Distance = Math.abs(ghost.x - gameState.player2.x) + Math.abs(ghost.y - gameState.player2.y)

      if (player1Distance < player2Distance) {
        target = {
          x: ghost.x + (ghost.x - gameState.player1.x),
          y: ghost.y + (ghost.y - gameState.player1.y),
        }
      } else {
        target = {
          x: ghost.x + (ghost.x - gameState.player2.x),
          y: ghost.y + (ghost.y - gameState.player2.y),
        }
      }
    } else {
      // Target players
      switch (index) {
        case 0:
          target = { x: gameState.player1.x, y: gameState.player1.y }
          break
        case 1:
          target = { x: gameState.player2.x, y: gameState.player2.y }
          break
        case 2:
          if (gameState.player1.score >= gameState.player2.score) {
            target = { x: gameState.player1.x, y: gameState.player1.y }
          } else {
            target = { x: gameState.player2.x, y: gameState.player2.y }
          }
          break
        case 3:
          if (Math.random() < 0.3) {
            const player1Distance = Math.abs(ghost.x - gameState.player1.x) + Math.abs(ghost.y - gameState.player1.y)
            const player2Distance = Math.abs(ghost.x - gameState.player2.x) + Math.abs(ghost.y - gameState.player2.y)

            if (player1Distance < player2Distance) {
              target = { x: gameState.player1.x, y: gameState.player1.y }
            } else {
              target = { x: gameState.player2.x, y: gameState.player2.y }
            }
          }
          break
      }
    }

    let newX = ghost.x
    let newY = ghost.y

    if (target) {
      const deltaX = target.x - ghost.x
      const deltaY = target.y - ghost.y

      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        if (deltaX > 0) {
          newX++
          ghost.direction = "right"
        } else {
          newX--
          ghost.direction = "left"
        }
      } else {
        if (deltaY > 0) {
          newY++
          ghost.direction = "down"
        } else {
          newY--
          ghost.direction = "up"
        }
      }
    } else {
      // Random movement
      const directions = ["up", "down", "left", "right"]
      ghost.direction = directions[Math.floor(Math.random() * directions.length)]

      switch (ghost.direction) {
        case "up":
          newY--
          break
        case "down":
          newY++
          break
        case "left":
          newX--
          break
        case "right":
          newX++
          break
      }
    }

    // Handle tunnel
    if (newX < 0) newX = 27
    if (newX > 27) newX = 0

    // Simple bounds checking
    if (newX >= 0 && newX < 28 && newY >= 0 && newY < 31) {
      ghost.x = newX
      ghost.y = newY
    }
  })
}

function checkCollisions() {
  // Check dot collection
  gameState.dots = gameState.dots.filter((dot) => {
    if (
      (dot.x === gameState.player1.x && dot.y === gameState.player1.y) ||
      (dot.x === gameState.player2.x && dot.y === gameState.player2.y)
    ) {
      if (dot.x === gameState.player1.x && dot.y === gameState.player1.y) {
        gameState.player1.score += 10
      }
      if (dot.x === gameState.player2.x && dot.y === gameState.player2.y) {
        gameState.player2.score += 10
      }
      return false
    }
    return true
  })

  // Check power pellet collection
  gameState.powerPellets = gameState.powerPellets.filter((pellet) => {
    if (
      (pellet.x === gameState.player1.x && pellet.y === gameState.player1.y) ||
      (pellet.x === gameState.player2.x && pellet.y === gameState.player2.y)
    ) {
      if (pellet.x === gameState.player1.x && pellet.y === gameState.player1.y) {
        gameState.player1.score += 50
      }
      if (pellet.x === gameState.player2.x && pellet.y === gameState.player2.y) {
        gameState.player2.score += 50
      }

      gameState.powerMode = true
      gameState.powerModeTime = Date.now()

      gameState.ghosts.forEach((ghost) => {
        if (ghost.color !== "blue") {
          ghost.originalColor = ghost.color
          ghost.color = "blue"
        }
      })

      return false
    }
    return true
  })

  // Check ghost collisions
  gameState.ghosts.forEach((ghost, ghostIndex) => {
    // Player 1 collision
    if (ghost.x === gameState.player1.x && ghost.y === gameState.player1.y) {
      if (gameState.powerMode) {
        gameState.player1.score += 200
        ghost.x = 13 + (ghostIndex % 2)
        ghost.y = 14 + Math.floor(ghostIndex / 2)
        if (ghost.originalColor) {
          ghost.color = ghost.originalColor
          delete ghost.originalColor
        }
      } else if (!gameState.player1.invulnerable) {
        gameState.player1.lives--
        gameState.player1.invulnerable = true
        gameState.player1.invulnerableTime = Date.now()
        gameState.player1.x = 1
        gameState.player1.y = 1
        gameState.player1.direction = "right"
      }
    }

    // Player 2 collision
    if (ghost.x === gameState.player2.x && ghost.y === gameState.player2.y) {
      if (gameState.powerMode) {
        gameState.player2.score += 200
        ghost.x = 13 + (ghostIndex % 2)
        ghost.y = 14 + Math.floor(ghostIndex / 2)
        if (ghost.originalColor) {
          ghost.color = ghost.originalColor
          delete ghost.originalColor
        }
      } else if (!gameState.player2.invulnerable) {
        gameState.player2.lives--
        gameState.player2.invulnerable = true
        gameState.player2.invulnerableTime = Date.now()
        gameState.player2.x = 26
        gameState.player2.y = 1
        gameState.player2.direction = "left"
      }
    }
  })
}

function checkGameOver() {
  // All dots collected
  if (gameState.dots.length === 0 && gameState.powerPellets.length === 0) {
    gameState.gameOver = true
    if (gameState.player1.score > gameState.player2.score) {
      gameState.winner = gameState.player1.name || "Player 1"
    } else if (gameState.player2.score > gameState.player1.score) {
      gameState.winner = gameState.player2.name || "Player 2"
    } else {
      gameState.winner = null
    }
  }

  // Both players dead
  if (gameState.player1.lives <= 0 && gameState.player2.lives <= 0) {
    gameState.gameOver = true
    if (gameState.player1.score > gameState.player2.score) {
      gameState.winner = gameState.player1.name || "Player 1"
    } else if (gameState.player2.score > gameState.player1.score) {
      gameState.winner = gameState.player2.name || "Player 2"
    } else {
      gameState.winner = null
    }
  }

  // One player dead
  if (gameState.player1.lives <= 0 && gameState.player2.lives > 0) {
    gameState.gameOver = true
    gameState.winner = gameState.player2.name || "Player 2"
  } else if (gameState.player2.lives <= 0 && gameState.player1.lives > 0) {
    gameState.gameOver = true
    gameState.winner = gameState.player1.name || "Player 1"
  }
}

async function saveScores() {
  try {
    if (!mongoose.connection.readyState) {
      console.log("⚠️ Database not connected, skipping score save")
      return
    }

    const Score = require("./models/Score")

    if (gameState.player1.name) {
      const score1 = new Score({
        playerName: gameState.player1.name,
        score: gameState.player1.score,
        date: new Date(),
      })
      await score1.save()
    }

    if (gameState.player2.name) {
      const score2 = new Score({
        playerName: gameState.player2.name,
        score: gameState.player2.score,
        date: new Date(),
      })
      await score2.save()
    }

    console.log("💾 Scores saved to database")
  } catch (error) {
    console.error("❌ Error saving scores:", error)
  }
}

// API endpoint for manual Arduino control
app.post("/api/arduino/press", (req, res) => {
  const { direction } = req.body

  if (!direction || !["UP", "DOWN", "LEFT", "RIGHT"].includes(direction.toUpperCase())) {
    return res.status(400).json({ error: "Invalid direction" })
  }

  const input = { up: false, down: false, left: false, right: false }

  switch (direction.toUpperCase()) {
    case "UP":
      input.up = true
      break
    case "DOWN":
      input.down = true
      break
    case "LEFT":
      input.left = true
      break
    case "RIGHT":
      input.right = true
      break
  }

  updatePlayerDirection(gameState.player1, input)
  io.emit("arduino-input", input)
  io.emit("game-update", gameState)

  res.json({ success: true, message: `Button ${direction} pressed`, input })
})

// Export for Vercel
module.exports = app

// Start server locally
if (require.main === module) {
  const PORT = process.env.PORT || 3001
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`)
  })
}
