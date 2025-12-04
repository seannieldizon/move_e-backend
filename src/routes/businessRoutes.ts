import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import multer from "multer";
import streamifier from "streamifier";
import { v2 as cloudinary } from "cloudinary";
import BusinessInfo, { BUSINESS_CATEGORIES } from "../models/business_info";
import Booking from "../models/booking";
import ServiceOffered from "../models/services_offered";
import dotenv from "dotenv";
import { DateTime } from "luxon";
import fs from "fs/promises";
import Review from '../models/review';

const router = Router();
dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function uploadStreamToCloudinary(readable: NodeJS.ReadableStream, options: any = {}) {
  return new Promise<any>((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(options, (error: any, result: any) => {
      if (error) return reject(error);
      resolve(result);
    });
    readable.pipe(uploadStream);
  });
}

// Helper: convert readable stream to buffer (fallback)
async function streamToBuffer(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    readable.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", (err) => reject(err));
  });
}

function uploadBufferToCloudinary(buffer: Buffer, options: any = {}) {
  return new Promise<any>((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) return reject(error);
        resolve(result!);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

function uploadDataUrlToCloudinary(dataUrl: string, options: any = {}) {
  return cloudinary.uploader.upload(dataUrl, options);
}

router.post(
  "/add-business",
  upload.fields([
    { name: "logo", maxCount: 1 },
    { name: "businessPermit", maxCount: 1 },
    // Support both the old single 'validId' field AND the new separate fields:
    { name: "validId", maxCount: 1 },
    { name: "validIdFront", maxCount: 1 },
    { name: "validIdBack", maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    try {
      const {
        clientId,
        businessName,
        contactNumber,
        email,
        logo: logoFromBody,
        businessPermit: businessPermitFromBody,
        validId: validIdFromBody, // legacy single-field support (string or URL)
        validIdFront: validIdFrontFromBody, // dataURL or URL string (optional)
        validIdBack: validIdBackFromBody, // dataURL or URL string (optional)
        location,
        operatingSchedule,
        category,
      } = req.body;

      // Basic validation
      if (!clientId || !businessName) {
        return res
          .status(400)
          .json({ message: "clientId and businessName are required." });
      }

      if (!mongoose.isValidObjectId(clientId)) {
        return res.status(400).json({ message: "clientId is not a valid id." });
      }

      if (!contactNumber && !email) {
        return res
          .status(400)
          .json({ message: "Either contactNumber or email is required." });
      }

      // Build new doc
      const doc: any = {
        clientId: new mongoose.Types.ObjectId(clientId),
        businessName: String(businessName).trim(),
      };

      if (contactNumber) doc.contactNumber = String(contactNumber).trim();
      if (email) doc.email = String(email).trim().toLowerCase();

      // Category validation (unchanged)
      if (category && typeof category === "string") {
        const allowedCategories = [
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

        if (!allowedCategories.includes(category)) {
          return res
            .status(400)
            .json({ message: `Invalid category: ${category}` });
        }

        doc.category = category as (typeof allowedCategories)[number];
      }

      // Extract files uploaded through multer (if any)
      const files = req.files as
        | { [fieldname: string]: Express.Multer.File[] }
        | undefined;
      const cloudFolder = `businesses/${clientId}`;

      // Helper for Cloudinary upload (generic)
      async function processUploadField(
        fieldName: string,
        fileArray?: Express.Multer.File[] | undefined,
        dataUrlOrUrl?: string | undefined
      ): Promise<{ url?: string; public_id?: string } | undefined> {
        try {
          // priority: file buffer (multipart) -> dataUrl (base64) or direct URL string
          if (fileArray && fileArray.length > 0) {
            const file = fileArray[0];
            const result = await uploadBufferToCloudinary(file.buffer, {
              folder: cloudFolder,
              resource_type: "image",
            });
            return { url: result.secure_url, public_id: result.public_id };
          } else if (
            dataUrlOrUrl &&
            typeof dataUrlOrUrl === "string" &&
            dataUrlOrUrl.trim().length > 0
          ) {
            // If string begins with http(s) assume it's already a URL
            if (
              dataUrlOrUrl.startsWith("http://") ||
              dataUrlOrUrl.startsWith("https://")
            ) {
              return { url: dataUrlOrUrl };
            }
            // Otherwise treat as data URL (base64)
            const result = await uploadDataUrlToCloudinary(dataUrlOrUrl, {
              folder: cloudFolder,
              resource_type: "image",
            });
            return { url: result.secure_url, public_id: result.public_id };
          }
          return undefined;
        } catch (err) {
          throw new Error(
            `Failed to upload ${fieldName}: ${(err as any).message || err}`
          );
        }
      }

      // Process uploads in parallel:
      const [
        logoResult,
        permitResult,
        // legacy single validId (if provided)
        legacyValidIdResult,
        // new separate fields
        validIdFrontResult,
        validIdBackResult,
      ] = await Promise.all([
        processUploadField("logo", files?.logo, logoFromBody),
        processUploadField("businessPermit", files?.businessPermit, businessPermitFromBody),
        processUploadField("validId (legacy)", files?.validId, validIdFromBody),
        processUploadField("validIdFront", files?.validIdFront, validIdFrontFromBody),
        processUploadField("validIdBack", files?.validIdBack, validIdBackFromBody),
      ]);

      // Attach single fields if present
      if (logoResult?.url) doc.logo = logoResult.url;
      if (permitResult?.url) doc.businessPermit = permitResult.url;

      // Build validId sub-object:
      // Prefer explicit front/back; fall back to legacy single 'validId' if provided.
      const validIdObj: { front?: string | null; back?: string | null } = {
        front: validIdFrontResult?.url ?? null,
        back: validIdBackResult?.url ?? null,
      };

      // If both front/back empty and legacy provided, put legacy into front (back remains null)
      if (!validIdObj.front && !validIdObj.back && legacyValidIdResult?.url) {
        validIdObj.front = legacyValidIdResult.url;
      }

      // If the client included legacy validId in body as a plain string URL and we didn't upload it
      if (!validIdObj.front && !validIdObj.back && typeof validIdFromBody === "string" && validIdFromBody.trim()) {
        // if it's a URL use it
        if (validIdFromBody.startsWith("http://") || validIdFromBody.startsWith("https://")) {
          validIdObj.front = validIdFromBody;
        }
      }

      // Only set doc.validId if at least one side exists
      if (validIdObj.front || validIdObj.back) {
        doc.validId = validIdObj;
      }

      // Also allow businessPermit provided via body (if not uploaded)
      if (businessPermitFromBody && typeof businessPermitFromBody === "string") {
        // If it's a URL, use it directly; else will be handled above if uploaded
        if (businessPermitFromBody.startsWith("http://") || businessPermitFromBody.startsWith("https://")) {
          doc.businessPermit = businessPermitFromBody;
        }
      }

      // Server-side validation: require either businessPermit OR at least the front of validId
      const hasPermit = !!doc.businessPermit;
      const hasValidIdFront = !!(doc.validId && doc.validId.front);

      if (!hasPermit && !hasValidIdFront) {
        return res.status(400).json({
          message:
            "Either businessPermit or a valid ID (front image) is required for a business.",
        });
      }

      // Optional: validate file types / sizes here (recommended)
      // e.g. if (files?.validIdFront?.[0] && files.validIdFront[0].mimetype !== 'image/jpeg') { ... }

      // ✅ Location parsing (unchanged)
      if (location) {
        let parsedLocation = location;
        if (typeof location === "string") {
          try {
            parsedLocation = JSON.parse(location);
          } catch {
            return res
              .status(400)
              .json({ message: "location must be valid JSON." });
          }
        }
        const { address, latitude, longitude, displayName, floor, note } =
          parsedLocation;
        if (
          !address ||
          typeof latitude !== "number" ||
          typeof longitude !== "number"
        ) {
          return res
            .status(400)
            .json({ message: "Incomplete location details." });
        }
        doc.location = {
          address: String(address).trim(),
          latitude,
          longitude,
          displayName: displayName ? String(displayName).trim() : undefined,
          floor: floor ? String(floor).trim() : undefined,
          note: note ? String(note).trim() : undefined,
        };
      }

      // ✅ Schedule parsing (unchanged)
      if (operatingSchedule) {
        try {
          doc.operatingSchedule =
            typeof operatingSchedule === "string"
              ? JSON.parse(operatingSchedule)
              : operatingSchedule;
        } catch {
          console.warn("Invalid operatingSchedule JSON, ignoring.");
        }
      }

      // Save business
      const business = new BusinessInfo(doc);
      await business.save();

      return res
        .status(201)
        .json({ message: "Business created successfully.", business });
    } catch (error: any) {
      console.error("POST /api/businesses error:", error);
      if (error.name === "ValidationError") {
        return res
          .status(400)
          .json({ message: error.message, errors: error.errors });
      }
      return res
        .status(500)
        .json({ message: error.message || "Server error." });
    }
  }
);


router.get("/get-business/:clientId", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;

    if (!clientId) {
      return res.status(400).json({ message: "clientId is required." });
    }

    if (!mongoose.isValidObjectId(clientId)) {
      return res.status(400).json({ message: "Invalid clientId format." });
    }

    const businesses = await BusinessInfo.find({ clientId })
      .sort({ createdAt: -1 })
      .exec();

    if (!businesses || businesses.length === 0) {
      return res
        .status(404)
        .json({ message: "No businesses found for this client." });
    }

    return res.status(200).json({ businesses });
  } catch (error: unknown) {
    console.error("GET /api/businesses/:clientId error:", error);

    // Safely handle unknown type
    if (error instanceof Error) {
      return res
        .status(500)
        .json({ message: "Server error.", error: error.message });
    }

    return res.status(500).json({ message: "Unknown server error." });
  }
});

router.get("/get-verified-businesses", async (req: Request, res: Response) => {
  try {
    const categoryParam = req.query.category;
    const pageParam = req.query.page;
    const limitParam = req.query.limit;

    // pagination defaults
    const page = Math.max(1, Number(pageParam) || 1);
    const limit = Math.min(100, Math.max(1, Number(limitParam) || 20));
    const skip = (page - 1) * limit;

    const filter: any = {
      accountStatus: "verified",
    };

    // If category provided: validate and apply
    if (categoryParam) {
      const category = String(categoryParam).trim();
      if (!BUSINESS_CATEGORIES.includes(category as any)) {
        return res
          .status(400)
          .json({ message: `Invalid category '${category}'. Allowed: ${BUSINESS_CATEGORIES.join(", ")}` });
      }
      filter.category = category;
    }

    // Query DB for businesses (lean for performance)
    const [total, businesses] = await Promise.all([
      BusinessInfo.countDocuments(filter).exec(),
      BusinessInfo.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
    ]);

    // If no businesses returned, short-circuit
    if (!businesses || businesses.length === 0) {
      return res.status(200).json({
        total,
        page,
        perPage: limit,
        businesses: [],
      });
    }

    // Collect business ids
    const businessIds = businesses.map((b: any) => {
      // b._id might be ObjectId or string; normalise to ObjectId
      try {
        return new mongoose.Types.ObjectId(b._id);
      } catch (_) {
        return b._id;
      }
    });

    // Aggregate review stats for these businesses in one query
    const stats = await Review.aggregate([
      { $match: { businessId: { $in: businessIds } } },
      {
        $group: {
          _id: "$businessId",
          reviewCount: { $sum: 1 },
          avgRating: { $avg: "$rating" },
        },
      },
    ]).exec();

    // Create map: businessIdStr -> stats
    const statsMap = new Map<string, { reviewCount: number; avgRating: number }>();
    for (const s of stats) {
      const idStr = String(s._id);
      statsMap.set(idStr, {
        reviewCount: s.reviewCount ?? 0,
        avgRating: typeof s.avgRating === "number" ? s.avgRating : 0,
      });
    }

    // Attach aggregated stats to each business
    const businessesWithStats = businesses.map((b: any) => {
      const idStr = String(b._id ?? b.id);
      const s = statsMap.get(idStr);
      return {
        ...b,
        reviewCount: s ? s.reviewCount : 0,
        avgRating: s ? Math.round((s.avgRating + Number.EPSILON) * 10) / 10 : 0, // one decimal
      };
    });

    return res.status(200).json({
      total,
      page,
      perPage: limit,
      businesses: businessesWithStats,
    });
  } catch (err) {
    console.error("GET /api/businesses error:", err);
    if (err instanceof Error) {
      return res.status(500).json({ message: "Server error.", error: err.message });
    }
    return res.status(500).json({ message: "Unknown server error." });
  }
});


router.get("/services", async (req: Request, res: Response) => {
  try {
    const businessId = (req.query.businessId ?? req.query.business_id) as string | undefined;
    if (!businessId) {
      return res.status(400).json({ message: "businessId query parameter is required." });
    }
    if (!mongoose.isValidObjectId(businessId)) {
      return res.status(400).json({ message: "Invalid businessId format." });
    }

    const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
    const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) ?? "50", 10)));
    const skip = (page - 1) * limit;

    let sort: any = { createdAt: -1 };
    if (typeof req.query.sort === "string" && req.query.sort.includes(":")) {
      const [field, dir] = (req.query.sort as string).split(":");
      sort = { [field]: dir === "asc" ? 1 : -1 };
    }

    const filter: any = { businessId: new mongoose.Types.ObjectId(businessId) };

    const [total, services] = await Promise.all([
      ServiceOffered.countDocuments(filter).exec(),
      ServiceOffered.find(filter).sort(sort).skip(skip).limit(limit).lean().exec(),
    ]);

    return res.status(200).json({ services, total, page, limit });
  } catch (err) {
    console.error("GET /api/businesses/services error:", err);
    if (err instanceof Error) return res.status(500).json({ message: "Server error.", error: err.message });
    return res.status(500).json({ message: "Unknown server error." });
  }
});

