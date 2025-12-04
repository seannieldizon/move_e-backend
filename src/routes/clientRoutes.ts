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
import nodemailer from "nodemailer";
import Review from "../models/review";

const router = Router();

const mailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS, // app password or OAuth2 token
  },
});

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

// Add these two routes to routes/client.ts (or the file you showed).
// They expect this router to be mounted at /api/client (so full path will be /api/client/forgot-password and /api/client/reset-password)

router.post("/forgot-password", async (req: Request, res: Response) => {
  try {
    const { email, phone, identifier } = req.body ?? {};
    const id = (identifier ?? email ?? phone ?? "").toString().trim();

    if (!id) {
      return res.status(400).json({ message: "Please provide email or phone (identifier)." });
    }

    // Find user by email OR phone
    const isEmail = typeof id === "string" && id.includes("@");
    const user = await User.findOne(isEmail ? { email: id } : { phone: id }).exec();

    if (!user) {
      // Generic response to avoid account enumeration
      return res.status(200).json({ message: "A verification code was sent." });
    }

    // Generate a 6-digit numeric code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Hash the code before storing for safety
    const hashed = await bcrypt.hash(code, 10);

    // Save hashed code and expiry (e.g. 15 minutes)
    (user as any).resetCode = hashed;
    (user as any).resetCodeExpires = Date.now() + 15 * 60 * 1000; // 15 minutes
    (user as any).resetRequestedAt = Date.now();

    await user.save();

    // Compose the email
    const recipientEmail = (user as any).email ?? id; // fallback to provided id if user.email missing
    const mailOptions = {
      from: `"Move-E Support" <${process.env.GMAIL_USER}>`,
      to: recipientEmail,
      subject: "Your Move-E password reset code",
      text:
        `You requested to reset your Move-E password.\n\n` +
        `Use the following verification code to reset your password:\n\n` +
        `    ${code}\n\n` +
        `This code will expire in 15 minutes.\n\n` +
        `If you did not request this, please ignore this message.\n\n` +
        `— Move-E Team`,
      html:
        `<p>You requested to reset your Move-E password.</p>` +
        `<p><strong>Use the following verification code to reset your password:</strong></p>` +
        `<h2 style="letter-spacing:4px;">${code}</h2>` +
        `<p>This code will expire in 15 minutes.</p>` +
        `<p>If you did not request this, please ignore this message.</p>` +
        `<hr/><p style="font-size:12px;color:#666">Move-E</p>`,
    };

    // Send the email (don't reveal success/failure to caller beyond generic message)
    try {
      const info = await mailTransporter.sendMail(mailOptions);
      // Helpful debug log for server-side only (do not expose to clients)
      console.log(`[forgot-password] Sent reset email to ${recipientEmail} for user=${user._id}. nodemailerMessageId=${info.messageId}`);
    } catch (mailErr) {
      // Log error but do NOT expose to clients (still respond generically)
      console.error(`[forgot-password] Failed to send email to ${recipientEmail}:`, mailErr);
      // Optionally: you can still allow resetCode to exist even if email sending fails,
      // or you can rollback by unsetting reset fields. Here we keep the code and still return generic 200.
    }

    // Return generic success to the client
    return res.status(200).json({ message: "If an account exists, a verification code was sent." });
  } catch (err: any) {
    console.error("POST /forgot-password error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message ?? String(err) });
  }
});

router.post("/reset-password", async (req: Request, res: Response) => {
  try {
    // Expect: identifier (email/phone), code, password, password_confirmation (or confirm)
    const { identifier, email, phone, code, password, password_confirmation } = req.body ?? {};

    const id = (identifier ?? email ?? phone ?? "").toString().trim();
    if (!id) return res.status(400).json({ message: "Identifier (email or phone) is required." });
    if (!code) return res.status(400).json({ message: "Verification code is required." });
    if (!password) return res.status(400).json({ message: "Password is required." });
    if (password_confirmation && password !== password_confirmation) {
      return res.status(400).json({ message: "Password and confirmation do not match." });
    }

    const isEmail = typeof id === "string" && id.includes("@");
    const user = await User.findOne(isEmail ? { email: id } : { phone: id }).exec();

    if (!user) return res.status(404).json({ message: "Account not found." });

    const storedHash = (user as any).resetCode;
    const expires = (user as any).resetCodeExpires;

    if (!storedHash || !expires) {
      return res.status(400).json({ message: "No reset request found for this account. Please request a code first." });
    }

    if (Date.now() > Number(expires)) {
      // Clear expired code fields
      (user as any).resetCode = undefined;
      (user as any).resetCodeExpires = undefined;
      await user.save();
      return res.status(400).json({ message: "Verification code has expired. Please request a new code." });
    }

    // Compare provided code with stored hashed code
    const ok = await bcrypt.compare(String(code), storedHash);
    if (!ok) {
      return res.status(400).json({ message: "Invalid verification code." });
    }

    // All good — hash new password and save
    const newHashed = await bcrypt.hash(String(password), 10);
    (user as any).password = newHashed;

    // Clear reset fields
    (user as any).resetCode = undefined;
    (user as any).resetCodeExpires = undefined;

    await user.save();

    return res.status(200).json({ message: "Password has been reset successfully." });
  } catch (err: any) {
    console.error("POST /reset-password error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message ?? String(err) });
  }
});

router.post("/add-reviews", async (req: Request, res: Response) => {
  try {
    const { businessId, rating, text, photoUrls, clientId, authorName } = req.body ?? {};

    if (!businessId || typeof businessId !== "string") {
      return res.status(400).json({ message: "businessId is required in body." });
    }
    if (!mongoose.isValidObjectId(businessId)) {
      return res.status(400).json({ message: "Invalid businessId format." });
    }

    const r = Number(rating);
    if (rating == null || Number.isNaN(r) || !Number.isInteger(r) || r < 1 || r > 5) {
      return res.status(400).json({ message: "rating is required and must be an integer between 1 and 5." });
    }

    // Validate optional clientId if provided
    let clientObjId: mongoose.Types.ObjectId | undefined;
    if (clientId) {
      if (!mongoose.isValidObjectId(clientId)) {
        return res.status(400).json({ message: "Invalid clientId format." });
      }
      clientObjId = new mongoose.Types.ObjectId(clientId);
    }

    // Verify business exists
    const business = await BusinessInfo.findById(businessId).exec();
    if (!business) {
      return res.status(404).json({ message: "Business not found." });
    }

    // Build review doc
    const reviewDoc: any = {
      businessId: new mongoose.Types.ObjectId(businessId),
      rating: r,
    };
    if (typeof text === "string" && text.trim().length > 0) reviewDoc.text = text.trim();

    // photoUrls: accept array (filter non-empty strings)
    if (Array.isArray(photoUrls)) {
      reviewDoc.photoUrls = photoUrls
        .map((p: any) => (typeof p === "string" ? p.trim() : String(p ?? "")))
        .filter((s: string) => s.length > 0);
    }

    if (clientObjId) reviewDoc.clientId = clientObjId;
    if (authorName && typeof authorName === "string" && authorName.trim().length > 0) {
      reviewDoc.authorName = authorName.trim();
    }

    // If clientId is provided and no authorName, attempt to read client's name
    if (clientObjId && !reviewDoc.authorName) {
      try {
        const client = await User.findById(clientObjId)
          .select("firstName middleName lastName")
          .lean()
          .exec();

        if (client) {
          // Build parts array and remove falsy / empty entries, trim each part
          const parts = [client.firstName, client.middleName, client.lastName]
            .filter((p) => typeof p === "string" && p.trim().length > 0)
            .map((p) => (p as string).trim());

          if (parts.length > 0) {
            reviewDoc.authorName = parts.join(" ");
          }
        }
      } catch (e) {
        // ignore failure to read client name (non-fatal)
        console.warn("Could not load client name for review author:", e);
      }
    }

    // Save review
    const created = new Review(reviewDoc);
    await created.save();

    // Recompute aggregated stats and update BusinessInfo (average rating)
    try {
      // computeStats should be a static method on Review model that returns { avgRating, count }
      const stats: any = await (Review as any).computeStats(created.businessId);
      const avg = stats?.avgRating ?? null;
      const count = stats?.count ?? null;

      const update: any = {};
      if (avg != null) update.rating = Number(Number(avg).toFixed(2));
      if (count != null) update.reviewCount = count;

      if (Object.keys(update).length > 0) {
        await BusinessInfo.updateOne({ _id: created.businessId }, { $set: update }).exec();
      }
    } catch (aggErr) {
      // log and continue — aggregation failure shouldn't block the review creation
      console.warn("Failed to update business aggregates after new review:", aggErr);
    }

    // Return the created review (lean)
    const out = await Review.findById(created._id).lean().exec();
    return res.status(201).json({ success: true, review: out });
  } catch (err: any) {
    console.error("POST /reviews error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message ?? String(err) });
  }
});

router.get("/reviews", async (req: Request, res: Response) => {
  try {
    const { businessId, rating, page, limit, sort } = req.query ?? {};

    if (!businessId || typeof businessId !== "string") {
      return res.status(400).json({ message: "businessId query param is required" });
    }
    if (!mongoose.isValidObjectId(businessId)) {
      return res.status(400).json({ message: "Invalid businessId format" });
    }

    // parse optional rating filter
    let ratingFilter: number | undefined;
    if (typeof rating !== "undefined") {
      const r = Number(rating);
      if (Number.isNaN(r) || !Number.isInteger(r) || r < 1 || r > 5) {
        return res.status(400).json({ message: "rating must be an integer between 1 and 5" });
      }
      ratingFilter = r;
    }

    // pagination
    const pageNum = Math.max(1, Number(page ?? 1));
    const lim = Math.min(200, Math.max(1, Number(limit ?? 20)));
    const skip = (pageNum - 1) * lim;

    // sort options
    let sortObj: any = { createdAt: -1 }; // newest
    const sortStr = String(sort ?? "newest").toLowerCase();
    if (sortStr === "oldest") sortObj = { createdAt: 1 };
    if (sortStr === "rating_desc") sortObj = { rating: -1, createdAt: -1 };
    if (sortStr === "rating_asc") sortObj = { rating: 1, createdAt: -1 };

    // build query
    const query: any = { businessId: new mongoose.Types.ObjectId(businessId) };
    if (typeof ratingFilter !== "undefined") query.rating = ratingFilter;

    // find reviews (populate client info to show name if review doesn't include authorName)
    const reviewsRaw = await Review.find(query)
      .sort(sortObj)
      .skip(skip)
      .limit(lim)
      .populate({ path: "clientId", select: "firstName middleName lastName" })
      .lean()
      .exec();

    // normalize each review for client
    const reviews = (reviewsRaw || []).map((r: any) => {
      const ratingVal = typeof r.rating === "number" ? r.rating : Number(r.rating ?? 0);
      // prefer explicit authorName, fallback to populated client name, fallback to 'Anonymous'
      let author = "Anonymous";
      if (r.authorName && typeof r.authorName === "string" && r.authorName.trim().length > 0) {
        author = r.authorName.trim();
      } else if (r.clientId && (r.clientId.firstName || r.clientId.lastName || r.clientId.middleName)) {
        const parts = [
          r.clientId.firstName,
          r.clientId.middleName,
          r.clientId.lastName
        ].filter((p: any) => typeof p === "string" && p.trim().length > 0).map((p: string) => p.trim());
        if (parts.length > 0) author = parts.join(" ");
      } else if (r.name) {
        author = String(r.name).trim();
      }

      // parse createdAt
      let time: Date | null = null;
      if (r.createdAt) time = new Date(r.createdAt);
      else if (r.time) time = new Date(r.time);

      return {
        id: r._id ?? r.id,
        rating: ratingVal,
        text: r.text ?? r.comment ?? "",
        photoUrls: Array.isArray(r.photoUrls) ? r.photoUrls.filter((p: any) => typeof p === "string" && p.trim().length > 0) : [],
        author,
        clientId: r.clientId ? (typeof r.clientId._id !== "undefined" ? String(r.clientId._id) : r.clientId) : undefined,
        time: time ? time.toISOString() : null,
        raw: r,
      };
    });

    // compute aggregate stats (avg + counts per star + total)
    const agg = await Review.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(businessId) } },
      {
        $group: {
          _id: "$rating",
          count: { $sum: 1 },
          // (we won't compute avg per group here)
        },
      },
      { $sort: { _id: -1 } }, // rating descending
    ]).exec();

    // build counts map 1..5
    const counts: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    let totalReviews = 0;
    for (const g of agg) {
      const key = Number(g._id);
      const c = Number(g.count ?? 0);
      if (!Number.isNaN(key) && key >= 1 && key <= 5) {
        counts[key] = c;
        totalReviews += c;
      }
    }

    // avg rating (computed separately to be precise)
    const avgAgg = await Review.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(businessId) } },
      { $group: { _id: null, avgRating: { $avg: "$rating" }, count: { $sum: 1 } } },
    ]).exec();

    const avgRating = (avgAgg && avgAgg[0] && typeof avgAgg[0].avgRating === "number") ? Number(Number(avgAgg[0].avgRating).toFixed(2)) : null;
    const totalCountFromAgg = (avgAgg && avgAgg[0] && typeof avgAgg[0].count === "number") ? avgAgg[0].count : totalReviews;

    // Provide pagination total (count of all documents matching the query)
    const totalMatching = await Review.countDocuments(query).exec();

    return res.status(200).json({
      success: true,
      businessId,
      page: pageNum,
      limit: lim,
      sort: sortStr,
      totalMatching,
      totalReviews: totalCountFromAgg,
      stats: {
        avgRating,
        counts,
      },
      reviews,
    });
  } catch (err: any) {
    console.error("GET /reviews error:", err);
    return res.status(500).json({ message: "Server error", error: err?.message ?? String(err) });
  }
});


export default router;
