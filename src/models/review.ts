// models/review.ts
import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Review model
 *
 * Fields:
 * - clientId: reference to clients/users (optional if anonymous)
 * - businessId: reference to BusinessInfo (required)
 * - rating: number (1..5) required
 * - text: comment text (optional but encouraged)
 * - photoUrls: optional array of strings (URLs or storage ids)
 * - authorName: optional cached display name (so we don't need to populate client every time)
 * - metadata: mixed for extensibility
 *
 * Timestamps enabled (createdAt, updatedAt)
 */

export interface IReview extends Document {
  clientId?: Types.ObjectId | null;
  businessId: Types.ObjectId;
  rating: number;
  text?: string;
  photoUrls?: string[];
  authorName?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const reviewSchema = new Schema<IReview>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: false, index: true },
    businessId: { type: Schema.Types.ObjectId, ref: "BusinessInfo", required: true, index: true },

    // 1..5 integer rating
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: {
        validator: Number.isInteger,
        message: "rating must be an integer between 1 and 5",
      },
    },

    // main comment text
    text: { type: String, trim: true, required: false, maxlength: 2000 },

    // optional photos (URLs or storage ids)
    photoUrls: [{ type: String, trim: true }],

    // cached author display name (useful when client is deleted or to avoid populate)
    authorName: { type: String, trim: true, required: false },

    metadata: { type: Schema.Types.Mixed, required: false },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform: function (doc, ret: any) {
        // ensure id is string and remove _id safely (TS-friendly)
        if (ret && ret._id) {
          try {
            ret.id = (ret._id as Types.ObjectId).toString();
          } catch (_) {
            // fallback
            ret.id = String(ret._id);
          }
        }
        // avoid TS error "operand of delete must be optional" by casting
        delete (ret as { _id?: unknown })._id;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      versionKey: false,
      transform: function (doc, ret: any) {
        if (ret && ret._id) {
          try {
            ret.id = (ret._id as Types.ObjectId).toString();
          } catch (_) {
            ret.id = String(ret._id);
          }
        }
        delete (ret as { _id?: unknown })._id;
        return ret;
      },
    },
  }
);

// indexes
reviewSchema.index({ businessId: 1, rating: -1 });
reviewSchema.index({ businessId: 1, createdAt: -1 });
reviewSchema.index({ clientId: 1, createdAt: -1 });

// Basic validation hook
reviewSchema.pre("validate", function (next) {
  if (!this.businessId) return next(new Error("businessId is required for a review"));
  if (!this.rating || typeof this.rating !== "number") return next(new Error("rating (1-5) is required"));
  const r = Math.round(this.rating);
  if (r < 1 || r > 5) return next(new Error("rating must be between 1 and 5"));
  this.rating = r;
  next();
});

/**
 * Optional convenience static: compute aggregated stats for a business
 * Usage: await Review.computeStats(businessId)
 */
reviewSchema.statics.computeStats = async function (businessId: Types.ObjectId | string) {
  const objectId = typeof businessId === "string" ? new mongoose.Types.ObjectId(businessId) : businessId;
  const pipeline = [
    { $match: { businessId: objectId } },
    {
      $group: {
        _id: "$businessId",
        count: { $sum: 1 },
        avgRating: { $avg: "$rating" },
        count5: { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
        count4: { $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] } },
        count3: { $sum: { $cond: [{ $eq: ["$rating", 3] }, 1, 0] } },
        count2: { $sum: { $cond: [{ $eq: ["$rating", 2] }, 1, 0] } },
        count1: { $sum: { $cond: [{ $eq: ["$rating", 1] }, 1, 0] } },
      },
    },
  ];
  const res = await (this as any).aggregate(pipeline).exec();
  return res[0] ?? { count: 0, avgRating: 0, count5: 0, count4: 0, count3: 0, count2: 0, count1: 0 };
};

export default mongoose.model<IReview & mongoose.Document>("Review", reviewSchema);
