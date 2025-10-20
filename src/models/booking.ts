import mongoose, { Schema, Document, Types } from "mongoose";

export type BookingStatus = "pending" | "confirmed" | "cancelled" | "completed" | "rejected";

export interface IBooking extends Document {
  clientId: Types.ObjectId; // reference to client_accounts (user)
  businessId: Types.ObjectId; // reference to BusinessInfo
  serviceId?: Types.ObjectId; // reference to ServiceOffered (optional)
  serviceTitle: string;
  servicePrice?: number;
  serviceDuration?: string; // e.g. "1.5 hrs"
  scheduledAt: Date; // date/time the client selected
  contactName: string;
  contactPhone: string;
  notes?: string;
  status: BookingStatus;
  paymentStatus?: "pending" | "paid" | "failed" | "refunded";
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const bookingSchema = new Schema<IBooking>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "BusinessInfo", required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: "ServiceOffered" },

    // Stored redundantly for convenience and audit (so changes in service record do not affect historical bookings)
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
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
bookingSchema.index({ clientId: 1, createdAt: -1 });
bookingSchema.index({ businessId: 1, scheduledAt: -1 });
bookingSchema.index({ status: 1 });

// Basic validation
bookingSchema.pre("validate", function (next) {
  if (!this.clientId) return next(new Error("clientId is required"));
  if (!this.businessId) return next(new Error("businessId is required"));
  if (!this.serviceTitle || this.serviceTitle.trim().length === 0) return next(new Error("serviceTitle is required"));
  if (!this.scheduledAt) return next(new Error("scheduledAt (date/time) is required"));
  if (!this.contactName || this.contactName.trim().length === 0) return next(new Error("contactName is required"));
  if (!this.contactPhone || this.contactPhone.trim().length === 0) return next(new Error("contactPhone is required"));
  next();
});

export default mongoose.model<IBooking>("Booking", bookingSchema);
