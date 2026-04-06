const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");
const cron = require("node-cron");
const { prisma } = require("./prisma")
const { syncJobFeed } = require("./services/jobFeedSync");
const router = require('express').Router()
// Load environment variables
dotenv.config();

const app = express();
const server = http.createServer(app);

// Trust proxy (required when behind nginx-proxy/reverse proxy)
app.set("trust proxy", 1);

// =======================
// CORS Configuration
// =======================
const allowedOrigins = [
  "https://api.hiregenix.ai",
  "https://candidate.hiregenix.ai",
  "https://recruiter.hiregenix.ai",
  "https://dashboard.hiregenix.ai",
  "https://hiregenix.ai",
  "https://www.hiregenix.ai",
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, server-to-server, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

// =======================
// Rate Limiting
// =======================
// Global rate limiter: 200 requests per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "FAIL",
    message: "Too many requests from this IP, please try again after 15 minutes",
  },
});

// Stricter auth rate limiter: 20 requests per 15 minutes for login/register
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "FAIL",
    message: "Too many authentication attempts, please try again after 15 minutes",
  },
});

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));
app.use(globalLimiter);

// Routes
app.use('/api/v1/auth', authLimiter, require('./routes/auth'))
app.use('/api/v1/recruiter', require('./routes/recruiter'))
app.use('/api/v1/admin', require('./routes/admin'))
app.use('/api/v1/public', require('./routes/public'))
app.use('/api/v1/job-seeker', require('./routes/jobSeeker'))
app.use('/api/v1/messaging', require('./routes/messaging'))

// =======================
// Socket.io Setup
// =======================
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

// Socket.io auth middleware — verify JWT
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Authentication required"));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch (err) {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  // Join user's personal room for targeted messages
  socket.join(`user:${socket.userId}`);
  console.log(`[WS] User ${socket.userId} connected`);

  // Typing indicators
  socket.on("typing", ({ conversationId }) => {
    socket.to(`conversation:${conversationId}`).emit("user_typing", {
      conversationId,
      userId: socket.userId,
    });
  });

  socket.on("stop_typing", ({ conversationId }) => {
    socket.to(`conversation:${conversationId}`).emit("user_stop_typing", {
      conversationId,
      userId: socket.userId,
    });
  });

  // Join a conversation room (for typing indicators)
  socket.on("join_conversation", ({ conversationId }) => {
    socket.join(`conversation:${conversationId}`);
  });

  socket.on("leave_conversation", ({ conversationId }) => {
    socket.leave(`conversation:${conversationId}`);
  });

  socket.on("disconnect", () => {
    console.log(`[WS] User ${socket.userId} disconnected`);
  });
});

// Attach io to requests so controllers can emit events
app.use((req, res, next) => {
  req.io = io;
  next();
});
// router.use('/employer', require('./employer'))
// router.use('/admin', require('./admin'))
// router.use('/', require('./public'))

const { seedSubscriptions, seedRecruiterSubscriptions } = require("./payments/seedSubscriptions")
// Start server ONLY if DB connects
const startServer = async () => {
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`; // validate credentials
    console.log("✅ Database connected successfully");
    await seedSubscriptions()
    await seedRecruiterSubscriptions()

    const PORT = process.env.PORT || 6565;
    server.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);

      // Expire subscriptions — every hour
      // Marks ACTIVE subscriptions as EXPIRED when expiresAt has passed
      cron.schedule("0 * * * *", async () => {
        try {
          const now = new Date();
          const result = await prisma.userSubscription.updateMany({
            where: {
              status: "ACTIVE",
              expiresAt: { not: null, lte: now },
            },
            data: { status: "EXPIRED" },
          });
          if (result.count > 0) {
            console.log(`[CRON] Expired ${result.count} subscription(s)`);
          }
        } catch (err) {
          console.error("[CRON] Subscription expiry failed:", err);
        }
      });

      // Fail stale PENDING PayPal payments older than 2 hours — every 30 minutes
      cron.schedule("*/30 * * * *", async () => {
        try {
          const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

          // Find PENDING invoices older than 2 hours
          const staleInvoices = await prisma.invoice.findMany({
            where: {
              status: "OPEN",
              createdAt: { lte: twoHoursAgo },
            },
            select: { id: true, reference: true },
          });

          if (staleInvoices.length === 0) return;

          const invoiceIds = staleInvoices.map(i => i.id);
          const references = staleInvoices.map(i => i.reference).filter(Boolean);

          // Void stale invoices
          const invoiceResult = await prisma.invoice.updateMany({
            where: { id: { in: invoiceIds }, status: "OPEN" },
            data: { status: "VOID" },
          });

          // Fail associated PENDING payments
          const paymentResult = await prisma.subscriptionPayment.updateMany({
            where: { invoiceId: { in: invoiceIds }, status: "PENDING" },
            data: { status: "FAILED" },
          });

          // Fail associated PENDING subscriptions
          const subResult = await prisma.userSubscription.updateMany({
            where: { reference: { in: references }, status: "PENDING" },
            data: { status: "FAILED", canceledAt: new Date() },
          });

          if (invoiceResult.count > 0) {
            console.log(`[CRON] Cleaned stale payments: ${invoiceResult.count} invoices voided, ${paymentResult.count} payments failed, ${subResult.count} subscriptions failed`);
          }
        } catch (err) {
          console.error("[CRON] Stale payment cleanup failed:", err);
        }
      });

      // JobG8 feed sync — every hour
      cron.schedule("0 * * * *", () => {
        console.log("[CRON] Starting JobG8 feed sync...");
        syncJobFeed().catch((err) => console.error("[CRON] Feed sync failed:", err));
      });

      // Initial subscription expiry check on startup
      (async () => {
        try {
          const now = new Date();
          const result = await prisma.userSubscription.updateMany({
            where: { status: "ACTIVE", expiresAt: { not: null, lte: now } },
            data: { status: "EXPIRED" },
          });
          if (result.count > 0) {
            console.log(`[INIT] Expired ${result.count} stale subscription(s)`);
          }
        } catch (err) {
          console.error("[INIT] Subscription expiry check failed:", err);
        }
      })();

      // Initial sync 30 seconds after startup
      setTimeout(() => {
        console.log("[INIT] Running initial JobG8 feed sync...");
        syncJobFeed().catch((err) => console.error("[INIT] Feed sync failed:", err));
      }, 30000);
    });
  } catch (error) {
    console.error("❌ Failed to connect to database");
    console.error(error.message);
    process.exit(1); // Kill the app
  }
};

startServer();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("🛑 Shutting down...");
  await prisma.$disconnect();
  process.exit(0);
});
