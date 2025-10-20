import mongoose, { Schema, Document } from "mongoose";

export interface IClient extends Document {
  lastName: string;
  firstName: string;
  middleName?: string;
  extensionName?: string;
  phone?: string;
  email?: string;
  password: string;
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
