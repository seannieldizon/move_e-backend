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
    { name: "validId", maxCount: 1 },
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
        validId: validIdFromBody,
        location,
        operatingSchedule,
        category, // ✅ Added category
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

      // ✅ Handle category validation
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

      // Helper for Cloudinary upload
      async function processUploadField(
        fieldName: "logo" | "businessPermit" | "validId",
        fileArray?: Express.Multer.File[],
        dataUrl?: string
      ): Promise<{ url?: string; public_id?: string } | undefined> {
        try {
          if (fileArray && fileArray.length > 0) {
            const file = fileArray[0];
            const result = await uploadBufferToCloudinary(file.buffer, {
              folder: cloudFolder,
              resource_type: "image",
            });
            return { url: result.secure_url, public_id: result.public_id };
          } else if (
            dataUrl &&
            typeof dataUrl === "string" &&
            dataUrl.trim().length > 0
          ) {
            if (
              dataUrl.startsWith("http://") ||
              dataUrl.startsWith("https://")
            ) {
              return { url: dataUrl };
            }
            const result = await uploadDataUrlToCloudinary(dataUrl, {
              folder: cloudFolder,
              resource_type: "image",
            });
            return { url: result.secure_url, public_id: result.public_id };
          }
        } catch (err) {
          throw new Error(
            `Failed to upload ${fieldName}: ${(err as any).message || err}`
          );
        }
      }

      // Upload files (if any)
      const [logoResult, permitResult, validIdResult] = await Promise.all([
        processUploadField("logo", files?.logo, logoFromBody),
        processUploadField(
          "businessPermit",
          files?.businessPermit,
          businessPermitFromBody
        ),
        processUploadField("validId", files?.validId, validIdFromBody),
      ]);

      if (logoResult?.url) doc.logo = logoResult.url;
      if (permitResult?.url) doc.businessPermit = permitResult.url;
      if (validIdResult?.url) doc.validId = validIdResult.url;

      // ✅ Location
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

      // ✅ Schedule
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

    // Query DB
    const [total, businesses] = await Promise.all([
      BusinessInfo.countDocuments(filter).exec(),
      BusinessInfo.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
    ]);

    return res.status(200).json({
      total,
      page,
      perPage: limit,
      businesses,
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

    const filter = { businessId: new mongoose.Types.ObjectId(businessId) };

    const services = await ServiceOffered.find(filter).sort({ createdAt: -1 }).lean().exec();
    const total = await ServiceOffered.countDocuments(filter).exec();

    return res.status(200).json({ services, total });
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

      // Save service first (without image). If you prefer to upload image first and then persist URL,
      // you can reorder upload/persist. For simplicity we save service, then upload if provided.
      const service = new ServiceOffered(serviceDoc);
      await service.save();

      // If an image file (multipart) or data URL is provided, upload to Cloudinary
      let imageResult: { url?: string; public_id?: string } | undefined;
      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

      // Helper cloud folder per business
      const cloudFolder = `services/${businessId}`;

      try {
        // 1) multipart file
        if (req.file && req.file.buffer && req.file.mimetype && req.file.size > 0) {
          const uploadRes = await uploadBufferToCloudinary(req.file.buffer, {
            folder: cloudFolder,
            resource_type: "image",
            // optionally add transformation or format
          });
          imageResult = { url: uploadRes.secure_url, public_id: uploadRes.public_id };
        } else if (files && files.image && files.image.length > 0) {
          const file = files.image[0];
          const uploadRes = await uploadBufferToCloudinary(file.buffer, {
            folder: cloudFolder,
            resource_type: "image",
          });
          imageResult = { url: uploadRes.secure_url, public_id: uploadRes.public_id };
        } else if (imageData && typeof imageData === "string" && imageData.trim().length > 0) {
          // 2) in-body imageData: either remote URL or data URL
          if (imageData.startsWith("http://") || imageData.startsWith("https://")) {
            // remote url — we don't reupload; use as-is
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
        // we do not fail the whole operation for image upload failure; return service with warning
      }

      // OPTIONAL: persist the image URL into the service document if your schema supports it.
      // If your ServiceOffered schema has a field like: image: { url: String, public_id: String }
      // then uncomment the lines below to save the image into the document:
      /*
      if (imageResult?.url) {
        service.set('image', { url: imageResult.url, public_id: imageResult.public_id });
        await service.save();
      }
      */

      // Response: return created service and image info if any
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

    const service = await ServiceOffered.findById(id).exec();
    if (!service) {
      return res.status(404).json({ message: "Service not found." });
    }

    // Optional fields to update
    const { title, price: rawPrice, duration, description, imageData, businessId: incomingBusinessId } = req.body as any;

    // If client attempts to change businessId, ensure it matches existing service (prevent reassign)
    if (incomingBusinessId && String(incomingBusinessId) !== String(service.businessId)) {
      return res.status(403).json({ message: "Cannot change businessId of a service." });
    }

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

    // Image handling: upload new image if provided; if success delete old Cloudinary resource (if any)
    let newImageResult: { url?: string; public_id?: string } | undefined;

    const cloudFolder = `services/${service.businessId?.toString() || "unknown"}`;

    try {
      if (req.file && req.file.buffer && req.file.size > 0) {
        // upload multipart image
        const uploaded = await uploadBufferToCloudinary(req.file.buffer, { folder: cloudFolder, resource_type: "image" });
        newImageResult = { url: uploaded.secure_url, public_id: uploaded.public_id };
      } else if (imageData && typeof imageData === "string" && imageData.trim().length > 0) {
        if (imageData.startsWith("http://") || imageData.startsWith("https://")) {
          // remote url - do not reupload; store as url
          newImageResult = { url: imageData };
        } else {
          // data URL (base64) - upload
          const uploaded = await uploadDataUrlToCloudinary(imageData, { folder: cloudFolder, resource_type: "image" });
          newImageResult = { url: uploaded.secure_url, public_id: uploaded.public_id };
        }
      }
    } catch (err) {
      console.warn("Image upload (edit) failed:", err);
      // don't fail update just because image upload failed; send warning in response
    }

    // If we have new image and the service had old image with public_id, delete old resource from Cloudinary
    if (newImageResult && newImageResult.url) {
      const oldImage: any = (service as any).image;
      if (oldImage && oldImage.public_id) {
        try {
          await cloudinary.uploader.destroy(oldImage.public_id, { resource_type: "image" });
        } catch (err) {
          // log but continue
          console.warn("Failed to delete old cloudinary image:", err);
        }
      }

      // save new image info into document
      (service as any).image = { url: newImageResult.url, public_id: newImageResult.public_id };
    }

    await service.save();

    return res.status(200).json({
      message: "Service updated successfully.",
      service,
      image: newImageResult,
    });
  } catch (error: any) {
    console.error("PUT /service/:id error:", error);
    if (error instanceof Error) {
      return res.status(500).json({ message: "Server error.", error: error.message });
    }
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
    const businessId = (req.header("x-business-id") || req.query.businessId) as string | undefined;
    const tz = (req.query.tz as string) || "Asia/Manila";

    if (!businessId) {
      return res.status(400).json({ message: "Missing businessId (provide as header x-business-id or ?businessId=...)" });
    }

    if (!mongoose.isValidObjectId(businessId)) {
      return res.status(400).json({ message: "Invalid businessId." });
    }

    // Determine start/end of "today" in the requested timezone (for filtering)
    const nowInTz = DateTime.now().setZone(tz);
    if (!nowInTz.isValid) {
      return res.status(400).json({ message: `Invalid timezone '${tz}'. Use an IANA timezone like 'Asia/Manila'.` });
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

    // 🧭 Format scheduledAt as stored (no timezone conversion)
    const bookingsWithFormatted = bookings.map((b) => {
      // interpret the raw date as-is, in UTC (no .setZone)
      const dt = DateTime.fromJSDate(new Date(b.scheduledAt)).toUTC();
      const formatted =
        dt.toLocaleString({
          month: "long",
          day: "numeric",
          year: "numeric",
        }) +
        " at " +
        dt.toLocaleString({
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }) +
        " UTC";

      return {
        ...b,
        scheduledAtFormatted: formatted,
      };
    });

    return res.status(200).json({
      message: "Bookings for today",
      timezone: "UTC", // clarify that formatting is in UTC
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

export default router;