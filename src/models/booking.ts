import mongoose, { Schema, Document, Types } from "mongoose";

export type BookingStatus = "pending" | "confirmed" | "cancelled" | "completed" | "rejected";

export interface ILocation {
  address: string;
  latitude: number;
  longitude: number;
  floor?: string; // optional: "3", "3rd", "B1", etc.
  note?: string;  // optional: additional directions or instructions
}

export interface IBooking extends Document {
  clientId: Types.ObjectId;
  businessId: Types.ObjectId;
  serviceId?: Types.ObjectId;
  serviceTitle: string;
  servicePrice?: number;
  serviceDuration?: string;
  scheduledAt: Date;
  contactName: string;
  contactPhone: string;
  notes?: string;
  status: BookingStatus;
  paymentStatus?: "pending" | "paid" | "failed" | "refunded";
  metadata?: Record<string, any>;
  location?: ILocation; // nested location with floor & note
  rejectionReason?: string; // optional: only valid when status === 'rejected'
  createdAt: Date;
  updatedAt: Date;
}

const locationSchema = new Schema<ILocation>(
  {
    address: { type: String, required: true, trim: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    floor: { type: String, required: false, trim: true }, // optional
    note: { type: String, required: false, trim: true },  // optional
  },
  { _id: false } // prevents creating a separate _id for the subdocument
);

const bookingSchema = new Schema<IBooking>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "BusinessInfo", required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: "ServiceOffered" },

    serviceTitle: { type: String, required: true, trim: true },
    servicePrice: { type: Number, min: 0 },
    serviceDuration: { type: String, trim: true },

    scheduledAt: { type: Date, required: true },

    contactName: { type: String, required: true, trim: true },
    contactPhone: { type: String, required: true, trim: true },
    notes: { type: String, trim: true },

    status: {
      type: String,
      enum: ["pending", "confirmed", "cancelled", "completed", "rejected"],
      default: "pending",
    },

    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending",
    },

    metadata: { type: Schema.Types.Mixed },

    location: locationSchema, // embedded location object (address, lat, lng, floor, note)

    // NEW: optional rejection reason (only meaningful when status === 'rejected')
    rejectionReason: { type: String, trim: true, required: false },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
bookingSchema.index({ clientId: 1, createdAt: -1 });
bookingSchema.index({ businessId: 1, scheduledAt: -1 });
bookingSchema.index({ status: 1 });
// optional index if you plan to query by rejectionReason:
// bookingSchema.index({ rejectionReason: 1 });

// Basic validation
bookingSchema.pre("validate", function (next) {
  if (!this.clientId) return next(new Error("clientId is required"));
  if (!this.businessId) return next(new Error("businessId is required"));
  if (!this.serviceTitle || this.serviceTitle.trim().length === 0) return next(new Error("serviceTitle is required"));
  if (!this.scheduledAt) return next(new Error("scheduledAt (date/time) is required"));
  if (!this.contactName || this.contactName.trim().length === 0) return next(new Error("contactName is required"));
  if (!this.contactPhone || this.contactPhone.trim().length === 0) return next(new Error("contactPhone is required"));

  // If a location object is present, ensure required location fields exist
  if (this.location) {
    if (!this.location.address) return next(new Error("location.address is required"));
    if (typeof this.location.latitude !== "number") return next(new Error("location.latitude is required and must be a number"));
    if (typeof this.location.longitude !== "number") return next(new Error("location.longitude is required and must be a number"));
    // floor & note are optional — no validation required here
  }

  // Ensure rejectionReason is only set when status === 'rejected'
  if (this.rejectionReason && this.status !== "rejected") {
    return next(new Error("rejectionReason may only be set when status is 'rejected'"));
  }

  next();
});

export default mongoose.model<IBooking>("Booking", bookingSchema);
