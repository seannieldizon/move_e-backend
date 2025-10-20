import mongoose, { Schema, Document } from "mongoose";

export interface ILocation extends Document {
  clientId: mongoose.Types.ObjectId;
  address: string;
  latitude: number;
  longitude: number;
  displayName?: string;
  floor?: string;
  note?: string;
}

const locationSchema = new Schema<ILocation>(
  {
    clientId: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    address: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    displayName: { type: String },
    floor: { type: String },
    note: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model<ILocation>("Location", locationSchema);
