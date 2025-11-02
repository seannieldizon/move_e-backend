import mongoose, { Schema, Document } from "mongoose";

/**
 * BusinessInfo model (updated)
 *
 * Changes:
 * - validId is now a sub-document { front, back } to store both front/back ID file paths or URLs.
 * - pre("validate") updated to require either businessPermit OR both validId.front & validId.back.
 * - kept existing fields & behavior otherwise.
 */

/* ----------------------------- Sub-interfaces ---------------------------- */

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

export interface IValidIdSubdoc {
  front?: string | null; // filepath or URL
  back?: string | null; // filepath or URL
}

/* ----------------------------- Enums / Types ----------------------------- */

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

/* ----------------------------- Main interface ---------------------------- */

export interface IBusinessInfo extends Document {
  clientId: mongoose.Types.ObjectId;
  businessName: string;
  contactNumber?: string;
  email?: string;
  logo?: string;
  businessPermit?: string;
  validId?: IValidIdSubdoc;
  location?: ILocationSubdoc;
  operatingSchedule: {
    [day: string]: IDaySchedule;
  };
  fcmTokens?: string[]; // device tokens
  category?: BusinessCategory;
  accountStatus: "for_verification" | "verified" | "rejected";
  createdAt?: Date;
  updatedAt?: Date;
}

/* ----------------------------- Sub-schemas ------------------------------- */

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

const ValidIdSubSchema = new Schema<IValidIdSubdoc>(
  {
    front: { type: String, default: null },
    back: { type: String, default: null },
  },
  { _id: false }
);

/* ----------------------------- Constants -------------------------------- */

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

/* ----------------------------- Main schema ------------------------------- */

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

    // validId is now a sub-document holding front/back image paths or URLs
    validId: { type: ValidIdSubSchema },

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

    // accountStatus
    accountStatus: {
      type: String,
      enum: ["for_verification", "verified", "rejected"],
      default: "for_verification",
    },
  },
  { timestamps: true }
);

/* ----------------------------- Validation --------------------------------
   Require either contactNumber or email; require either businessPermit OR
   BOTH validId.front & validId.back (you can relax this to require any side
   by changing the check below).
--------------------------------------------------------------------------- */

businessInfoSchema.pre("validate", function (next) {
  const doc = this as IBusinessInfo & { validId?: IValidIdSubdoc };

  // require contact info
  if (!doc.contactNumber && !doc.email) {
    return next(new Error("Either contactNumber or email is required for a business."));
  }

  const hasPermit = !!doc.businessPermit;
  const hasValidIdFront = !!(doc.validId && doc.validId.front);
  // const hasValidIdBoth = !!(doc.validId && doc.validId.front && doc.validId.back);

  // Accept: businessPermit OR at least a front valid ID
  if (!hasPermit && !hasValidIdFront) {
    return next(
      new Error(
        "Either businessPermit or a valid ID (front image) is required for a business."
      )
    );
  }

  next();
});


/* ----------------------------- Statics / Methods -------------------------- */

// Convenience static helper for tokens (optional but handy)
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

/* ----------------------------- Exports ----------------------------------- */

export { BUSINESS_CATEGORIES };

export default mongoose.model<IBusinessInfo & { findByClient?: Function }>(
  "BusinessInfo",
  businessInfoSchema
);