/**
 * GET /services/by-business/:businessId
 * Convenience endpoint to get services for a business (no pagination by default)
 */
router.get("/services/by-business/:businessId", async (req: Request, res: Response) => {
  try {
    const { businessId } = req.params;
    if (!businessId) return res.status(400).json({ message: "businessId is required in path." });
    if (!mongoose.isValidObjectId(businessId)) return res.status(400).json({ message: "Invalid businessId format." });

    // Try to fetch the business to read its category (if present).
    // We do NOT return 404 if the business is missing — we simply return category: null
    // to keep behaviour compatible with the original endpoint's outputs.
    const business = await BusinessInfo.findById(businessId).lean().exec();
    const businessCategory = business && typeof business.category !== "undefined" ? business.category : null;

    const filter = { businessId: new mongoose.Types.ObjectId(businessId) };

    const services = await ServiceOffered.find(filter).sort({ createdAt: -1 }).lean().exec();
    const total = await ServiceOffered.countDocuments(filter).exec();

    // NOTE: original fields preserved; added `category` from BusinessInfo
    return res.status(200).json({ services, total, category: businessCategory });
  } catch (err) {
    console.error("GET /services/by-business/:businessId error:", err);
    if (err instanceof Error) return res.status(500).json({ message: "Server error.", error: err.message });
    return res.status(500).json({ message: "Unknown server error." });
  }
});

