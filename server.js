const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const mongoose = require("mongoose")
const cors = require("cors")
const path = require("path")
require("dotenv").config()

// Conditional import of SerialPort (only if not in production without hardware)
let SerialPort, ReadlineParser
try {
  const serialport = require("serialport")
  SerialPort = serialport.SerialPort
  ReadlineParser = require("@serialport/parser-readline").ReadlineParser
} catch (err) {
  console.log("SerialPort not available, using simulator mode")
}

// Import routes
const leaderboardRoutes = require("./routes/leaderboard")

// Initialize Express app
const app = express()
const server = http.createServer(app)

// Configure CORS
app.use(cors())
app.use(express.json())

// Serve static files from the React app in production
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../front/dist")))
}

// API routes
app.use("/api/leaderboard", leaderboardRoutes)

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === "production" ? false : ["http://localhost:5173"],
    methods: ["GET", "POST"],
  },
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

// Arduino connection and simulation
let arduinoPort = null
let arduinoConnected = false
let arduinoSimulator = null

// Arduino Virtual Controller - Simulates Arduino LCD Keypad Shield
class ArduinoSimulator {
  constructor(io) {
    this.io = io
    this.isConnected = false
    this.currentKey = null
    this.lastKeyTime = 0
    this.keyDelay = 100

    // Virtual LCD state
    this.lcdLine1 = "Pac-Man Player 1"
    this.lcdLine2 = "Ready to play!"

    console.log("🤖 Arduino Simulator initialized")
    console.log("📱 Virtual LCD Keypad Shield ready")
  }

  connect() {
    this.isConnected = true
    console.log("✅ Arduino Simulator connected")
    console.log("📺 LCD Display:")
    console.log(`   Line 1: ${this.lcdLine1}`)
    console.log(`   Line 2: ${this.lcdLine2}`)

    this.io.emit("arduino-status", { connected: true })

    // Send initial status
    console.log("📤 ARDUINO:READY")

    // Start virtual button simulation (for demo purposes)
    this.startDemoMode()
  }

  disconnect() {
    this.isConnected = false
    console.log("❌ Arduino Simulator disconnected")
    this.io.emit("arduino-status", { connected: false })
  }

  // Simulate LCD display update
  updateLCD(line1, line2) {
    this.lcdLine1 = line1
    this.lcdLine2 = line2
    console.log("📺 LCD Updated:")
    console.log(`   Line 1: ${line1}`)
    console.log(`   Line 2: ${line2}`)
  }

