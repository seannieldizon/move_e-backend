import mongoose, { Schema, Document } from "mongoose";

/**
 * Extend IClient with optional fields used by the password reset flow.
 * These are intentionally optional and non-required.
 */
export interface IClient extends Document {
  lastName: string;
  firstName: string;
  middleName?: string;
  extensionName?: string;
  phone?: string;
  email?: string;
  password: string;

  // password-reset fields (optional)
  resetCode?: string;
  resetCodeExpires?: number;    // epoch ms
  resetRequestedAt?: number;    // epoch ms
}

const clientSchema = new Schema<IClient>(
  {
    lastName: { type: String, required: true },
    firstName: { type: String, required: true },
    middleName: { type: String },
    extensionName: { type: String },
    phone: { type: String },
    email: { type: String, unique: true, sparse: true },
    password: { type: String, required: true },

    // --- Add optional fields for reset flow ---
    resetCode: { type: String, required: false },
    resetCodeExpires: { type: Number, required: false },
    resetRequestedAt: { type: Number, required: false },
  },
  { timestamps: true }
);

// ✅ Custom validation: require at least one of phone or email
clientSchema.pre("validate", function (next) {
  if (!this.phone && !this.email) {
    next(new Error("Either phone or email is required"));
  } else {
    next();
  }
});

export default mongoose.model<IClient>("Client", clientSchema);
