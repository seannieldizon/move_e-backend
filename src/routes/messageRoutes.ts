import express, { Request, Response } from "express";
import mongoose from "mongoose";
import Conversation from "../models/conversation";
import Message from "../models/message";

const router = express.Router();

/**
 * Create or get an existing conversation
 * Body: { clientId, businessId, metadata? }
 */
router.post("/conversations", async (req: Request, res: Response) => {
  try {
    const { clientId, businessId, metadata } = req.body;

    if (!clientId || !businessId) {
      return res.status(400).json({ message: "clientId and businessId are required" });
    }

    // Check for existing conversation between same client and business
    let conversation = await Conversation.findOne({
      "participants.client": clientId,
      "participants.business": businessId,
    })
      .populate("participants.client")
      .populate("participants.business")
      .populate("lastMessage");

    if (!conversation) {
      conversation = await Conversation.create({
        participants: {
          client: new mongoose.Types.ObjectId(clientId),
          business: new mongoose.Types.ObjectId(businessId),
        },
        metadata,
      });

      // populate the created conversation for response / emit
      conversation = await Conversation.findById(conversation._id)
        .populate("participants.client")
        .populate("participants.business")
        .populate("lastMessage")
        .exec();
    }

    const outConv = conversation ? conversation.toObject() : null;

    // Emit realtime event (if Socket.IO available)
    try {
      const io = req.app.get("io") as any | undefined;
      if (io && outConv) {
        const convId = outConv._id?.toString?.() ?? outConv._id;
        // Emit to conversation room
        io.to(convId).emit("conversation:created", outConv);

        // Also emit to participant-specific rooms (useful if clients listen on user:<id>)
        const clientIdStr =
          outConv.participants?.client?._id?.toString?.() ??
          outConv.participants?.client?.toString?.();
        const businessIdStr =
          outConv.participants?.business?._id?.toString?.() ??
          outConv.participants?.business?.toString?.();

        if (clientIdStr) io.to(`user:${clientIdStr}`).emit("conversation:created", outConv);
        if (businessIdStr) io.to(`user:${businessIdStr}`).emit("conversation:created", outConv);

        console.debug(
          `Emitted conversation:created conv=${convId} client=${clientIdStr} business=${businessIdStr}`
        );
      }
    } catch (emitErr) {
      console.warn("Failed to emit conversation:created:", emitErr);
    }

    return res.status(200).json({ conversation: outConv });
  } catch (err) {
    console.error("POST /conversations error:", err);
    return res.status(500).json({ message: "Server error", error: (err as Error).message });
  }
});

/**
 * Get conversation with messages
 * GET /conversations/:clientId/:businessId
 * Fetches conversation (if exists) + all messages sorted by date ascending
 */
router.get("/conversations/:clientId/:businessId", async (req: Request, res: Response) => {
  try {
    const { clientId, businessId } = req.params;

    if (!mongoose.isValidObjectId(clientId) || !mongoose.isValidObjectId(businessId)) {
      return res.status(400).json({ message: "Invalid clientId or businessId" });
    }

    // Find conversation between this client and business
    const conversation = await Conversation.findOne({
      "participants.client": clientId,
      "participants.business": businessId,
    })
      .populate("participants.client")
      .populate("participants.business")
      .populate("lastMessage")
      .lean();

    if (!conversation) {
      return res.status(404).json({ message: "No conversation found between these participants" });
    }

    // Fetch messages associated with this conversation
    const messages = await Message.find({ conversationId: conversation._id })
      .sort({ createdAt: 1 })
      .lean();

    return res.json({ conversation, messages });
  } catch (err) {
    console.error("GET /conversations/:clientId/:businessId error:", err);
    return res.status(500).json({ message: "Server error", error: (err as Error).message });
  }
});

/**
 * Send a message via REST — saves message and emits via Socket.IO
 * Body: { conversationId, from, text, to?, attachments? }
 */
