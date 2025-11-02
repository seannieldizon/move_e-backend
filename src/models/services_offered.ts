import mongoose, { Schema, Document, Types } from "mongoose";

export interface IServiceOffered extends Document {
  businessId: Types.ObjectId; // references BusinessInfo._id
  title: string;
  price: number;
  duration?: string;
  description?: string;
  // new image fields
  imagePath?: string; // saved secure_url from Cloudinary or remote image URL
  imagePublicId?: string; // Cloudinary public_id (useful for deletion)
  // optional array if you later support multiple images
  images?: Array<{
    url: string;
    publicId?: string;
  }>;
  createdAt?: Date;
  updatedAt?: Date;
}

const serviceOfferedSchema = new Schema<IServiceOffered>(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "BusinessInfo",
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    duration: { type: String, trim: true },
    description: { type: String, trim: true },

    // Image fields
    imagePath: { type: String, trim: true }, // e.g. https://res.cloudinary.com/...
    imagePublicId: { type: String, trim: true }, // e.g. services/12345/abcdefg

    // Support multiple images if needed later
    images: [
      {
        url: { type: String, required: true },
        publicId: { type: String },
      },
    ],
  },
  { timestamps: true }
);

// Validation hook
serviceOfferedSchema.pre("validate", function (next) {
  // `this` is the mongoose document
  if (!this.title || this.title.trim().length === 0) {
    next(new Error("Service title is required"));
    return;
  }
  // price may be undefined if validation earlier removed it; ensure numeric
  if (this.price === undefined || this.price === null || typeof this.price !== "number") {
    next(new Error("Price is required and must be a number"));
    return;
  }
  if (this.price < 0) {
    next(new Error("Price must be greater than or equal to 0"));
    return;
  }
  if (!this.businessId) {
    next(new Error("Business ID is required"));
    return;
  }
  next();
});

// Friendly virtual for display
serviceOfferedSchema.virtual("display").get(function (this: IServiceOffered) {
  const price = typeof this.price === "number" ? `₱${this.price.toLocaleString()}` : "N/A";
  const duration = this.duration ? ` • ${this.duration}` : "";
  return `${this.title} (${price}${duration})`;
});

// toJSON / toObject options: include virtuals and convert _id -> id, remove __v
serviceOfferedSchema.set("toJSON", {
  virtuals: true,
  transform: (doc: any, ret: any) => {
    ret.id = ret._id?.toString?.() ?? ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

serviceOfferedSchema.set("toObject", {
  virtuals: true,
  transform: (doc: any, ret: any) => {
    ret.id = ret._id?.toString?.() ?? ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model<IServiceOffered>(
  "ServiceOffered",
  serviceOfferedSchema
);