  // Simulate button press
  pressButton(buttonName) {
    if (!this.isConnected) return

    const now = Date.now()
    if (now - this.lastKeyTime < this.keyDelay) return

    this.lastKeyTime = now
    this.currentKey = buttonName

    console.log(`🔘 Virtual button pressed: ${buttonName}`)

    // Update virtual LCD
    this.updateLCD("Button pressed:", `${buttonName} ->`)

    // Send key press to game (same format as real Arduino)
    console.log(`📤 KEY:${buttonName}`)

    // Convert to game input
    const input = { up: false, down: false, left: false, right: false }

    switch (buttonName) {
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

    this.io.emit("arduino-input", input)

    // Clear display after 2 seconds
    setTimeout(() => {
      this.updateLCD("Pac-Man Player 1", "Press any button")
    }, 2000)
  }

  // Demo mode - simulates random button presses for testing
  startDemoMode() {
    if (process.env.ARDUINO_DEMO_MODE === "true") {
      console.log("🎮 Demo mode activated - Random button presses every 3 seconds")

      setInterval(() => {
        const buttons = ["UP", "DOWN", "LEFT", "RIGHT"]
        const randomButton = buttons[Math.floor(Math.random() * buttons.length)]
        this.pressButton(randomButton)
      }, 3000)
    }
  }

  // API for manual control (useful for testing)
  manualPress(direction) {
    this.pressButton(direction.toUpperCase())
  }
}

// Try to connect to Arduino (real hardware or simulator)
function connectToArduino() {
  // Check if we should use simulator
  if (process.env.USE_ARDUINO_SIMULATOR === "true" || !SerialPort) {
    console.log("🔄 Starting Arduino Simulator...")
    arduinoSimulator = new ArduinoSimulator(io)
    arduinoSimulator.connect()
    arduinoConnected = true
    return
  }

  // Try to connect to real Arduino
  console.log("🔍 Searching for Arduino hardware...")

  SerialPort.list()
    .then((ports) => {
      console.log("Available ports:")
      ports.forEach((port) => {
        console.log(
          `  ${port.path} - ${port.manufacturer || "unknown"} - VID:${port.vendorId || "unknown"} PID:${port.productId || "unknown"}`,
        )
      })

      let arduinoPortInfo = null

      // 1. Try specified port first
      if (process.env.ARDUINO_PORT) {
        console.log(`🎯 Trying specified port: ${process.env.ARDUINO_PORT}`)
        arduinoPortInfo = ports.find((port) => port.path === process.env.ARDUINO_PORT)

        if (arduinoPortInfo) {
          console.log(`✅ Found specified port: ${process.env.ARDUINO_PORT}`)
        } else {
          console.log(`❌ Specified port ${process.env.ARDUINO_PORT} not found`)
        }
      }

      // 2. Auto-detect Arduino
      if (!arduinoPortInfo) {
        arduinoPortInfo = ports.find(
          (port) =>
            port.manufacturer &&
            (port.manufacturer.toLowerCase().includes("arduino") ||
              port.manufacturer.toLowerCase().includes("wch") ||
              port.manufacturer.toLowerCase().includes("ftdi") ||
              port.vendorId === "2341" || // Arduino VID
              port.vendorId === "1A86"), // CH340 VID
        )
      }

      // 3. Fallback to first available port
      if (!arduinoPortInfo && ports.length > 0) {
        console.log("⚠️  No Arduino detected, using first available port as fallback")
        arduinoPortInfo = ports[0]
      }

      if (arduinoPortInfo) {
        console.log(`🔌 Attempting connection to: ${arduinoPortInfo.path}`)

        try {
          arduinoPort = new SerialPort({
            path: arduinoPortInfo.path,
            baudRate: 9600,
          })

          const parser = arduinoPort.pipe(new ReadlineParser({ delimiter: "\r\n" }))

          arduinoPort.on("open", () => {
            console.log(`✅ Arduino connected on ${arduinoPortInfo.path}`)
            console.log("🎮 Hardware controller ready!")
            arduinoConnected = true
            io.emit("arduino-status", { connected: true })
          })

          arduinoPort.on("error", (err) => {
            console.error(`❌ Arduino error on ${arduinoPortInfo.path}:`, err.message)
            console.log("🔄 Falling back to simulator mode...")

            arduinoConnected = false
            io.emit("arduino-status", { connected: false })

            // Fallback to simulator
            arduinoSimulator = new ArduinoSimulator(io)
            arduinoSimulator.connect()
            arduinoConnected = true
          })

          arduinoPort.on("close", () => {
            console.log("🔌 Arduino hardware disconnected")
            arduinoConnected = false
            io.emit("arduino-status", { connected: false })

            // Try to reconnect after a delay
            setTimeout(connectToArduino, 5000)
          })

          // Parse Arduino input
          parser.on("data", (data) => {
            console.log(`📥 Arduino data: ${data}`)

            // Handle Arduino ready signal
            if (data.includes("ARDUINO:READY")) {
              console.log("🎮 Arduino controller initialized")
              return
            }

            // Parse button input: "KEY:UP", "KEY:DOWN", etc.
            if (data.startsWith("KEY:")) {
              const key = data.substring(4).trim()
              console.log(`🔘 Hardware button pressed: ${key}`)

              const input = { up: false, down: false, left: false, right: false }

              switch (key) {
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
                // Añadir soporte para valores numéricos del LCD Keypad Shield
                case "0":
                case "RIGHT_VAL":
                  input.right = true
                  console.log("🎮 RIGHT button detected")
                  break
                case "1":
                case "UP_VAL":
                  input.up = true
                  console.log("🎮 UP button detected")
                  break
                case "2":
                case "DOWN_VAL":
                  input.down = true
                  console.log("🎮 DOWN button detected")
                  break
                case "3":
                case "LEFT_VAL":
                  input.left = true
                  console.log("🎮 LEFT button detected")
                  break
                case "4":
                case "SELECT_VAL":
                  // Botón SELECT - podría usarse para pausa u otra función
                  console.log("🎮 SELECT button detected")
                  break
              }

              // Enviar el input a todos los clientes y actualizar el estado del juego inmediatamente
              io.emit("arduino-input", input)

              // Actualizar la dirección del jugador 1 directamente
              updatePlayerDirection(gameState.player1, input)

              // Enviar actualización del estado del juego
              io.emit("game-update", gameState)
            }

            // Detectar valores analógicos directos (alternativa)
            else if (!isNaN(data)) {
              const analogValue = Number.parseInt(data.trim())
              console.log(`📊 Analog value: ${analogValue}`)

              const input = { up: false, down: false, left: false, right: false }

              // Mapear valores analógicos a botones (ajustar según tu shield)
              if (analogValue < 50) {
                input.right = true
                console.log("🎮 RIGHT button (analog)")
              } else if (analogValue < 200) {
                input.up = true
                console.log("🎮 UP button (analog)")
              } else if (analogValue < 400) {
                input.down = true
                console.log("🎮 DOWN button (analog)")
              } else if (analogValue < 600) {
                input.left = true
                console.log("🎮 LEFT button (analog)")
              } else if (analogValue < 800) {
                // SELECT button
                console.log("🎮 SELECT button (analog)")
              }

              if (input.up || input.down || input.left || input.right) {
                io.emit("arduino-input", input)
                updatePlayerDirection(gameState.player1, input)
                io.emit("game-update", gameState)
              }
            }
          })
        } catch (err) {
          console.error(`❌ Failed to connect to ${arduinoPortInfo.path}:`, err.message)
          console.log("🔄 Starting simulator as fallback...")

          // Fallback to simulator
          arduinoSimulator = new ArduinoSimulator(io)
          arduinoSimulator.connect()
          arduinoConnected = true
        }
      } else {
        console.log("❌ No serial ports found")
        console.log("🔄 Starting Arduino Simulator...")

        // Use simulator
        arduinoSimulator = new ArduinoSimulator(io)
        arduinoSimulator.connect()
        arduinoConnected = true
      }
    })
    .catch((err) => {
      console.error("❌ Error listing serial ports:", err)
      console.log("🔄 Starting Arduino Simulator as fallback...")

      // Fallback to simulator
      arduinoSimulator = new ArduinoSimulator(io)
      arduinoSimulator.connect()
      arduinoConnected = true
    })
}

// API endpoint for manual Arduino control (useful for testing)
app.post("/api/arduino/press", (req, res) => {
  const { direction } = req.body

  if (!direction || !["UP", "DOWN", "LEFT", "RIGHT"].includes(direction.toUpperCase())) {
    return res.status(400).json({ error: "Invalid direction. Use UP, DOWN, LEFT, or RIGHT" })
  }

  if (arduinoSimulator) {
    arduinoSimulator.manualPress(direction)
    res.json({ success: true, message: `Button ${direction} pressed` })
  } else {
    res.status(503).json({ error: "Arduino simulator not available" })
  }
})

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/pacman")
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err))

