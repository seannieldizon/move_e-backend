// src/app.ts
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import http from "http";
import { Server as IOServer } from "socket.io";
import jwt from "jsonwebtoken";
import messageRoutes from "./routes/messageRoutes";
import clientRoutes from "./routes/clientRoutes";
import businessRoutes from "./routes/businessRoutes";
import bookingRoutes from "./routes/bookingRoutes";
// NOTE: create these models (examples provided earlier) or adjust paths
import Message from "./models/message";
import Conversation from "./models/conversation";

import admin from "firebase-admin";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Firebase Admin initialization (run once, before routes that use admin) ----------
if (!admin.apps.length) {
  try {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64?.trim();
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();

    if (b64 && b64.length > 0) {
      const jsonStr = Buffer.from(b64, "base64").toString("utf8");
      const serviceAccount = JSON.parse(jsonStr);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
      });
      console.log("Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_B64 (base64).");
    } else if (raw && raw.length > 0) {
      const serviceAccount = JSON.parse(raw);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
      });
      console.log("Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT (raw JSON env var).");
    } else {
      admin.initializeApp();
      console.log("Firebase Admin initialized using default application credentials (GOOGLE_APPLICATION_CREDENTIALS or GCP default).");
    }
  } catch (err) {
    console.error("Failed to initialize Firebase Admin SDK:", err);
  }
}

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/move-e";
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// ---- Create HTTP server and Socket.IO ----
const server = http.createServer(app);

const io = new IOServer(server, {
  cors: {
    origin: "*", // TODO: restrict in production
    methods: ["GET", "POST"],
  },
});

// ---------------- Socket.IO auth middleware ----------------
// Robust parsing of token: accepts handshake.auth.token or Authorization header.
// Strips "Bearer " prefix safely and rejects if there is no token after "Bearer ".
io.use(async (socket, next) => {
  try {
    // Read raw token candidate from handshake.auth.token (preferred) or Authorization header
    let rawCandidate: string | undefined;

    if (socket.handshake?.auth && socket.handshake.auth.token != null) {
      // client likely sent .setAuth({'token': someValue})
      rawCandidate = String(socket.handshake.auth.token);
    } else if (socket.handshake?.headers && socket.handshake.headers.authorization) {
      // client may have sent an Authorization header
      rawCandidate = String(socket.handshake.headers.authorization);
    }

    if (!rawCandidate || rawCandidate.trim().length === 0) {
      console.warn("Socket auth failed: token missing in handshake (no auth.token and no Authorization header).");
      return next(new Error("Authentication error: token missing"));
    }

    // If the candidate starts with "Bearer", strip it robustly.
    // Accept forms: "Bearer <token>", "bearer <token>", "Bearer" (no token) or raw token.
    let token = rawCandidate.trim();
    if (/^Bearer$/i.test(token)) {
      // Exactly "Bearer" with no token after it
      console.warn("Socket auth failed: Authorization header contains only 'Bearer' with no token.");
      return next(new Error("Authentication error: token missing after Bearer"));
    }
    if (/^Bearer\s+/i.test(token)) {
      token = token.replace(/^Bearer\s+/i, "");
    }

    // After stripping, token must be non-empty
    if (!token || token.trim().length === 0) {
      console.warn("Socket auth failed: token empty after Bearer stripping.");
      return next(new Error("Authentication error: token missing"));
    }

    // For logging: show a short preview of the cleaned token (do NOT log full token in production)
    const safePreview = token.length > 12 ? `${token.slice(0, 6)}...${token.slice(-6)}` : token;
    console.debug(`Socket auth: cleaned token preview ${safePreview} from socket ${socket.id}`);

    // Try verifying using server JWT_SECRET first (if present)
    const secret = process.env.JWT_SECRET;
    if (secret) {
      try {
        const decoded = jwt.verify(token, secret) as any;
        (socket as any).data = (socket as any).data ?? {};
        (socket as any).data.user = decoded;
        console.debug(`Socket auth: jwt.verify succeeded for socket ${socket.id}`);
        return next();
      } catch (err) {
        // If token is malformed or invalid, log and fall back to Firebase verification
        console.warn("Socket auth verification failed (jsonwebtoken):", (err as Error).message);
      }
    } else {
      console.warn("JWT_SECRET not set - skipping jsonwebtoken.verify step for sockets");
    }

    // Fallback: try to verify as Firebase ID token (useful if client uses Firebase)
    try {
      const firebaseDecoded = await admin.auth().verifyIdToken(token);
      (socket as any).data = (socket as any).data ?? {};
      (socket as any).data.user = {
        uid: firebaseDecoded.uid,
        firebase: firebaseDecoded,
      };
      console.debug(`Socket auth: Firebase token verified uid=${firebaseDecoded.uid} for socket ${socket.id}`);
      return next();
    } catch (err) {
      // Both verification methods failed
      console.warn("Socket auth verification failed (firebase):", (err as Error).message);
      // If you want to return a more specific message depending on jwt vs firebase failure you can,
      // but avoid exposing secrets. We'll return a generic invalid token message.
      return next(new Error("Authentication error: invalid token"));
    }
  } catch (err) {
    console.error("Socket auth middleware unexpected error:", err);
    return next(new Error("Authentication error"));
  }
});

