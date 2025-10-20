import mongoose, { Schema, Document } from "mongoose";

export interface IDaySchedule {
  open?: string | null; // "HH:mm"
  close?: string | null; // "HH:mm"
  closed: boolean;
}

export interface ILocationSubdoc {
  address: string;
  latitude: number;
  longitude: number;
  displayName?: string;
  floor?: string;
  note?: string;
}

export type BusinessCategory =
  | "Hair & Makeup"
  | "Photoshoot"
  | "Gadget Repair"
  | "Aircon Cleaning"
  | "Spa"
  | "Gown Rental"
  | "Water Station"
  | "Laundry Shop"
  | "Salon"
  | "Barbershop";

export interface IBusinessInfo extends Document {
  clientId: mongoose.Types.ObjectId;
  businessName: string;
  contactNumber?: string;
  email?: string;
  logo?: string;
  businessPermit?: string;
  validId?: string;
  location?: ILocationSubdoc;
  operatingSchedule: {
    [day: string]: IDaySchedule;
  };
  fcmTokens?: string[]; // <-- added
  category?: BusinessCategory;
  accountStatus: "for_verification" | "verified" | "rejected";
  createdAt?: Date;
  updatedAt?: Date;
}

const DayScheduleSchema = new Schema<IDaySchedule>(
  {
    open: { type: String, default: null },
    close: { type: String, default: null },
    closed: { type: Boolean, required: true, default: false },
  },
  { _id: false }
);

const LocationSubSchema = new Schema<ILocationSubdoc>(
  {
    address: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    displayName: { type: String },
    floor: { type: String },
    note: { type: String },
  },
  { _id: false }
);

// allowed categories (kept in code for reuse)
const BUSINESS_CATEGORIES: BusinessCategory[] = [
  "Hair & Makeup",
  "Photoshoot",
  "Gadget Repair",
  "Aircon Cleaning",
  "Spa",
  "Gown Rental",
  "Water Station",
  "Laundry Shop",
  "Salon",
  "Barbershop",
];

const businessInfoSchema = new Schema<IBusinessInfo>(
  {
    clientId: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    businessName: { type: String, required: true, trim: true },
    contactNumber: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true, sparse: true },
    logo: { type: String },
    businessPermit: { type: String },
    validId: { type: String },
    location: { type: LocationSubSchema },
    operatingSchedule: {
      type: Map,
      of: DayScheduleSchema,
      default: {
        Mon: { open: null, close: null, closed: false },
        Tue: { open: null, close: null, closed: false },
        Wed: { open: null, close: null, closed: false },
        Thu: { open: null, close: null, closed: false },
        Fri: { open: null, close: null, closed: false },
        Sat: { open: null, close: null, closed: false },
        Sun: { open: null, close: null, closed: false },
      },
    },

    // FCM tokens for devices that belong to the business owner / staff
    fcmTokens: {
      type: [String],
      default: [],
    },

    // category field (optional) — accepts only the listed categories
    category: {
      type: String,
      enum: BUSINESS_CATEGORIES,
      required: false,
    },

    // ✅ Added accountStatus
    accountStatus: {
      type: String,
      enum: ["for_verification", "verified", "rejected"],
      default: "for_verification",
    },
  },
  { timestamps: true }
);

// Validation: require at least one of contactNumber or email
businessInfoSchema.pre("validate", function (next) {
  const doc = this as IBusinessInfo;
  if (!doc.contactNumber && !doc.email) {
    return next(new Error("Either contactNumber or email is required for a business."));
  }
  // require at least one identity doc / permit
  if (!doc.businessPermit && !doc.validId) {
    return next(new Error("Either businessPermit or validId is required for a business."));
  }
  next();
});

// Convenience static helpers for tokens (optional but handy)
businessInfoSchema.statics.findByClient = function (clientId: mongoose.Types.ObjectId | string) {
  return this.find({ clientId }).sort({ createdAt: -1 }).exec();
};

businessInfoSchema.methods = {
  // Add token if it's not already present
  async addFcmToken(this: IBusinessInfo & { save: Function }, token: string) {
    if (!token || typeof token !== "string") return;
    const tokens = (this.fcmTokens ?? []).map((t) => String(t));
    if (!tokens.includes(token)) {
      tokens.push(token);
      this.fcmTokens = tokens;
      await this.save();
    }
  },

  // Remove a token if present
  async removeFcmToken(this: IBusinessInfo & { save: Function }, token: string) {
    if (!token || typeof token !== "string") return;
    const tokens = (this.fcmTokens ?? []).filter((t) => t !== token);
    this.fcmTokens = tokens;
    await this.save();
  },
};

export { BUSINESS_CATEGORIES };

export default mongoose.model<IBusinessInfo & { findByClient?: Function }>(
  "BusinessInfo",
  businessInfoSchema
);