// Socket.IO connection
io.on("connection", (socket) => {
  console.log("👤 New client connected")

  // Send current Arduino status
  socket.emit("arduino-status", { connected: arduinoConnected })

  // Handle player input
  socket.on("player-input", ({ player, input }) => {
    // Update player direction based on input
    if (player === 1) {
      updatePlayerDirection(gameState.player1, input)
    } else if (player === 2) {
      updatePlayerDirection(gameState.player2, input)
    }
  })

  // Handle game start
  socket.on("start-game", ({ player1Name, player2Name }) => {
    console.log(`🎮 Starting game: ${player1Name} vs ${player2Name}`)

    // Reset game state
    resetGameState()

    // Store player names
    gameState.player1.name = player1Name
    gameState.player2.name = player2Name

    // Start game loop
    if (!gameLoopInterval) {
      startGameLoop()
    }
  })

  // Manual Arduino control via WebSocket
  socket.on("arduino-manual-press", (direction) => {
    if (arduinoSimulator) {
      arduinoSimulator.manualPress(direction)
    }
  })

  socket.on("disconnect", () => {
    console.log("👤 Client disconnected")
  })
})

// Update player direction based on input
function updatePlayerDirection(player, input) {
  if (input.up) player.direction = "up"
  else if (input.down) player.direction = "down"
  else if (input.left) player.direction = "left"
  else if (input.right) player.direction = "right"
}

// Game loop
let gameLoopInterval = null

function startGameLoop() {
  gameLoopInterval = setInterval(() => {
    // Update invulnerability timers
    updateInvulnerability()

    // Update power mode
    updatePowerMode()

    // Move players
    movePlayer(gameState.player1)
    movePlayer(gameState.player2)

    // Move ghosts with improved AI
    moveGhosts()

    // Check collisions (including ghost collisions)
    checkCollisions()

    // Check game over conditions
    checkGameOver()

    // Send updated game state to all clients
    io.emit("game-update", gameState)

    // If game is over, stop the game loop
    if (gameState.gameOver) {
      clearInterval(gameLoopInterval)
      gameLoopInterval = null

      // Save scores to database
      saveScores()
    }
  }, 150) // Game speed
}