router.post(
  "/add-service",
  upload.single("image"),
  async (req: Request, res: Response) => {
    try {
      const {
        businessId,
        title,
        price: rawPrice,
        duration,
        description,
        imageData, // optional in-body data URL or remote URL
      } = req.body as {
        businessId?: string;
        title?: string;
        price?: string | number;
        duration?: string;
        description?: string;
        imageData?: string;
      };

      // Basic validation
      if (!businessId || !title || (rawPrice === undefined || rawPrice === null || String(rawPrice).trim() === "")) {
        return res.status(400).json({ message: "businessId, title and price are required." });
      }

      if (!mongoose.isValidObjectId(businessId)) {
        return res.status(400).json({ message: "Invalid businessId." });
      }

      // Ensure referenced business exists
      const business = await BusinessInfo.findById(businessId).exec();
      if (!business) {
        return res.status(404).json({ message: "Business not found." });
      }

      // Normalize price
      const parsedPrice = typeof rawPrice === "number"
        ? rawPrice
        : parseFloat(String(rawPrice).replace(/[,₱\s]/g, ""));
      if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
        return res.status(400).json({ message: "Price must be a valid non-negative number." });
      }

      // Build service doc
      const serviceDoc: any = {
        businessId: new mongoose.Types.ObjectId(businessId),
        title: String(title).trim(),
        price: Math.round(parsedPrice),
      };
      if (duration) serviceDoc.duration = String(duration).trim();
      if (description) serviceDoc.description = String(description).trim();

      // Save service first (without image). We'll update with image URL after upload.
      let service = new ServiceOffered(serviceDoc);
      await service.save();

      // Upload image (if provided) and then update the saved service with the url/public_id
      let imageResult: { url?: string; public_id?: string } | undefined;
      const cloudFolder = `services/${businessId}`;

      try {
        // Case: multipart uploaded file (multer puts file buffer on req.file)
        if (req.file && req.file.buffer && req.file.size && req.file.mimetype) {
          console.log(`Uploading multipart file for service ${service._id}`);
          const uploadRes = await uploadBufferToCloudinary(req.file.buffer, {
            folder: cloudFolder,
            resource_type: "image",
          });
          imageResult = { url: uploadRes.secure_url, public_id: uploadRes.public_id };
        } else if (imageData && typeof imageData === "string" && imageData.trim().length > 0) {
          // in-body imageData: could be remote URL or base64 data URL
          if (imageData.startsWith("http://") || imageData.startsWith("https://")) {
            // remote url — store as-is (no cloudinary upload)
            imageResult = { url: imageData };
          } else {
            // assume base64 data URL — upload to Cloudinary
            const uploadRes = await uploadDataUrlToCloudinary(imageData, {
              folder: cloudFolder,
              resource_type: "image",
            });
            imageResult = { url: uploadRes.secure_url, public_id: uploadRes.public_id };
          }
        }
      } catch (err) {
        console.warn("Service image upload failed:", err);
        // continue — we don't fail creating service on upload error, but we won't have imageResult
      }

      // If upload succeeded (or remote URL provided), persist into service document (single image)
      if (imageResult && imageResult.url) {
        // use imagePath field and optional imagePublicId
        service.imagePath = imageResult.url;
        if (imageResult.public_id) service.imagePublicId = imageResult.public_id;

        // if your schema has `images` array and you want to use it instead, do:
        // service.images = [{ url: imageResult.url, publicId: imageResult.public_id }];

        // Save the update
        await service.save();
      }

      // Return the saved/updated service
      return res.status(201).json({
        message: "Service created successfully.",
        service,
        image: imageResult,
      });
    } catch (error: any) {
      console.error("POST /api/businesses/add-service error:", error);
      if (error.name === "ValidationError") {
        return res.status(400).json({ message: error.message, errors: error.errors });
      }
      return res.status(500).json({ message: error.message || "Server error." });
    }
  }
);


