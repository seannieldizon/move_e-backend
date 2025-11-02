// models/message.ts
import mongoose, { Schema, Document, Types } from "mongoose";

export interface IMessage extends Document {
  conversationId: Types.ObjectId; // group or 1:1 conversation id
  from: Types.ObjectId; // user id
  to?: Types.ObjectId; // optional single recipient for easier queries
  text?: string;
  attachments?: { url: string; mime?: string; name?: string }[];
  status: "sent" | "delivered" | "read";
  createdAt: Date;
  metadata?: Record<string, any>;
}

const messageSchema = new Schema<IMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    from: { type: Schema.Types.ObjectId, ref: "User", required: true },
    to: { type: Schema.Types.ObjectId, ref: "User" }, // optional for 1:1
    text: { type: String },
    attachments: [{ url: String, mime: String, name: String }],
    status: {
      type: String,
      enum: ["sent", "delivered", "read"],
      default: "sent",
    },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

messageSchema.index({ conversationId: 1, createdAt: -1 });
messageSchema.index({ from: 1 });
messageSchema.index({ to: 1 });

export default mongoose.model<IMessage>("Message", messageSchema);
