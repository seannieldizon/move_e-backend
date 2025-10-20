import mongoose, { Schema, Document } from "mongoose";

export interface IFavorite extends Document {
  clientId: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const favoriteSchema = new Schema<IFavorite>(
  {
    clientId: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
  },
  { timestamps: true }
);

// Optional: prevent duplicate favorites per client
favoriteSchema.index({ clientId: 1, businessId: 1 }, { unique: true });

export default mongoose.model<IFavorite>("Favorite", favoriteSchema);