// Update invulnerability timers
function updateInvulnerability() {
  const currentTime = Date.now()

  // Player 1 invulnerability
  if (gameState.player1.invulnerable && currentTime - gameState.player1.invulnerableTime > 3000) {
    gameState.player1.invulnerable = false
    console.log("🛡️ Player 1 is no longer invulnerable")
  }

  // Player 2 invulnerability
  if (gameState.player2.invulnerable && currentTime - gameState.player2.invulnerableTime > 3000) {
    gameState.player2.invulnerable = false
    console.log("🛡️ Player 2 is no longer invulnerable")
  }
}

// Update power mode
function updatePowerMode() {
  if (gameState.powerMode) {
    const currentTime = Date.now()
    if (currentTime - gameState.powerModeTime > 10000) {
      // Power mode lasts 10 seconds
      gameState.powerMode = false
      console.log("⚡ Power mode ended")

      // Reset ghost colors
      gameState.ghosts.forEach((ghost) => {
        if (ghost.color === "blue") {
          // Restore original colors
          if (ghost.originalColor) {
            ghost.color = ghost.originalColor
            delete ghost.originalColor
          }
        }
      })
    }
  }
}

// Reset game state
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

  // Initialize dots and power pellets
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

// Move player
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

  // Handle tunnel (left-right wrap around)
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

// Move ghosts with improved AI
function moveGhosts() {
  gameState.ghosts.forEach((ghost, index) => {
    // Choose target based on ghost behavior
    let target = null

    if (gameState.powerMode) {
      // During power mode, ghosts run away from players
      const player1Distance = Math.abs(ghost.x - gameState.player1.x) + Math.abs(ghost.y - gameState.player1.y)
      const player2Distance = Math.abs(ghost.x - gameState.player2.x) + Math.abs(ghost.y - gameState.player2.y)

      if (player1Distance < player2Distance) {
        // Run away from player 1
        target = {
          x: ghost.x + (ghost.x - gameState.player1.x),
          y: ghost.y + (ghost.y - gameState.player1.y),
        }
      } else {
        // Run away from player 2
        target = {
          x: ghost.x + (ghost.x - gameState.player2.x),
          y: ghost.y + (ghost.y - gameState.player2.y),
        }
      }
    } else {
      // Normal mode: each ghost targets a different player or has different behavior
      switch (index) {
        case 0: // Red ghost - always targets player 1
          target = { x: gameState.player1.x, y: gameState.player1.y }
          break
        case 1: // Pink ghost - targets player 2
          target = { x: gameState.player2.x, y: gameState.player2.y }
          break
        case 2: // Cyan ghost - targets the player with higher score
          if (gameState.player1.score >= gameState.player2.score) {
            target = { x: gameState.player1.x, y: gameState.player1.y }
          } else {
            target = { x: gameState.player2.x, y: gameState.player2.y }
          }
          break
        case 3: // Orange ghost - random movement with occasional targeting
          if (Math.random() < 0.3) {
            // 30% chance to target nearest player
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

    // Move towards or away from target
    let newX = ghost.x
    let newY = ghost.y

    if (target) {
      // Calculate direction to target
      const deltaX = target.x - ghost.x
      const deltaY = target.y - ghost.y

      // Choose primary direction based on largest delta
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        // Move horizontally
        if (deltaX > 0) {
          newX++
          ghost.direction = "right"
        } else {
          newX--
          ghost.direction = "left"
        }
      } else {
        // Move vertically
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
      const randomDirection = directions[Math.floor(Math.random() * directions.length)]
      ghost.direction = randomDirection

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

    // Handle tunnel (left-right wrap around)
    if (newX < 0) newX = 27
    if (newX > 27) newX = 0

    // Simple bounds checking for ghosts (they can move through ghost house)
    if (newX >= 0 && newX < 28 && newY >= 0 && newY < 31) {
      ghost.x = newX
      ghost.y = newY
    }
  })
}

// Check collisions
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
      return false // Remove dot
    }
    return true // Keep dot
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

      // Activate power mode
      gameState.powerMode = true
      gameState.powerModeTime = Date.now()
      console.log("⚡ Power mode activated!")

      // Turn ghosts blue
      gameState.ghosts.forEach((ghost) => {
        if (ghost.color !== "blue") {
          ghost.originalColor = ghost.color
          ghost.color = "blue"
        }
      })

      return false // Remove power pellet
    }
    return true // Keep power pellet
  })

  // Check ghost collisions - IMPROVED SYSTEM
  gameState.ghosts.forEach((ghost, ghostIndex) => {
    // Check collision with player 1
    if (ghost.x === gameState.player1.x && ghost.y === gameState.player1.y) {
      if (gameState.powerMode) {
        // Player can eat ghost during power mode
        gameState.player1.score += 200
        console.log(`👻 Player 1 ate a ${ghost.originalColor || ghost.color} ghost! +200 points`)

        // Respawn ghost at center
        ghost.x = 13 + (ghostIndex % 2)
        ghost.y = 14 + Math.floor(ghostIndex / 2)

        // Restore original color
        if (ghost.originalColor) {
          ghost.color = ghost.originalColor
          delete ghost.originalColor
        }
      } else if (!gameState.player1.invulnerable) {
        // Ghost kills player
        gameState.player1.lives--
        gameState.player1.invulnerable = true
        gameState.player1.invulnerableTime = Date.now()

        console.log(`💀 Player 1 was killed by ${ghost.color} ghost! Lives remaining: ${gameState.player1.lives}`)

        // Respawn player at starting position
        gameState.player1.x = 1
        gameState.player1.y = 1
        gameState.player1.direction = "right"

        // Check if player is dead
        if (gameState.player1.lives <= 0) {
          console.log("💀 Player 1 is DEAD!")
        }
      }
    }

    // Check collision with player 2
    if (ghost.x === gameState.player2.x && ghost.y === gameState.player2.y) {
      if (gameState.powerMode) {
        // Player can eat ghost during power mode
        gameState.player2.score += 200
        console.log(`👻 Player 2 ate a ${ghost.originalColor || ghost.color} ghost! +200 points`)

        // Respawn ghost at center
        ghost.x = 13 + (ghostIndex % 2)
        ghost.y = 14 + Math.floor(ghostIndex / 2)

        // Restore original color
        if (ghost.originalColor) {
          ghost.color = ghost.originalColor
          delete ghost.originalColor
        }
      } else if (!gameState.player2.invulnerable) {
        // Ghost kills player
        gameState.player2.lives--
        gameState.player2.invulnerable = true
        gameState.player2.invulnerableTime = Date.now()

        console.log(`💀 Player 2 was killed by ${ghost.color} ghost! Lives remaining: ${gameState.player2.lives}`)

        // Respawn player at starting position
        gameState.player2.x = 26
        gameState.player2.y = 1
        gameState.player2.direction = "left"

        // Check if player is dead
        if (gameState.player2.lives <= 0) {
          console.log("💀 Player 2 is DEAD!")
        }
      }
    }
  })
}

