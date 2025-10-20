import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import User from "../models/client_accounts";
import Location from "../models/location";
import mongoose from "mongoose";
import jwt, { Secret, SignOptions } from "jsonwebtoken";
import Favorite from "../models/favorite";
import BusinessInfo from "../models/business_info";
import ServiceOffered from "../models/services_offered";
import Booking from "../models/booking";

const router = Router();

router.post("/signup", async (req: Request, res: Response) => {
  try {
    const {
      lastName,
      firstName,
      middleName,
      extensionName,
      phone,
      email,
      password,
    } = req.body;

    if (!lastName || !firstName || !password || (!phone && !email)) {
      return res
        .status(400)
        .json({ message: "Please provide all required fields and either phone or email." });
    }

    const existingUser = await User.findOne({
      $or: [{ email }, { phone }],
    });

    if (existingUser) {
      return res
        .status(400)
        .json({ message: "An account with this email or phone number already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      lastName,
      firstName,
      middleName,
      extensionName,
      phone,
      email,
      password: hashedPassword,
    });

    await newUser.save();
    res.status(201).json({ message: "User registered successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email/Phone and password are required." });
    }

    // Determine if it's an email or phone number
    const isEmail = email.includes("@");

    // Search user by email OR phone
    const user = await User.findOne(isEmail ? { email } : { phone: email });

    if (!user) {
      return res.status(401).json({ message: "Invalid email/phone or password." });
    }

    // Compare password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid email/phone or password." });
    }

    // Return basic user info
    res.status(200).json({
      message: "Login successful",
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/save-location", async (req: Request, res: Response) => {
  try {
    const { clientId, address, latitude, longitude, displayName, floor, note } = req.body;

    if (!clientId || !address || latitude == null || longitude == null) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    const existingLocation = await Location.findOne({ clientId });

    if (existingLocation) {
      existingLocation.address = address;
      existingLocation.latitude = latitude;
      existingLocation.longitude = longitude;
      existingLocation.displayName = displayName;
      existingLocation.floor = floor;
      existingLocation.note = note;
      await existingLocation.save();
      return res.status(200).json({ message: "Location updated successfully." });
    }

    // Otherwise, create a new record
    const newLocation = new Location({
      clientId,
      address,
      latitude,
      longitude,
      displayName,
      floor,
      note,
    });

    await newLocation.save();
    res.status(201).json({ message: "Location saved successfully." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

// routes/client.ts (Express)
router.get("/get-location", async (req: Request, res: Response) => {
  try {
    const clientId = req.query.clientId as string;
    if (!clientId) return res.status(400).json({ message: "clientId is required" });

    // Find all locations for this client (you might have timestamps)
    const locations = await Location.find({ clientId }).sort({ updatedAt: -1 }).lean();

    // Example: return [] if none
    return res.status(200).json({ locations });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/login-by-clientId", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.body ?? {};

    if (!clientId || typeof clientId !== "string" || clientId.trim() === "") {
      return res.status(400).json({ message: "clientId is required in body." });
    }

    if (!mongoose.isValidObjectId(clientId)) {
      return res.status(400).json({ message: "Invalid clientId format." });
    }

    // Find client and exclude password
    const client = await User.findById(clientId).select("-password").lean().exec();
    if (!client) {
      return res.status(404).json({ message: "Client not found." });
    }

    // Build a small payload (no sensitive data)
    const payload = {
      id: (client as any)._id?.toString?.() ?? client._id ?? client.id,
      email: (client as any).email ?? undefined,
      phone: (client as any).phone ?? undefined,
      firstName: (client as any).firstName ?? undefined,
      lastName: (client as any).lastName ?? undefined,
    };

    const responseBody: any = { message: "Login successful.", client };

    // Sign JWT if secret configured
    const secretVar = process.env.JWT_SECRET;
    if (secretVar && typeof secretVar === "string" && secretVar.length > 8) {
      const secret: Secret = secretVar;

      // Ensure expiresIn is the correct type: number | ms.StringValue | undefined
      // Accept environment values like "7d", "24h", or numeric strings "3600"
      const rawExpiry = process.env.JWT_EXPIRY ?? "7d";

      // Convert numeric strings to number, otherwise keep as string (ms.StringValue)
      let expiresIn: SignOptions["expiresIn"];
      const numeric = Number(rawExpiry);
      if (!Number.isNaN(numeric) && String(numeric) === String(rawExpiry)) {
        // exact numeric string -> use number of seconds
        expiresIn = numeric;
      } else {
        // leave as string (e.g. "7d", "24h")
        expiresIn = rawExpiry as unknown as SignOptions["expiresIn"];
      }

      const signOptions: SignOptions = {
        expiresIn,
      };

      // jwt.sign overload is satisfied now
      const token = jwt.sign(payload, secret, signOptions);
      responseBody.token = token;

      // Optionally set cookie - commented out for now
      /*
      res.cookie("auth_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: typeof expiresIn === "number" ? expiresIn * 1000 : 1000 * 60 * 60 * 24 * 7,
      });
      */
    } else {
      console.warn("JWT_SECRET not configured or too short — no token will be issued.");
    }

    return res.status(200).json(responseBody);
  } catch (err) {
    console.error("POST /login-by-clientId error:", err);
    if (err instanceof Error) {
      return res.status(500).json({ message: "Server error.", error: err.message });
    }
    return res.status(500).json({ message: "Unknown server error." });
  }
});

// GET /favorites?clientId=xxxx
router.get("/favorites", async (req: Request, res: Response) => {
  try {
    const clientId = (req.query.clientId ?? "") as string;
    if (!clientId) return res.status(400).json({ message: "clientId query param is required" });
    if (!mongoose.isValidObjectId(clientId)) return res.status(400).json({ message: "Invalid clientId format" });

    // Find favorites for this client and populate the business info
    const favs = await Favorite.find({ clientId: new mongoose.Types.ObjectId(clientId) })
      .sort({ createdAt: -1 })
      .populate({
        path: "businessId",
        model: "BusinessInfo",
        select:
          "_id businessName logo location accountStatus category contactNumber email operatingSchedule createdAt updatedAt",
      })
      .lean()
      .exec();

    // Normalize output: convert each favorite doc to a business object if populated
    const favoritesOut = favs.map((f: any) => {
      const business = f.businessId ?? null;
      if (business) {
        // Normalize location (may be subdoc or undefined)
        const loc = business.location
          ? {
              address: business.location.address ?? null,
              latitude: business.location.latitude ?? null,
              longitude: business.location.longitude ?? null,
              displayName: business.location.displayName ?? null,
              floor: business.location.floor ?? null,
              note: business.location.note ?? null,
            }
          : null;

        return {
          favoriteId: f._id,
          businessId: business._id,
          businessName: business.businessName,
          logo: business.logo ?? null,
          location: loc,
          accountStatus: business.accountStatus ?? null,
          category: business.category ?? null,
          contactNumber: business.contactNumber ?? null,
          email: business.email ?? null,
          operatingSchedule: business.operatingSchedule ?? null,
          createdAt: business.createdAt ?? null,
          updatedAt: business.updatedAt ?? null,
          raw: business, // full populated business as fallback
        };
      }
      // fallback: if no populated business, return the favorite doc minimal shape
      return {
        favoriteId: f._id,
        businessId: f.businessId,
      };
    });

    return res.status(200).json({ favorites: favoritesOut });
  } catch (err: any) {
    console.error("GET /favorites error:", err);
    return res.status(500).json({ message: "Server error.", error: err.message });
  }
});

// POST /add-favorite  (toggle behavior)
router.post("/add-favorite", async (req: Request, res: Response) => {
  try {
    const { clientId, businessId } = req.body ?? {};

    // Validate input
    if (!clientId || typeof clientId !== "string") {
      return res.status(400).json({ message: "clientId is required in body." });
    }
    if (!businessId || typeof businessId !== "string") {
      return res.status(400).json({ message: "businessId is required in body." });
    }
    if (!mongoose.isValidObjectId(clientId)) {
      return res.status(400).json({ message: "Invalid clientId format." });
    }
    if (!mongoose.isValidObjectId(businessId)) {
      return res.status(400).json({ message: "Invalid businessId format." });
    }

    // Ensure referenced business exists and get required fields
    const business = await BusinessInfo.findById(businessId)
      .select("_id businessName logo location accountStatus category contactNumber email operatingSchedule createdAt updatedAt")
      .lean()
      .exec();

    if (!business) {
      return res.status(404).json({ message: "Business not found." });
    }

    const clientObjId = new mongoose.Types.ObjectId(clientId);
    const businessObjId = new mongoose.Types.ObjectId(businessId);

    // Check if favorite already exists
    const existing = await Favorite.findOne({ clientId: clientObjId, businessId: businessObjId }).exec();

    if (existing) {
      // Remove the favorite (unfavorite)
      const del = await Favorite.deleteOne({ _id: existing._id }).exec();
      if (del.deletedCount && del.deletedCount > 0) {
        return res.status(200).json({
          success: true,
          action: "removed",
          isFavorite: false,
          removed: true,
          businessId,
          clientId,
        });
      }
      return res.status(500).json({ success: false, message: "Failed to remove favorite." });
    }

    // Otherwise, create a new favorite
    try {
      const fav = new Favorite({ clientId: clientObjId, businessId: businessObjId });
      await fav.save();

      // Normalize location
      const loc = business.location
        ? {
            address: business.location.address ?? null,
            latitude: business.location.latitude ?? null,
            longitude: business.location.longitude ?? null,
            displayName: business.location.displayName ?? null,
            floor: business.location.floor ?? null,
            note: business.location.note ?? null,
          }
        : null;

      return res.status(201).json({
        success: true,
        action: "added",
        isFavorite: true,
        created: true,
        favorite: {
          id: fav._id,
          businessId: business._id,
          businessName: business.businessName,
          logo: business.logo ?? null,
          location: loc,
          accountStatus: business.accountStatus ?? null,
          category: business.category ?? null,
          contactNumber: business.contactNumber ?? null,
          email: business.email ?? null,
          operatingSchedule: business.operatingSchedule ?? null,
          createdAt: business.createdAt ?? null,
          updatedAt: business.updatedAt ?? null,
        },
      });
    } catch (err: any) {
      // Duplicate-key race (someone inserted before us) -> treat as already added
      if (err && err.code === 11000) {
        return res.status(200).json({
          success: true,
          action: "already_added",
          isFavorite: true,
          created: false,
        });
      }
      console.error("Error saving favorite:", err);
      return res.status(500).json({ message: "Could not add favorite." });
    }
  } catch (err: any) {
    console.error("/add-favorite error:", err);
    return res.status(500).json({ message: "Server error.", error: err.message });
  }
});

// GET /api/client/bookings?clientId=<id>&page=1&limit=20&status=confirmed
router.get("/get-bookings", async (req: Request, res: Response) => {
  try {
    const clientId = (req.query.clientId ?? req.body?.clientId) as string | undefined;
    const page = Math.max(1, Number(req.query.page ?? req.body?.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? req.body?.limit ?? 20)));
    const statusFilter = (req.query.status ?? req.body?.status) as string | undefined;

    if (!clientId || typeof clientId !== "string" || clientId.trim() === "") {
      return res.status(400).json({ message: "clientId is required (query or body)." });
    }
    if (!mongoose.isValidObjectId(clientId)) {
      return res.status(400).json({ message: "Invalid clientId format." });
    }

    // Build query
    const query: any = { clientId: new mongoose.Types.ObjectId(clientId) };
    if (statusFilter && typeof statusFilter === "string") {
      // Validate known statuses (optional)
      const allowed = ["pending", "confirmed", "cancelled", "completed", "rejected"];
      if (allowed.includes(statusFilter)) {
        query.status = statusFilter;
      } else {
        return res.status(400).json({ message: `Invalid status. Allowed: ${allowed.join(", ")}` });
      }
    }

    const skip = (page - 1) * limit;

    // Query bookings and populate referenced docs
    // populate businessId with a few helpful fields, and serviceId likewise
    const bookings = await Booking.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: "businessId",
        model: "BusinessInfo",
        select: "businessName logo location category accountStatus contactNumber email", // adjust as needed
      })
      .populate({
        path: "serviceId",
        model: "ServiceOffered",
        select: "title price duration", // adjust to your ServiceOffered fields
      })
      .lean()
      .exec();

    // Optionally, count total for pagination
    const total = await Booking.countDocuments(query).exec();

    return res.status(200).json({
      success: true,
      total,
      page,
      limit,
      bookings,
    });
  } catch (err: any) {
    console.error("GET /bookings error:", err);
    return res.status(500).json({ message: "Server error.", error: err?.message ?? String(err) });
  }
});


export default router;