router.get(
  ["/services/by-business/:businessId", "/services"],
  async (req: Request, res: Response) => {
    try {
      // Accept businessId either in path or query
      const businessId = (req.params.businessId || req.query.businessId || "").toString();

      if (!businessId) {
        return res.status(400).json({ message: "businessId is required (path or query)." });
      }

      if (!mongoose.isValidObjectId(businessId)) {
        return res.status(400).json({ message: "Invalid businessId format." });
      }

      // Pagination
      const page = Math.max(1, Number(req.query.page) || 1);
      const perPage = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const skip = (page - 1) * perPage;

      // populate flag
      const populate = String(req.query.populate || "false").toLowerCase() === "true";

      // find business (ensures business exists)
      const business = await BusinessInfo.findById(businessId).lean().exec();
      if (!business) {
        return res.status(404).json({ message: "Business not found for provided businessId." });
      }

      // Build query for services
      const query = ServiceOffered.find({ businessId: new mongoose.Types.ObjectId(businessId) });

      // count and fetch (with pagination)
      const [total, services] = await Promise.all([
        ServiceOffered.countDocuments({ businessId: business._id }).exec(),
        (populate ? query.populate({ path: "businessId", select: "businessName contactNumber email logo category accountStatus" }) : query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(perPage)
          .lean()
          .exec(),
      ]);

      // Defensive check: ensure each service.businessId matches requested businessId
      const mismatches: any[] = [];
      const requestedIdStr = business._id.toString();
      for (const s of services) {
        // service.businessId may be an ObjectId or populated object
        const svcBiz = (s as any).businessId;
        const svcBizIdStr =
          svcBiz == null
            ? null
            : (typeof svcBiz === "string"
                ? svcBiz
                : svcBiz._id
                  ? svcBiz._id.toString()
                  : svcBiz.toString());

        if (svcBizIdStr !== requestedIdStr) {
          mismatches.push({
            serviceId: (s as any)._id,
            serviceBusinessId: svcBizIdStr,
            expected: requestedIdStr,
            service: s,
          });
        }
      }

      return res.status(200).json({
        business,
        total,
        page,
        perPage,
        services,
        mismatches,
      });
    } catch (err) {
      console.error("GET /api/services/by-business error:", err);
      if (err instanceof Error) {
        return res.status(500).json({ message: "Server error.", error: err.message });
      }
      return res.status(500).json({ message: "Unknown server error." });
    }
  }
);

router.put("/service/:id", upload.single("image"), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id || !mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Valid service id is required." });
    }

    // DEBUG: log incoming payload (useful while testing)
    console.log("PUT /service/:id - req.body:", req.body);
    console.log("PUT /service/:id - req.file present?:", !!req.file, req.file ? { originalname: req.file.originalname, keys: Object.keys(req.file) } : null);

    const service = await ServiceOffered.findById(id).exec();
    if (!service) {
      return res.status(404).json({ message: "Service not found." });
    }

    // Acceptable fields
    const { title, price: rawPrice, duration, description, imageData, businessId: incomingBusinessId } = req.body as any;

    // Prevent reassigning service to another business
    if (incomingBusinessId && String(incomingBusinessId) !== String(service.businessId)) {
      return res.status(403).json({ message: "Cannot change businessId of a service." });
    }

    // Update basic fields if provided
    if (title != null) service.title = String(title).trim();
    if (rawPrice != null) {
      const parsed = typeof rawPrice === "number" ? rawPrice : parseFloat(String(rawPrice).replace(/[,₱\s]/g, ""));
      if (Number.isNaN(parsed) || parsed < 0) {
        return res.status(400).json({ message: "Price must be a valid non-negative number." });
      }
      service.price = Math.round(parsed);
    }
    if (duration != null) service.duration = String(duration).trim();
    if (description != null) service.description = String(description).trim();

    const cloudFolder = `services/${service.businessId?.toString() || "unknown"}`;

    // -------- explicit delete: client requested deletion and did NOT upload a file ----------
    if (imageData === "__DELETE__" && !req.file) {
      const oldAny: any = (service as any).image;
      const oldPublicId = (oldAny && oldAny.public_id) || (service as any).imagePublicId;
      if (oldPublicId) {
        try {
          await cloudinary.uploader.destroy(oldPublicId, { resource_type: "image" });
          console.log("Cloudinary: deleted old image", oldPublicId);
        } catch (err) {
          console.warn("Failed to delete old Cloudinary image (explicit delete):", err);
        }
      }
      // clear all image-related fields your frontend might read
      (service as any).image = undefined;
      (service as any).imageUrl = undefined;
      (service as any).imagePath = undefined;
      (service as any).images = [];
      (service as any).imagePublicId = undefined;
    }

    // -------- image upload / imageData handling ----------
    let uploadResult: any = undefined;
    let tempDiskPath: string | undefined;

    try {
      if (req.file) {
        // Common multer memoryStorage shape: req.file.buffer
        if ((req.file as any).buffer && (req.file as any).buffer.length > 0) {
          console.log("PUT /service/:id - using req.file.buffer, size:", (req.file as any).buffer.length);
          const buffer = (req.file as any).buffer as Buffer;
          uploadResult = await uploadBufferToCloudinary(buffer, { folder: cloudFolder, resource_type: "image" });
        }
        // Disk storage: multer provides path
        else if ((req.file as any).path) {
          const filePath = (req.file as any).path as string;
          console.log("PUT /service/:id - using req.file.path:", filePath);
          tempDiskPath = filePath;
          const fileBuf = await fs.readFile(filePath);
          uploadResult = await uploadBufferToCloudinary(fileBuf, { folder: cloudFolder, resource_type: "image" });
        }
        // Some setups expose a stream
        else if ((req.file as any).stream) {
          console.log("PUT /service/:id - using req.file.stream");
          const stream = (req.file as any).stream as NodeJS.ReadableStream;
          // Prefer direct stream upload (memory efficient)
          try {
            uploadResult = await uploadStreamToCloudinary(stream, { folder: cloudFolder, resource_type: "image" });
          } catch (e) {
            // fallback: convert stream -> buffer and call uploadBufferToCloudinary
            console.warn("uploadStreamToCloudinary failed, falling back to buffer conversion:", e);
            const buf = await streamToBuffer(stream);
            uploadResult = await uploadBufferToCloudinary(buf, { folder: cloudFolder, resource_type: "image" });
          }
        } else {
          console.warn("PUT /service/:id - req.file present but no buffer/path/stream found; file keys:", Object.keys(req.file));
        }
      } else if (imageData && typeof imageData === "string" && imageData.trim().length > 0) {
        // If caller passed a remote URL or data URL in imageData (and didn't upload a file)
        if (imageData.startsWith("http://") || imageData.startsWith("https://")) {
          // do not reupload, just save the URL
          uploadResult = { secure_url: imageData, url: imageData, public_id: undefined };
        } else if (imageData.startsWith("data:")) {
          uploadResult = await uploadDataUrlToCloudinary(imageData, { folder: cloudFolder, resource_type: "image" });
        } else {
          console.warn("PUT /service/:id - unrecognized imageData (ignored):", imageData);
        }
      }
    } catch (err) {
      console.warn("Image upload (edit) failed:", err);
      // continue — do not abort the entire update just because upload failed
    } finally {
      // cleanup any temporary disk file if used
      if (tempDiskPath) {
        try {
          await fs.unlink(tempDiskPath);
        } catch (err) {
          console.warn("Failed to delete temporary local upload file:", tempDiskPath, err);
        }
      }
    }

    // -------- write uploadResult (if any) into DB fields your front-end expects ----------
    if (uploadResult) {
      console.log("Cloudinary upload result:", uploadResult);
      const imageUrl = uploadResult.secure_url || uploadResult.url || (typeof uploadResult === "string" ? uploadResult : null);
      const publicId = uploadResult.public_id || uploadResult.publicId || uploadResult.public || undefined;

      // If we are replacing an existing Cloudinary resource, try to delete the old one
      const oldAny: any = (service as any).image;
      const oldPublicId = (oldAny && oldAny.public_id) || (service as any).imagePublicId;
      if (oldPublicId && publicId && oldPublicId !== publicId) {
        try {
          await cloudinary.uploader.destroy(oldPublicId, { resource_type: "image" });
        } catch (err) {
          console.warn("Failed to delete previous cloudinary image:", oldPublicId, err);
        }
      }

      // Save into common fields (imagePath is crucial for your front-end)
      (service as any).image = publicId ? { url: imageUrl, public_id: publicId } : { url: imageUrl };
      (service as any).imageUrl = imageUrl;
      (service as any).imagePublicId = publicId;
      (service as any).images = [{ url: imageUrl, public_id: publicId }];
      (service as any).imagePath = imageUrl; // IMPORTANT: front-end expects the path here
    }

    await service.save();

    // Return canonical fresh document
    const fresh = await ServiceOffered.findById(id).lean().exec();
    return res.status(200).json({ message: "Service updated successfully.", service: fresh, image: uploadResult || null });
  } catch (err: any) {
    console.error("PUT /service/:id error:", err);
    if (err instanceof Error) return res.status(500).json({ message: "Server error.", error: err.message });
    return res.status(500).json({ message: "Unknown server error." });
  }
});