// ---------------- Socket event handlers ----------------
io.on("connection", (socket) => {
  const userPayload = (socket as any).data?.user;
  const userId =
    userPayload?.id || userPayload?._id || userPayload?.userId || userPayload?.sub || userPayload?.uid || null;

  console.log(`Socket connected: ${socket.id} user=${userId}`);

  socket.on("join", (conversationId: string) => {
    try {
      if (!conversationId) return;
      socket.join(conversationId);
      console.log(`Socket ${socket.id} joined room ${conversationId}`);
    } catch (err) {
      console.error("join handler error:", err);
    }
  });

  socket.on("leave", (conversationId: string) => {
    try {
      if (!conversationId) return;
      socket.leave(conversationId);
      console.log(`Socket ${socket.id} left room ${conversationId}`);
    } catch (err) {
      console.error("leave handler error:", err);
    }
  });

  socket.on("message:send", async (payload: any) => {
  try {
    const { conversationId, text, attachments, to, senderType } = payload;

    if (!conversationId || !senderType) {
      socket.emit("error", { message: "conversationId and senderType are required" });
      return;
    }

    // Fetch the conversation to identify correct sender
    const conversation = await Conversation.findById(conversationId).lean();
    if (!conversation) {
      socket.emit("error", { message: "Conversation not found" });
      return;
    }

    let actualFrom: mongoose.Types.ObjectId | undefined;

    // Determine the correct sender based on senderType
    if (senderType === "client" && conversation.participants?.client) {
      actualFrom = new mongoose.Types.ObjectId(conversation.participants.client);
    } else if (senderType === "business" && conversation.participants?.business) {
      actualFrom = new mongoose.Types.ObjectId(conversation.participants.business);
    } else {
      // fallback to userId if participants not found
      actualFrom = userId ? new mongoose.Types.ObjectId(userId) : undefined;
    }

    // Create the message document
    const msgDoc = await Message.create({
      conversationId: new mongoose.Types.ObjectId(conversationId),
      from: actualFrom,
      to: to ? new mongoose.Types.ObjectId(to) : undefined,
      text: text || "",
      attachments: Array.isArray(attachments) ? attachments : [],
      status: "sent",
    });

    // Update the conversation with the latest message
    try {
      await Conversation.findByIdAndUpdate(conversationId, { lastMessage: msgDoc._id }).exec();
    } catch (e) {
      console.warn("Failed to update conversation lastMessage:", e);
    }

    // Prepare response
    const out = {
      id: String(msgDoc._id),
      conversationId: String(msgDoc.conversationId),
      from: String(msgDoc.from),
      to: msgDoc.to ? String(msgDoc.to) : undefined,
      text: msgDoc.text,
      attachments: msgDoc.attachments,
      status: msgDoc.status,
      createdAt: msgDoc.createdAt,
    };

    // Emit the message to all participants in the conversation room
    io.to(conversationId.toString()).emit("message:new", out);

    // Optional debug log
    console.debug(
      `Message sent → conv=${conversationId}, senderType=${senderType}, from=${out.from}`
    );
  } catch (err) {
    console.error("message:send error:", err);
    socket.emit("error", { message: "Failed to send message" });
  }
});


  socket.on("message:read", async (payload: any) => {
    try {
      const { conversationId, messageId } = payload;
      if (!messageId) return;
      await Message.findByIdAndUpdate(messageId, { status: "read" }).exec();
      if (conversationId) {
        io.to(conversationId).emit("message:read", { messageId, by: userId });
      }
    } catch (err) {
      console.error("message:read error:", err);
    }
  });

  socket.on("typing", (payload: any) => {
    try {
      const { conversationId, isTyping } = payload;
      if (!conversationId) return;
      socket.to(conversationId).emit("typing", { conversationId, userId, isTyping });
    } catch (err) {
      console.error("typing error:", err);
    }
  });

  socket.on("disconnect", (reason) => {
    console.log(`Socket disconnected: ${socket.id} reason=${reason}`);
  });
});

// Make io and server available to routes and other modules
app.set("io", io);
app.set("server", server);

// ---------- REST endpoints ----------
app.use("/api/client", clientRoutes);
app.use("/api/businessInfo", businessRoutes);
app.use("/api/booking", bookingRoutes);
app.use("/api/messages", messageRoutes);

// Simple message history endpoint (paginated)
app.get("/api/messages/:conversationId", async (req, res) => {
  try {
    const convId = req.params.conversationId;
    if (!mongoose.isValidObjectId(convId)) return res.status(400).json({ message: "Invalid conversationId" });

    const limit = Math.min(100, parseInt((req.query.limit as string) || "25", 10));
    const before = (req.query.before as string) || undefined;
    const q: any = { conversationId: new mongoose.Types.ObjectId(convId) };
    if (before) q.createdAt = { $lt: new Date(before) };

    const messages = await Message.find(q).sort({ createdAt: -1 }).limit(limit).lean().exec();
    return res.json({ messages });
  } catch (err) {
    console.error("GET /api/messages/:conversationId error:", err);
    return res.status(500).json({ message: "Server error", error: (err as Error).message });
  }
});

// ---- Global error handler ----
app.use((err: any, req: any, res: any, next: any) => {
  console.error("Global error handler:", err);
  res.status(err?.status || 500).json({
    success: false,
    message: err?.message || "Internal Server Error",
  });
});

// Export app (default) plus server/io so your entry script can start the server
export default app;
export { server, io };
