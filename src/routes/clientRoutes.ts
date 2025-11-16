import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import User, { IClient } from "../models/client_accounts";
import Location from "../models/location";
import mongoose from "mongoose";
import jwt, { Secret, SignOptions } from "jsonwebtoken";
import Favorite from "../models/favorite";
import BusinessInfo from "../models/business_info";
import ServiceOffered from "../models/services_offered";
import Booking from "../models/booking";
import { DateTime } from "luxon";

const router = Router();

router.get("/", (req, res) => {
  res.status(200).send("✅ Move-E Backend is running!");
});

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
    const { email, password } = (req.body as { email?: string; password?: string }) ?? {};

    if (!email || !password) {
      return res.status(400).json({ message: "Email/Phone and password are required." });
    }

    const isEmail = typeof email === "string" && email.includes("@");

    // Tell TypeScript the document will match the IClient shape
    const user = (await User.findOne(isEmail ? { email } : { phone: email })) as
      | (mongoose.Document<any, any, IClient> & IClient & { _id: any })
      | null;

    if (!user) {
      return res.status(401).json({ message: "Invalid email/phone or password." });
    }

    // verify password (user.password should exist on IClient)
    const isPasswordValid = await bcrypt.compare(password, (user as any).password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid email/phone or password." });
    }

    // Safely convert _id to string
    let userId = "";
    try {
      if (user._id == null) {
        userId = "";
      } else if (typeof user._id === "string") {
        userId = user._id;
      } else if ((user._id as mongoose.Types.ObjectId).toString) {
        userId = (user._id as mongoose.Types.ObjectId).toString();
      } else {
        userId = String(user._id);
      }
    } catch (err) {
      userId = String((user as any)._id);
    }

    // Optionally sign a JWT if you want sockets/auth to use it
    const secret = process.env.JWT_SECRET;
    let token: string | undefined;
    if (secret) {
      const payload = { id: userId, email: user.email, role: "client" };
      token = jwt.sign(payload, secret, { expiresIn: "7d" });
    }

    // extract middleName and extensionName with fallbacks for common DB key variants
    const middleName =
      (user as any).middleName ??
      (user as any).middle_name ??
      (user as any).middlename ??
      (user as any).middleInitial ??
      (user as any).middle_initial ??
      "";

    const extensionName =
      (user as any).extensionName ??
      (user as any).extension ??
      (user as any).suffix ??
      (user as any).ext ??
      (user as any).nameExtension ??
      "";

    // Respond with user info + token (if available)
    return res.status(200).json({
      message: "Login successful",
      user: {
        id: userId,
        firstName: (user as any).firstName ?? "",
        middleName: middleName ?? "",
        lastName: (user as any).lastName ?? "",
        extensionName: extensionName ?? "",
        email: user.email ?? "",
        phone: (user as any).phone ?? "",
      },
      ...(token ? { token } : {}),
    });
  } catch (err) {
    console.error("POST /login error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});


// POST /api/client/save-location
router.post("/save-location", async (req: Request, res: Response) => {
  try {
    // Accept optional 'id' for updating a specific saved location
    const { id, clientId, address, latitude, longitude, displayName, floor, note, selectedLocation } = req.body as any;

    // Basic validation
    if (!clientId || !address || latitude == null || longitude == null) {
      return res.status(400).json({ message: "Missing required fields. Required: clientId, address, latitude, longitude." });
    }

    // Normalize lat/lon to numbers
    const latNum = typeof latitude === "number" ? latitude : parseFloat(String(latitude));
    const lonNum = typeof longitude === "number" ? longitude : parseFloat(String(longitude));
    if (Number.isNaN(latNum) || Number.isNaN(lonNum)) {
      return res.status(400).json({ message: "Invalid latitude or longitude." });
    }

    // Helper: convert clientId to ObjectId if appropriate
    let storedClientId: any = clientId;
    if (mongoose.isValidObjectId(clientId)) {
      storedClientId = new mongoose.Types.ObjectId(clientId);
    }

    // ---------- UPDATE existing location ----------
    if (id) {
      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({ message: "Invalid location id." });
      }

      const existing = await Location.findById(id).exec();
      if (!existing) {
        return res.status(404).json({ message: "Location not found." });
      }

      // Ensure the document belongs to the provided clientId
      const existingClientId = existing.clientId ? existing.clientId.toString() : existing.clientId;
      if (existingClientId && String(existingClientId) !== String(clientId)) {
        return res.status(403).json({ message: "You are not allowed to modify this location." });
      }

      existing.address = address;
      existing.latitude = latNum;
      existing.longitude = lonNum;
      if (typeof displayName !== "undefined") existing.displayName = displayName;
      if (typeof floor !== "undefined") existing.floor = floor;
      if (typeof note !== "undefined") existing.note = note;

      // If caller explicitly set selectedLocation true, unset others for this client
      if (selectedLocation === true || selectedLocation === 'true') {
        // mark all other locations for this client as false
        await Location.updateMany(
          { clientId: storedClientId, _id: { $ne: existing._id }, selectedLocation: true },
          { $set: { selectedLocation: false } }
        ).exec();

        existing.selectedLocation = true;
      } else if (typeof selectedLocation !== "undefined") {
        // explicit boolean false requested
        existing.selectedLocation = !!selectedLocation;
      }
      // If selectedLocation not provided, leave as-is.

      await existing.save();

      return res.status(200).json({
        message: "Location updated successfully.",
        location: existing.toObject(),
      });
    }

    // ---------- CREATE new location ----------
    // Before creating: mark any existing selected location(s) for this client as false
    await Location.updateMany(
      { clientId: storedClientId, selectedLocation: true },
      { $set: { selectedLocation: false } }
    ).exec();

    // Create new location and explicitly set selectedLocation to true by default
    const newLocation = new Location({
      clientId: storedClientId,
      address,
      latitude: latNum,
      longitude: lonNum,
      displayName,
      floor,
      note,
      selectedLocation: true,
    });

    await newLocation.save();

    return res.status(201).json({
      message: "Location saved successfully.",
      location: newLocation.toObject(),
    });
  } catch (error: any) {
    console.error("POST /save-location error:", error);
    return res.status(500).json({ message: "Server error.", error: error?.message ?? String(error) });
  }
});

router.patch("/:id/select", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { clientId: bodyClientId } = req.body as { clientId?: string };

    if (!id) return res.status(400).json({ success: false, message: "Location id is required in URL." });

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid location id." });
    }

    // prefer auth when possible:
    // const authClientId = (req as any).user?.id;
    const clientId = bodyClientId;
    if (!clientId) {
      return res.status(400).json({ success: false, message: "clientId is required in body (or use auth)." });
    }
    if (!mongoose.Types.ObjectId.isValid(clientId)) {
      return res.status(400).json({ success: false, message: "Invalid clientId." });
    }

    const storedClientId = new mongoose.Types.ObjectId(clientId);

    // Verify ownership
    const target = await Location.findById(id).exec();
    if (!target) return res.status(404).json({ success: false, message: "Location not found." });
    if (String(target.clientId) !== String(clientId)) {
      return res.status(403).json({ success: false, message: "You are not allowed to select this location." });
    }

    // use transaction where available
    const session = await mongoose.startSession();
    let updatedLocation: any = null;
    try {
      await session.withTransaction(async () => {
        await Location.updateMany(
          { clientId: storedClientId, _id: { $ne: target._id }, selectedLocation: true },
          { $set: { selectedLocation: false } },
          { session }
        ).exec();

        await Location.updateOne({ _id: target._id }, { $set: { selectedLocation: true } }, { session }).exec();

        updatedLocation = await Location.findById(target._id).session(session).lean().exec();
      });
    } finally {
      session.endSession();
    }

    // fallback if transaction didn't run
    if (!updatedLocation) {
      await Location.updateMany({ clientId: storedClientId, selectedLocation: true }, { $set: { selectedLocation: false } }).exec();
      await Location.updateOne({ _id: target._id }, { $set: { selectedLocation: true } }).exec();
      updatedLocation = await Location.findById(target._id).lean().exec();
    }

    return res.status(200).json({ success: true, location: updatedLocation });
  } catch (err: any) {
    console.error("PATCH /locations/:id/select error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err?.message ?? String(err) });
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

router.get("/bookings/today", async (req: Request, res: Response) => {
  try {
    // Accept clientId from header, query or body
    const clientIdRaw = (req.header("x-client-id") || req.query.clientId || (req.body && req.body.clientId)) as string | undefined;
    const tz = (req.query.tz as string) || "Asia/Manila";
    const formatMode = (req.query.format as string) || ""; // if "stored" -> format stored instant

    if (!clientIdRaw) {
      return res.status(400).json({ message: "Missing clientId (provide as header x-client-id, ?clientId=..., or JSON body {clientId})" });
    }

    if (!mongoose.isValidObjectId(clientIdRaw)) {
      return res.status(400).json({ message: "Invalid clientId (not a valid ObjectId)." });
    }

    // Determine start/end of "today" in requested timezone using luxon
    const nowInTz = DateTime.now().setZone(tz);
    if (!nowInTz.isValid) {
      return res.status(400).json({ message: `Invalid timezone '${tz}'. Use an IANA timezone like 'Asia/Manila'.` });
    }

    const startOfDay = nowInTz.startOf("day").toJSDate(); // inclusive
    const endOfDay = nowInTz.plus({ days: 1 }).startOf("day").toJSDate(); // exclusive

    // Query bookings where scheduledAt is within [startOfDay, endOfDay)
    const bookings = await Booking.find({
      clientId: new mongoose.Types.ObjectId(clientIdRaw),
      scheduledAt: { $gte: startOfDay, $lt: endOfDay },
    })
      .sort({ scheduledAt: 1 })
      .lean()
      .exec();

    // Map bookings and add formatted time
    const bookingsWithFormatted = bookings.map((b) => {
      // b.scheduledAt is a Date (JS Date / UTC instant)
      const jsDate = new Date(b.scheduledAt);

      // If caller requested to see the stored instant as-is (no tz conversion), format in UTC
      if (formatMode === "stored") {
        const dt = DateTime.fromJSDate(jsDate).toUTC();
        const formatted =
          dt.toLocaleString({ month: "long", day: "numeric", year: "numeric" }) +
          " at " +
          dt.toLocaleString({ hour: "numeric", minute: "2-digit", hour12: true });
        return { ...b, scheduledAtFormatted: formatted };
      }

      // Default: format in the requested timezone (use tz for readability and consistency with "today" filter)
      const dtTz = DateTime.fromJSDate(jsDate).setZone(tz);
      const formattedTz =
        dtTz.toLocaleString({ month: "long", day: "numeric", year: "numeric" }) +
        " at " +
        dtTz.toLocaleString({ hour: "numeric", minute: "2-digit", hour12: true });
      return { ...b, scheduledAtFormatted: formattedTz };
    });

    return res.status(200).json({
      message: "Client bookings for today",
      timezoneRequested: tz,
      format: formatMode || "tz",
      date: nowInTz.toISODate(), // e.g. "2025-10-21"
      count: bookingsWithFormatted.length,
      bookings: bookingsWithFormatted,
    });
  } catch (err) {
    console.error("GET /client/bookings/today error:", err);
    return res.status(500).json({ message: "Server error", error: (err as Error).message });
  }
});


export default router;