/**
 * DELETE /service/:id
 * - Deletes a ServiceOffered document and attempts to delete associated Cloudinary image (if public_id present)
 */
router.delete("/service/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id || !mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Valid service id is required." });
    }

    const service = await ServiceOffered.findById(id).exec();
    if (!service) {
      return res.status(404).json({ message: "Service not found." });
    }

    // If there's an associated image with public_id, try to delete it
    const img: any = (service as any).image;
    if (img && img.public_id) {
      try {
        await cloudinary.uploader.destroy(img.public_id, { resource_type: "image" });
      } catch (err) {
        console.warn("Failed to delete service image from cloudinary during service deletion:", err);
        // continue with deletion even if cloudinary deletion fails
      }
    }

    await service.deleteOne();

    return res.status(200).json({
      message: "Service deleted successfully.",
      serviceId: id,
    });
  } catch (error: any) {
    console.error("DELETE /service/:id error:", error);
    if (error instanceof Error) {
      return res.status(500).json({ message: "Server error.", error: error.message });
    }
    return res.status(500).json({ message: "Unknown server error." });
  }
});

router.post("/save-fcm-token", async (req: Request, res: Response) => {
  try {
    const { businessId, token } = req.body ?? {};

    if (!businessId || !token) {
      return res.status(400).json({ message: "businessId and token are required." });
    }
    if (!mongoose.isValidObjectId(businessId)) {
      return res.status(400).json({ message: "Invalid businessId format." });
    }

    const tok = String(token).trim();
    if (tok.length === 0) {
      return res.status(400).json({ message: "token must be a non-empty string." });
    }
    // optional sanity limit
    if (tok.length > 4096) {
      return res.status(400).json({ message: "token is too long." });
    }

    const business = await BusinessInfo.findById(businessId).exec();
    if (!business) {
      return res.status(404).json({ message: "Business not found." });
    }

    // $addToSet avoids duplicates
    const updated = await BusinessInfo.findByIdAndUpdate(
      businessId,
      { $addToSet: { fcmTokens: tok } },
      { new: true, upsert: false, useFindAndModify: false }
    )
      .lean()
      .exec();

    return res.status(200).json({
      message: "Token saved.",
      fcmTokens: (updated && (updated as any).fcmTokens) ? (updated as any).fcmTokens : [],
    });
  } catch (err) {
    console.error("POST /save-fcm-token error:", err);
    return res.status(500).json({ message: "Server error.", error: (err as Error).message });
  }
});

