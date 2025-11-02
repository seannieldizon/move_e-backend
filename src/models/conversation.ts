// src/models/conversation.ts
import mongoose, { Schema, Document, Types } from "mongoose";

export interface IConversation extends Document {
  participants: {
    client: Types.ObjectId; // Reference to Client
    business: Types.ObjectId; // Reference to BusinessInfo
  };
  metadata?: any;
  lastMessage?: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const ConversationSchema = new Schema<IConversation>(
  {
    participants: {
      client: {
        type: Schema.Types.ObjectId,
        ref: "Client",
        required: true,
      },
      business: {
        type: Schema.Types.ObjectId,
        ref: "BusinessInfo",
        required: true,
      },
    },

    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },

    lastMessage: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ✅ Ensure unique pair of client + business (so no duplicate conversations)
ConversationSchema.index(
  { "participants.client": 1, "participants.business": 1 },
  { unique: true }
);

export default mongoose.model<IConversation>("Conversation", ConversationSchema);