router.post("/messages", async (req: Request, res: Response) => {
  try {
    const io = req.app.get("io") as any | undefined;
    const { conversationId, from, text, to, attachments } = req.body;

    if (!conversationId || !from) {
      return res.status(400).json({ message: "conversationId and from are required" });
    }

    const msg = await Message.create({
      conversationId: new mongoose.Types.ObjectId(conversationId),
      from: new mongoose.Types.ObjectId(from),
      to: to ? new mongoose.Types.ObjectId(to) : undefined,
      text: text || "",
      attachments: Array.isArray(attachments) ? attachments : [],
      status: "sent",
    });

    // Update conversation lastMessage
    try {
      await Conversation.findByIdAndUpdate(conversationId, { lastMessage: msg._id }).exec();
    } catch (_) {}

    // Prepare response
    const out = {
      id: String(msg._id),
      conversationId: String(msg.conversationId),
      from: String(msg.from),
      to: msg.to ? String(msg.to) : undefined,
      text: msg.text,
      attachments: msg.attachments,
      status: msg.status,
      createdAt: msg.createdAt.toISOString(),
    };

    // Emit via Socket.IO — send to conversation room and to participant-specific user rooms
    try {
      if (io) {
        // Emit to conversation room so clients subscribed to that conversation receive it
        io.to(conversationId.toString()).emit("message:new", out);

        // Also try to find conversation participants to emit to per-user rooms
        const conv = await Conversation.findById(conversationId).lean().exec();
        const clientId =
          conv?.participants?.client?._id?.toString?.() ??
          conv?.participants?.client?.toString?.();
        const businessId =
          conv?.participants?.business?._id?.toString?.() ??
          conv?.participants?.business?.toString?.();

        // If your clients subscribe to `user:<id>` rooms, emit there too
        if (clientId) {
          io.to(`user:${clientId}`).emit("message:new", out);
        }
        if (businessId) {
          io.to(`user:${businessId}`).emit("message:new", out);
        }

        console.debug(
          `Emitted message:new conv=${conversationId} from=${out.from} to=${out.to} client=${clientId} business=${businessId}`
        );
      }
    } catch (emitErr) {
      console.warn("POST /messages - failed to emit socket event:", emitErr);
    }

    return res.status(201).json({ message: out });
  } catch (err) {
    console.error("POST /messages error:", err);
    return res.status(500).json({ message: "Server error", error: (err as Error).message });
  }
});

/**
 * Fetch paginated messages for a conversation
 * GET /messages/:conversationId?limit=25&before=<ISO date or message id>
 */
router.get("/messages/:conversationId", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId;

    if (!mongoose.isValidObjectId(convId)) {
      return res.status(400).json({ message: "Invalid conversationId" });
    }

    const limitRaw = (req.query.limit as string) || "25";
    const limit = Math.min(200, Math.max(1, parseInt(limitRaw, 10) || 25));
    const before = (req.query.before as string) || undefined;

    const q: any = { conversationId: new mongoose.Types.ObjectId(convId) };
    if (before) {
      const maybeDate = new Date(before);
      if (!isNaN(maybeDate.getTime())) {
        q.createdAt = { $lt: maybeDate };
      } else if (mongoose.isValidObjectId(before)) {
        const beforeMsg = await Message.findById(before).lean().exec();
        if (beforeMsg?.createdAt) {
          q.createdAt = { $lt: beforeMsg.createdAt };
        }
      }
    }

    const messages = await Message.find(q).sort({ createdAt: -1 }).limit(limit).lean().exec();

    const normalized = messages.map((m: any) => ({
      id: String(m._id),
      conversationId: String(m.conversationId),
      from: String(m.from),
      to: m.to ? String(m.to) : undefined,
      text: m.text || "",
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
      status: m.status || "sent",
      createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : undefined,
    }));

    return res.json({ messages: normalized });
  } catch (err) {
    console.error("GET /messages/:conversationId error:", err);
    return res.status(500).json({ message: "Server error", error: (err as Error).message });
  }
});

router.get("/get-client-conversations/:clientId", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;

    if (!clientId) {
      return res.status(400).json({ message: "clientId is required" });
    }

    // 🔹 Find all conversations where this client is a participant
    const conversations = await Conversation.find({
      "participants.client": clientId,
    })
      .populate("participants.business", "businessName logo email contactNumber")
      .populate("lastMessage")
      .sort({ updatedAt: -1 });

    if (!conversations.length) {
      return res.status(200).json({ conversations: [] });
    }

    // 🔹 Fetch all messages for each conversation
    const results = await Promise.all(
      conversations.map(async (conv) => {
        const messages = await Message.find({
          conversationId: conv._id,
        })
          .sort({ createdAt: 1 })
          .lean();

        return {
          ...conv.toObject(),
          messages,
        };
      })
    );

    return res.status(200).json({
      conversations: results,
    });
  } catch (err) {
    console.error("Error fetching client conversations:", err);
    res.status(500).json({ message: "Server error", error: err });
  }
});

/**For service provider side */