/**
 * POST /remove-fcm-token
 * Body: { businessId: string, token: string }
 * Removes the given FCM token from the business's fcmTokens array.
 */
router.post("/remove-fcm-token", async (req: Request, res: Response) => {
  try {
    const { businessId, token } = req.body ?? {};

    if (!businessId || !token) {
      return res.status(400).json({ message: "businessId and token are required." });
    }
    if (!mongoose.isValidObjectId(businessId)) {
      return res.status(400).json({ message: "Invalid businessId format." });
    }

    const tok = String(token).trim();
    if (tok.length === 0) {
      return res.status(400).json({ message: "token must be a non-empty string." });
    }

    const business = await BusinessInfo.findById(businessId).exec();
    if (!business) {
      return res.status(404).json({ message: "Business not found." });
    }

    const updated = await BusinessInfo.findByIdAndUpdate(
      businessId,
      { $pull: { fcmTokens: tok } },
      { new: true, useFindAndModify: false }
    )
      .lean()
      .exec();

    return res.status(200).json({
      message: "Token removed (if it existed).",
      fcmTokens: (updated && (updated as any).fcmTokens) ? (updated as any).fcmTokens : [],
    });
  } catch (err) {
    console.error("POST /remove-fcm-token error:", err);
    return res.status(500).json({ message: "Server error.", error: (err as Error).message });
  }
});

