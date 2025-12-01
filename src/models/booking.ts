import mongoose, { Schema, Document, Types } from "mongoose";

export type BookingStatus = "pending" | "confirmed" | "cancelled" | "completed" | "rejected";

export interface ILocation {
  address: string;
  latitude: number;
  longitude: number;
  floor?: string; // optional: "3", "3rd", "B1", etc.
  note?: string;  // optional: additional directions or instructions
}

export interface ITrackingHistoryEntry {
  status: string; // human label: Preparing, On the way, Arrived, Completed, etc.
  message?: string;
  actorId?: Types.ObjectId | string | null;
  actorType?: string | null; // e.g. "provider" | "driver" | "system"
  actorName?: string | null;
  timestamp: Date;
  location?: {
    latitude?: number;
    longitude?: number;
    address?: string;
  };
  meta?: Record<string, any>;
  notify?: {
    push?: boolean;
    sms?: boolean;
    email?: boolean;
  };
  photos?: string[]; // array of URLs or storage ids
  externalId?: string; // optional external system id
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
  // NEW fields for tracking
  tracking?: string; // current label
  trackingMessage?: string; // convenience message
  trackingHistory?: ITrackingHistoryEntry[]; // historical events
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

// trackingHistory subdocument schema
const trackingHistorySchema = new Schema(
  {
    status: { type: String, required: true, trim: true }, // human readable status
    message: { type: String, trim: true, default: "" },
    actorId: { type: Schema.Types.ObjectId, ref: "User", required: false },
    actorType: { type: String, required: false }, // e.g. provider, driver, system
    actorName: { type: String, required: false, trim: true },
    timestamp: { type: Date, required: true, default: () => new Date() },
    location: {
      latitude: { type: Number, required: false },
      longitude: { type: Number, required: false },
      address: { type: String, required: false, trim: true },
    },
    meta: { type: Schema.Types.Mixed, required: false },
    notify: {
      push: { type: Boolean, default: false },
      sms: { type: Boolean, default: false },
      email: { type: Boolean, default: false },
    },
    photos: [{ type: String }],
    externalId: { type: String, required: false, trim: true },
  },
  { _id: false }
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

    // optional rejection reason (only meaningful when status === 'rejected')
    rejectionReason: { type: String, trim: true, required: false },

    // --- TRACKING FIELDS ---
    tracking: { type: String, required: false, trim: true, index: true }, // current short label
    trackingMessage: { type: String, required: false, trim: true }, // convenience message
    trackingHistory: { type: [trackingHistorySchema], default: [] }, // historical tracking entries
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
bookingSchema.index({ clientId: 1, createdAt: -1 });
bookingSchema.index({ businessId: 1, scheduledAt: -1 });
bookingSchema.index({ status: 1 });
bookingSchema.index({ tracking: 1 });
// index timestamp in embedded history for range queries (works as a multikey index)
bookingSchema.index({ "trackingHistory.timestamp": -1 });

// Basic validation and invariants
bookingSchema.pre("validate", function (next) {
  // `this` is a Booking document
  // required core fields
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

  // Validate trackingHistory entries if present
  if (Array.isArray(this.trackingHistory)) {
    for (const entry of this.trackingHistory) {
      if (!entry || typeof entry !== "object") {
        return next(new Error("trackingHistory entries must be objects"));
      }
      if (!entry.status || String(entry.status).trim().length === 0) {
        return next(new Error("Each trackingHistory entry must include a non-empty 'status'"));
      }
      if (!entry.timestamp || !(entry.timestamp instanceof Date) && isNaN(new Date(entry.timestamp).getTime())) {
        return next(new Error("Each trackingHistory entry must include a valid 'timestamp'"));
      }
      // Optionally enforce message length
      if (entry.message && String(entry.message).length > 1000) {
        return next(new Error("trackingHistory.message exceeds maximum length (1000)"));
      }
    }
  }

  next();
});

/*
 * Optional helper: When you accept a booking you may want to automatically push
 * an initial trackingHistory entry. You can implement this in your accept route
 * or here as a helper method.
 *
 * Example (not activated automatically):
 *
 * bookingSchema.methods.pushTracking = function (entry) {
 *   this.trackingHistory = this.trackingHistory || [];
 *   this.trackingHistory.push(entry);
 *   this.tracking = entry.status;
 *   this.trackingMessage = entry.message || "";
 *   return this.save();
 * };
 *
 * Retention note: trackingHistory can grow. Consider capping (e.g. store last N entries)
 * or archiving older entries to a separate collection if you expect many updates.
 */

export default mongoose.model<IBooking>("Booking", bookingSchema);