router.get("/by-business/:businessId", async (req: Request, res: Response) => {
  const start = Date.now();
  try {
    const { businessId } = req.params;
    const limitRaw = (req.query.limit as string) || "";
    // default 50; if limit=0 -> no $limit stage (returns all messages)
    const limit = limitRaw === "" ? 50 : Math.max(0, parseInt(limitRaw, 10) || 0);

    console.log(`[conversations/by-business] called - businessId="${businessId}", limitRaw="${limitRaw}", parsedLimit=${limit}`);

    if (!businessId) {
      console.log("[conversations/by-business] missing businessId");
      return res.status(400).json({ message: "businessId is required" });
    }
    if (!mongoose.Types.ObjectId.isValid(businessId)) {
      console.log(`[conversations/by-business] invalid businessId: "${businessId}"`);
      return res.status(400).json({ message: "Invalid businessId" });
    }

    const businessObjectId = new mongoose.Types.ObjectId(businessId);

    // Aggregation pipeline
    const pipeline: any[] = [
      { $match: { "participants.business": businessObjectId } },
      { $sort: { updatedAt: -1 } },

      // populate client
      {
        $lookup: {
          from: "clients", // adjust collection name if different
          localField: "participants.client",
          foreignField: "_id",
          as: "clientLookup",
        },
      },

      // populate business
      {
        $lookup: {
          from: "businessinfos", // adjust collection name if different
          localField: "participants.business",
          foreignField: "_id",
          as: "businessLookup",
        },
      },

      // lookup messages (fetch the most recent `limit` messages per conversation)
      {
        $lookup: {
          from: "messages",
          let: { cid: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$conversationId", "$$cid"] } } },
            { $sort: { createdAt: -1 } }, // newest first
            ...(limit > 0 ? [{ $limit: limit }] : []), // apply limit if > 0
            { $sort: { createdAt: 1 } }, // return ascending to client
          ],
          as: "messages",
        },
      },

      // simplify client/business arrays to single object
      {
        $addFields: {
          client: { $arrayElemAt: ["$clientLookup", 0] },
          business: { $arrayElemAt: ["$businessLookup", 0] },
        },
      },

      // remove interim lookups and sensitive fields
      {
        $project: {
          clientLookup: 0,
          businessLookup: 0,
          "client.password": 0,
          // Add other fields to strip if necessary
        },
      },
    ];

    // Log pipeline summary (avoid printing ObjectIds directly if you prefer)
    try {
      console.log(`[conversations/by-business] running aggregation pipeline with ${pipeline.length} stages (limit=${limit})`);
    } catch (logErr) {
      console.log("[conversations/by-business] pipeline logging skipped due to error:", logErr);
    }

    const conversations = await Conversation.aggregate(pipeline).exec();

    const duration = Date.now() - start;
    console.log(
      `[conversations/by-business] aggregation complete - businessId="${businessId}", conversations=${Array.isArray(conversations) ? conversations.length : 0
      }, duration=${duration}ms`
    );

    if (!Array.isArray(conversations) || conversations.length === 0) {
      console.log(`[conversations/by-business] no conversations found for businessId="${businessId}"`);
    } else {
      // Log a little detail about the first few conversations for debugging
      const sample = conversations.slice(0, 3).map((c: any) => ({
        id: c._id?.toString?.() ?? c._id,
        clientId: c.participants?.client?._id ?? c.client?._id ?? null,
        businessId: c.participants?.business?._id ?? c.business?._id ?? null,
        messagesCount: Array.isArray(c.messages) ? c.messages.length : 0,
      }));
      console.log("[conversations/by-business] sample conversations:", JSON.stringify(sample, null, 2));
    }

    return res.status(200).json({ conversations });
  } catch (err) {
    console.error("GET /conversations/by-business/:businessId error:", err);
    return res.status(500).json({ message: "Server error", error: (err as Error).message });
  }
});

router.post("/send-provider-messages", async (req: Request, res: Response) => {
  try {
    const io = req.app.get("io") as any | undefined;
    const { conversationId, text, to, attachments } = req.body;

    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }

    // 🔍 Find the conversation and extract the business participant
    const conversation = await Conversation.findById(conversationId).lean().exec();
    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const businessId =
      conversation?.participants?.business?._id?.toString?.() ??
      conversation?.participants?.business?.toString?.();

    if (!businessId) {
      return res
        .status(400)
        .json({ message: "Conversation does not contain a business participant" });
    }

    // ✅ Use businessId as 'from'
    const msg = await Message.create({
      conversationId: new mongoose.Types.ObjectId(conversationId),
      from: new mongoose.Types.ObjectId(businessId),
      to: to ? new mongoose.Types.ObjectId(to) : undefined,
      text: text || "",
      attachments: Array.isArray(attachments) ? attachments : [],
      status: "sent",
    });

    // Update conversation's lastMessage
    try {
      await Conversation.findByIdAndUpdate(conversationId, { lastMessage: msg._id }).exec();
    } catch (_) {}

    // Prepare response
    const out = {
      id: String(msg._id),
      conversationId: String(msg.conversationId),
      from: String(msg.from),
      to: msg.to ? String(msg.to) : undefined,
      text: msg.text,
      attachments: msg.attachments,
      status: msg.status,
      createdAt: msg.createdAt.toISOString(),
    };

    // Emit via Socket.IO — send to conversation room and participant rooms
    try {
      if (io) {
        io.to(conversationId.toString()).emit("message:new", out);

        const clientId =
          conversation?.participants?.client?._id?.toString?.() ??
          conversation?.participants?.client?.toString?.();

        if (clientId) io.to(`user:${clientId}`).emit("message:new", out);
        if (businessId) io.to(`user:${businessId}`).emit("message:new", out);

        console.debug(
          `Emitted message:new conv=${conversationId} from=${businessId} to=${out.to} client=${clientId} business=${businessId}`
        );
      }
    } catch (emitErr) {
      console.warn("POST /messages - failed to emit socket event:", emitErr);
    }

    return res.status(201).json({ message: out });
  } catch (err) {
    console.error("POST /messages error:", err);
    return res.status(500).json({ message: "Server error", error: (err as Error).message });
  }
});



export default router;
