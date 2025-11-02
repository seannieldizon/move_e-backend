// src/server.ts
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import app, { server, io } from "./app"; // app default + named exports from app.ts
// import { createAdapter } from "@socket.io/redis-adapter"; // optional redis adapter
// import { createClient } from "redis";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/move_e";
const PORT = parseInt(process.env.PORT || "5000", 10);

async function start() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB");

    // Optional: Redis adapter for Socket.IO (uncomment if you have REDIS_URL)
    /*
    if (process.env.REDIS_URL) {
      const pubClient = createClient({ url: process.env.REDIS_URL });
      const subClient = pubClient.duplicate();
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
      console.log("Socket.IO Redis adapter enabled");
    }
    */

    // Start HTTP + Socket.IO server (server is http.Server created in app.ts)
    server.listen(PORT, () => {
      console.log(`HTTP + Socket.IO server listening on port ${PORT}`);
      console.log("Socket.IO ready");
      // If you need to inspect namespaces or rooms at runtime you can use:
      // console.log(Array.from(io.of("/").adapter.rooms.keys()));
      // Note: listing internal structures is okay at runtime, but avoid relying on private fields.
    });

    // Graceful shutdown
    const shutdown = (signal: string) => {
      return async () => {
        try {
          console.log(`\n${signal} received — shutting down gracefully...`);
          server.close(() => {
            console.log("HTTP server closed.");
          });

          // close socket.io connections
          try {
            io.disconnectSockets(true); // forcibly disconnect all sockets
            console.log("Socket.IO sockets disconnected.");
          } catch (e) {
            console.warn("Error while disconnecting sockets:", e);
          }

          // close mongoose
          await mongoose.disconnect();
          console.log("Disconnected from MongoDB.");

          // allow process to exit
          process.exit(0);
        } catch (err) {
          console.error("Error during shutdown:", err);
          process.exit(1);
        }
      };
    };

    process.on("SIGINT", shutdown("SIGINT"));
    process.on("SIGTERM", shutdown("SIGTERM"));

    // catch unhandled rejections and exceptions (log and exit)
    process.on("unhandledRejection", (reason) => {
      console.error("Unhandled Rejection at:", reason);
    });
    process.on("uncaughtException", (err) => {
      console.error("Uncaught Exception thrown:", err);
      // depending on your needs you might want to attempt graceful shutdown here
    });
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
}

start();