// Check game over conditions
function checkGameOver() {
  // Check if all dots are collected
  if (gameState.dots.length === 0 && gameState.powerPellets.length === 0) {
    gameState.gameOver = true
    if (gameState.player1.score > gameState.player2.score) {
      gameState.winner = gameState.player1.name || "Player 1"
    } else if (gameState.player2.score > gameState.player1.score) {
      gameState.winner = gameState.player2.name || "Player 2"
    } else {
      gameState.winner = null // Tie
    }
    console.log("🎉 All dots collected! Game Over!")
  }

  // Check if both players are dead
  if (gameState.player1.lives <= 0 && gameState.player2.lives <= 0) {
    gameState.gameOver = true
    if (gameState.player1.score > gameState.player2.score) {
      gameState.winner = gameState.player1.name || "Player 1"
    } else if (gameState.player2.score > gameState.player1.score) {
      gameState.winner = gameState.player2.name || "Player 2"
    } else {
      gameState.winner = null // Tie
    }
    console.log("💀 Both players are dead! Game Over!")
  }

  // Check if one player is dead (the other wins)
  if (gameState.player1.lives <= 0 && gameState.player2.lives > 0) {
    gameState.gameOver = true
    gameState.winner = gameState.player2.name || "Player 2"
    console.log("🏆 Player 2 wins! Player 1 is dead!")
  } else if (gameState.player2.lives <= 0 && gameState.player1.lives > 0) {
    gameState.gameOver = true
    gameState.winner = gameState.player1.name || "Player 1"
    console.log("🏆 Player 1 wins! Player 2 is dead!")
  }
}

// Save scores to database
async function saveScores() {
  try {
    const Score = require("./models/Score")

    // Save player 1 score
    if (gameState.player1.name) {
      const score1 = new Score({
        playerName: gameState.player1.name,
        score: gameState.player1.score,
        date: new Date(),
      })
      await score1.save()
    }

    // Save player 2 score
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

// Catch all handler for React Router in production
if (process.env.NODE_ENV === "production") {
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../front/dist/index.html"))
  })
}

// Start server
const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`🎮 Pac-Man Multiplayer Game Server`)
  console.log(`📡 WebSocket server ready`)
  console.log(`🔌 Arduino port: ${process.env.ARDUINO_PORT || "auto-detect"}`)

  // Try to connect to Arduino after server starts
  setTimeout(connectToArduino, 2000)
})