router.get("/bookings/today", async (req: Request, res: Response) => {
  try {
    const businessId = (req.header("x-business-id") || req.query.businessId) as
      | string
      | undefined;
    const tz = (req.query.tz as string) || "Asia/Manila";

    if (!businessId) {
      return res
        .status(400)
        .json({
          message:
            "Missing businessId (provide as header x-business-id or ?businessId=...)",
        });
    }

    if (!mongoose.isValidObjectId(businessId)) {
      return res.status(400).json({ message: "Invalid businessId." });
    }

    // Determine start/end of "today" in the requested timezone (for filtering)
    const nowInTz = DateTime.now().setZone(tz);
    if (!nowInTz.isValid) {
      return res
        .status(400)
        .json({
          message: `Invalid timezone '${tz}'. Use an IANA timezone like 'Asia/Manila'.`,
        });
    }

    const startOfDay = nowInTz.startOf("day").toJSDate();
    const endOfDay = nowInTz.plus({ days: 1 }).startOf("day").toJSDate();

    // Query bookings within [startOfDay, endOfDay)
    const bookings = await Booking.find({
      businessId: new mongoose.Types.ObjectId(businessId),
      scheduledAt: { $gte: startOfDay, $lt: endOfDay },
    })
      .sort({ scheduledAt: 1 })
      .lean()
      .exec();

    const bookingsWithFormatted = bookings.map((b) => {
  const rawDate = b.scheduledAt ? new Date(b.scheduledAt) : null;
  let dtInZone = null;

  if (rawDate) {
    // Interpret rawDate as UTC, then convert to requested timezone
    dtInZone = DateTime.fromJSDate(rawDate, { zone: 'utc' }).setZone(tz);
  }

  return {
    ...b,
  };
});


    return res.status(200).json({
      message: "Bookings for today",
      timezone: tz,
      date: nowInTz.toISODate(),
      count: bookingsWithFormatted.length,
      bookings: bookingsWithFormatted,
    });
  } catch (err) {
    console.error("GET /bookings/today error:", err);
    return res.status(500).json({
      message: "Server error",
      error: (err as Error).message,
    });
  }
});


