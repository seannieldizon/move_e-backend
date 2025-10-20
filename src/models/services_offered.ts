import mongoose, { Schema, Document, Types } from "mongoose";

export interface IServiceOffered extends Document {
  businessId: Types.ObjectId; // references BusinessInfo._id
  title: string;
  price: number;
  duration?: string;
  description?: string;
}

const serviceOfferedSchema = new Schema<IServiceOffered>(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "BusinessInfo",
      required: true,
    },
    title: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    duration: { type: String, trim: true },
    description: { type: String, trim: true, maxlength: 240 },
  },
  { timestamps: true }
);

// ✅ Validation
serviceOfferedSchema.pre("validate", function (next) {
  if (!this.title || this.title.trim().length === 0) {
    next(new Error("Service title is required"));
  } else if (this.price < 0) {
    next(new Error("Price must be greater than or equal to 0"));
  } else if (!this.businessId) {
    next(new Error("Business ID is required"));
  } else {
    next();
  }
});

// ✅ Virtual for display (optional)
serviceOfferedSchema.virtual("display").get(function (this: IServiceOffered) {
  const price = this.price ? `₱${this.price.toLocaleString()}` : "N/A";
  const duration = this.duration ? ` • ${this.duration}` : "";
  return `${this.title} (${price}${duration})`;
});

export default mongoose.model<IServiceOffered>(
  "ServiceOffered",
  serviceOfferedSchema
);