router.get("/services/count", async (req: Request, res: Response) => {
  try {
    const businessId = (req.header("x-business-id") || req.query.businessId) as string | undefined;

    if (!businessId) {
      return res.status(400).json({ message: "Missing businessId (provide as header x-business-id or ?businessId=...)" });
    }

    if (!mongoose.isValidObjectId(businessId)) {
      return res.status(400).json({ message: "Invalid businessId." });
    }

    const filter = { businessId: new mongoose.Types.ObjectId(businessId) };

    // Use countDocuments for accurate counts (respects filters)
    const count = await ServiceOffered.countDocuments(filter).exec();

    return res.status(200).json({
      message: "Service count retrieved.",
      businessId,
      count,
    });
  } catch (err) {
    console.error("GET /services/count error:", err);
    return res.status(500).json({ message: "Server error", error: (err as Error).message });
  }
});

async function computeAndSendReviewStats(res: Response, businessId: string) {
  try {
    // use the static you added to the model if available
    const stats = await (Review as any).computeStats(businessId);

    const total = Number(stats.count ?? 0);
    const avgRaw = Number(stats.avgRating ?? 0);
    const avgRounded = total === 0 ? 0 : Number(avgRaw.toFixed(2));

    const breakdown = {
      "5": Number(stats.count5 ?? 0),
      "4": Number(stats.count4 ?? 0),
      "3": Number(stats.count3 ?? 0),
      "2": Number(stats.count2 ?? 0),
      "1": Number(stats.count1 ?? 0),
    };

    return res.json({
      businessId,
      avgRating: avgRounded,
      totalReviews: total,
      breakdown,
    });
  } catch (error) {
    console.error("Failed to compute review stats:", error);
    return res.status(500).json({ message: "Failed to compute review stats." });
  }
}

router.get("/reviews/:businessId/stats", async (req: Request, res: Response) => {
  const businessId = req.params.businessId;
  if (!businessId) return res.status(400).json({ message: "businessId param is required." });
  if (!mongoose.Types.ObjectId.isValid(businessId)) return res.status(400).json({ message: "Invalid businessId." });

  return computeAndSendReviewStats(res, businessId);
});

export default router;