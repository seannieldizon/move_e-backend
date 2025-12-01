import { Router, Request, Response } from "express";
import User from "../models/client_accounts";
import mongoose from "mongoose";
import BusinessInfo from "../models/business_info";
import ServiceOffered from "../models/services_offered";
import Booking from "../models/booking";
import admin from "firebase-admin";
import Location from "../models/location";

const router = Router();

// --- Helper: robust FCM send with multiple SDK compat fallbacks ---
async function sendPushToTokens(
  tokens: string[],
  messagingPayload: { title: string; body: string; data?: Record<string, string> },
  options?: { androidChannelId?: string; apnsCategory?: string }
) {
  const messaging = (admin as any)?.messaging?.();
  if (!messaging) {
    return { note: "Firebase messaging not available on server." };
  }

  const { title, body, data } = messagingPayload;
  const multicastMessage: any = {
    tokens,
    notification: { title, body },
    data: data ?? {},
    android: {
      priority: "high",
      notification: {
        channelId: options?.androidChannelId ?? "bookings",
        clickAction: "FLUTTER_NOTIFICATION_CLICK",
        sound: "default",
      },
    },
    apns: {
      headers: { "apns-priority": "10" },
      payload: {
        aps: {
          alert: { title, body },
          sound: "default",
          category: options?.apnsCategory ?? "BOOKING_UPDATE",
        },
      },
    },
  };

  const legacyPayload: any = {
    notification: { title, body },
    data: data ?? {},
    android: {
      priority: "high",
      notification: {
        channelId: options?.androidChannelId ?? "bookings",
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
    },
    apns: {
      headers: { "apns-priority": "10" },
      payload: {
        aps: {
          alert: { title, body },
          sound: "default",
          category: options?.apnsCategory ?? "BOOKING_UPDATE",
        },
      },
    },
  };

  const summary: any = { successCount: 0, failureCount: 0, responses: [] as any[] };
  const failedTokens: string[] = [];

  try {
    if (typeof messaging.sendEachForMulticast === "function") {
      const r = await messaging.sendEachForMulticast(multicastMessage);
      summary.successCount = r.successCount ?? 0;
      summary.failureCount = r.failureCount ?? 0;
      (r.responses ?? []).forEach((resp: any, i: number) => {
        summary.responses.push({ success: !!resp.success, error: resp.error ? String(resp.error) : undefined });
        if (!resp.success) {
          const code = resp.error?.code ?? String(resp.error);
          if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
            failedTokens.push(tokens[i]);
          }
        }
      });
    } else if (typeof messaging.sendMulticast === "function") {
      const r = await messaging.sendMulticast(multicastMessage);
      summary.successCount = r.successCount ?? 0;
      summary.failureCount = r.failureCount ?? 0;
      (r.responses ?? []).forEach((resp: any, i: number) => {
        summary.responses.push({ success: !!resp.success, error: resp.error ? String(resp.error) : undefined });
        if (!resp.success) {
          const code = resp.error?.code ?? String(resp.error);
          if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
            failedTokens.push(tokens[i]);
          }
        }
      });
    } else if (typeof messaging.sendToDevice === "function") {
      const r = await messaging.sendToDevice(tokens, legacyPayload);
      const results = r.results ?? r.responses ?? r;
      let s = 0, f = 0;
      (results ?? []).forEach((res: any, i: number) => {
        if (res && res.error) {
          f++;
          const code = res.error.code ?? String(res.error);
          summary.responses.push({ success: false, error: code });
          if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
            failedTokens.push(tokens[i]);
          }
        } else {
          s++;
          summary.responses.push({ success: true });
        }
      });
      summary.successCount = s;
      summary.failureCount = f;
    } else {
      return { note: "No supported send method on admin.messaging()" };
    }

    return { summary, failedTokens };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// parse "HH:mm" or "HH:mm:ss" into minutes since midnight, or null if invalid
function parseTimeToMinutes(t?: string | null): number | null {
  if (!t || typeof t !== "string") return null;
  const parts = t.split(":").map((p) => parseInt(p, 10));
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return null;
  const hours = parts[0];
  const minutes = parts[1];
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// map weekday index (0 = Sunday .. 6 = Saturday) to keys used in operatingSchedule map
function weekdayIndexToKey(idx: number): string {
  // your schema default uses keys: Mon, Tue, Wed, Thu, Fri, Sat, Sun
  const map = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return map[idx] ?? "Sun";
}

// format day ranges into readable string like "09:00-12:00, 13:00-17:00" or "closed"
function formatDayAllowedRangesForKey(rawSchedule: any, key: string): string {
  if (!rawSchedule) return "not specified";
  const entry = rawSchedule[key];
  if (!entry) return "closed";
  if (entry.closed === true) return "closed";
  const s = entry.open ?? null;
  const e = entry.close ?? null;
  if (!s || !e) return "closed";
  return `${s}-${e}`;
}

// returns true if parsedDate's local time-of-day falls within the provided open/close ranges.
// Accepts overnight ranges (close <= open means overnight).
function isTimeWithinOpenClose(
  parsedDate: Date,
  openStr?: string | null,
  closeStr?: string | null
): boolean {
  const s = parseTimeToMinutes(openStr);
  const e = parseTimeToMinutes(closeStr);
  if (s == null || e == null) return false; // treat as closed if parse fails
  const minutes = parsedDate.getHours() * 60 + parsedDate.getMinutes();
  if (e > s) {
    // normal same-day interval [s, e)
    return minutes >= s && minutes < e;
  } else {
    // overnight interval e <= s, e.g. 22:00-02:00
    return minutes >= s || minutes < e;
  }
}

router.post("/add-bookings", async (req: Request, res: Response) => {
  try {
    const {
      clientId,
      businessId,
      serviceId,
      serviceTitle,
      servicePrice,
      serviceDuration,
      scheduledAt,
      contactName,
      contactPhone,
      notes,
      metadata,
    } = req.body ?? {};

    // Basic required fields
    if (!clientId || !businessId || !serviceTitle || !scheduledAt || !contactName || !contactPhone) {
      return res.status(400).json({ message: "Missing required booking fields." });
    }

    if (!mongoose.isValidObjectId(clientId) || !mongoose.isValidObjectId(businessId)) {
      return res.status(400).json({ message: "Invalid clientId or businessId." });
    }
    if (serviceId && !mongoose.isValidObjectId(serviceId)) {
      return res.status(400).json({ message: "Invalid serviceId." });
    }

    // Ensure client exists and fetch business doc
    const [clientExists, businessDoc] = await Promise.all([
      User.findById(clientId).select("_id").lean().exec(),
      BusinessInfo.findById(businessId).lean().exec(),
    ]);

    if (!clientExists) return res.status(404).json({ message: "Client not found." });
    if (!businessDoc) return res.status(404).json({ message: "Business not found." });

    // Resolve service details if a serviceId is provided and any of title/price/duration missing
    let resolvedTitle = serviceTitle;
    let resolvedPrice = servicePrice;
    let resolvedDuration = serviceDuration;
    if (serviceId) {
      const svc = await ServiceOffered.findById(serviceId).lean().exec();
      if (svc) {
        if (!resolvedTitle) resolvedTitle = (svc as any).title ?? resolvedTitle;
        if (resolvedPrice == null && (svc as any).price != null) resolvedPrice = (svc as any).price;
        if (!resolvedDuration && (svc as any).duration) resolvedDuration = (svc as any).duration;
      }
    }

    const parsedDate = new Date(scheduledAt);
    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({ message: "scheduledAt must be a valid date/time string." });
    }

    // --- Validate against business operatingSchedule if present ---
    const rawSchedule = (businessDoc as any).operatingSchedule ?? null;
    if (rawSchedule) {
      const weekday = parsedDate.getDay(); // 0 = Sunday .. 6 = Saturday
      const key = weekdayIndexToKey(weekday);
      const entry = rawSchedule[key];

      if (entry && entry.closed === true) {
        const allowed = formatDayAllowedRangesForKey(rawSchedule, key);
        return res.status(400).json({
          message: "Business is closed on the requested day.",
          day: key,
          allowed,
          requested: parsedDate.toISOString(),
        });
      }

      const openStr = entry?.open ?? null;
      const closeStr = entry?.close ?? null;

      if (parseTimeToMinutes(openStr) != null && parseTimeToMinutes(closeStr) != null) {
        const ok = isTimeWithinOpenClose(parsedDate, openStr, closeStr);
        if (!ok) {
          const allowed = formatDayAllowedRangesForKey(rawSchedule, key);
          return res.status(400).json({
            message: "Requested time falls outside business operating hours.",
            day: key,
            allowed,
            requested: parsedDate.toISOString(),
          });
        }
      } else {
        const allowed = formatDayAllowedRangesForKey(rawSchedule, key);
        return res.status(400).json({
          message: "Business operating hours not available for the requested day (treated as closed).",
          day: key,
          allowed,
          requested: parsedDate.toISOString(),
        });
      }
    }

    // Build booking document
    const bookingDoc = new Booking({
      clientId: new mongoose.Types.ObjectId(clientId),
      businessId: new mongoose.Types.ObjectId(businessId),
      serviceId: serviceId ? new mongoose.Types.ObjectId(serviceId) : undefined,
      serviceTitle: String(resolvedTitle),
      servicePrice: resolvedPrice != null ? Number(resolvedPrice) : undefined,
      serviceDuration: resolvedDuration ? String(resolvedDuration) : undefined,
      scheduledAt: parsedDate,
      contactName: String(contactName),
      contactPhone: String(contactPhone),
      notes: notes ? String(notes) : undefined,
      metadata: metadata ?? undefined,
      status: "pending",
      paymentStatus: "pending",
    });

    // --- Find client's currently selected Location and copy address/lat/lng/floor/note ---
    try {
      const selectedLocation = (await Location.findOne({
        clientId: new mongoose.Types.ObjectId(clientId),
        selectedLocation: true,
      }).lean().exec()) as any | null;

      if (selectedLocation) {
        // Address candidates (support multiple possible field names)
        const addrCandidate =
          (selectedLocation.address ??
            selectedLocation.displayName ??
            selectedLocation.display ??
            selectedLocation.name) ?? "";

        // Lat/lon candidates
        const latCandidate =
          selectedLocation.latitude ?? selectedLocation.lat ?? selectedLocation.latlng?.lat ?? null;
        const lonCandidate =
          selectedLocation.longitude ?? selectedLocation.lon ?? selectedLocation.lng ?? selectedLocation.latlng?.lng ?? null;

        // Floor and note candidates (common field names)
        const floorCandidate =
          selectedLocation.floor ??
          selectedLocation.floorNumber ??
          selectedLocation.level ??
          selectedLocation.unit ??
          selectedLocation.unitNumber ??
          null;

        const noteCandidate =
          selectedLocation.note ??
          selectedLocation.notes ??
          selectedLocation.description ??
          selectedLocation.instructions ??
          null;

        const addr = typeof addrCandidate === "string" ? addrCandidate.trim() : "";
        const lat = latCandidate != null ? Number(latCandidate) : NaN;
        const lon = lonCandidate != null ? Number(lonCandidate) : NaN;

        const floor =
          floorCandidate !== null && floorCandidate !== undefined
            ? String(floorCandidate).trim()
            : undefined;
        const note =
          noteCandidate !== null && noteCandidate !== undefined ? String(noteCandidate).trim() : undefined;

        if (addr.length > 0 && !Number.isNaN(lat) && !Number.isNaN(lon)) {
          (bookingDoc as any).location = {
            address: addr,
            latitude: lat,
            longitude: lon,
            ...(floor ? { floor } : {}),
            ...(note ? { note } : {}),
          };
        }
      }
    } catch (locErr) {
      console.warn("Failed to lookup selected location for client:", locErr);
    }

    // Save booking
    await bookingDoc.save();

    // --- Send push notification to business/provider (best-effort) ---
    let notificationResult: any = null;
    try {
      const tokens: string[] = [];

      // 1) check businessDoc.fcmTokens (array)
      if ((businessDoc as any).fcmTokens && Array.isArray((businessDoc as any).fcmTokens)) {
        for (const t of (businessDoc as any).fcmTokens) {
          if (typeof t === "string" && t.trim().length > 0) tokens.push(t);
        }
      }

      // 2) fallback: fetch provider user by businessDoc.clientId to get user's fcmToken
      if (tokens.length === 0 && (businessDoc as any).clientId) {
        try {
          const owner = await User.findById((businessDoc as any).clientId).select("fcmToken").lean().exec();
          if (owner && (owner as any).fcmToken) {
            const t = (owner as any).fcmToken;
            if (typeof t === "string" && t.trim().length > 0) tokens.push(t);
          }
        } catch (innerErr) {
          console.warn("Failed to lookup owner fcmToken:", innerErr);
        }
      }

      if (tokens.length === 0) {
        notificationResult = { note: "No fcm tokens found for business/provider." };
      } else {
        // Compose notification
        const title = "New booking request";
        const formattedDateTime = bookingDoc.scheduledAt.toLocaleString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

        const body = `${bookingDoc.contactName} requested ${bookingDoc.serviceTitle} on ${formattedDateTime}`;

        const dataPayload: Record<string, string> = {
          bookingId: String((bookingDoc as any)._id),
          businessId: String(businessId),
          type: "new_booking",
          scheduledAt: bookingDoc.scheduledAt.toISOString(),
        };

        // Use helper to send
        const sendResult = await sendPushToTokens(tokens, { title, body, data: dataPayload }, { androidChannelId: "bookings", apnsCategory: "NEW_BOOKING" });

        if ((sendResult as any).error) {
          notificationResult = { error: (sendResult as any).error };
        } else {
          notificationResult = (sendResult as any).summary ?? sendResult;
          if (Array.isArray((sendResult as any).failedTokens) && (sendResult as any).failedTokens.length > 0) {
            try {
              await BusinessInfo.updateOne({ _id: businessId }, { $pull: { fcmTokens: { $in: (sendResult as any).failedTokens } } }).exec();
              notificationResult.removedInvalidTokens = (sendResult as any).failedTokens;
            } catch (e) {
              console.warn("Failed to remove invalid tokens:", e);
              notificationResult.removeError = String(e);
            }
          }
        }
      }
    } catch (notifErr) {
      console.error("Failed to send booking notification:", notifErr);
      notificationResult = { error: notifErr instanceof Error ? notifErr.message : String(notifErr) };
    }

    // Return booking + optional notification result
    return res.status(201).json({
      message: "Booking created.",
      booking: bookingDoc,
      notification: notificationResult,
    });
  } catch (err) {
    console.error("POST /add-bookings error:", err);
    return res.status(500).json({ message: "Server error.", error: (err as Error).message });
  }
});

router.post("/:id/cancel-booking", async (req: Request, res: Response) => {
  try {
    const bookingId = req.params.id;
    const clientId = (req.body?.clientId ?? req.query?.clientId) as string | undefined;

    if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    if (!clientId || !mongoose.isValidObjectId(clientId)) {
      return res.status(400).json({ success: false, message: "Valid clientId is required" });
    }

    // Find the booking
    const booking = await Booking.findById(bookingId).exec();
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    // Check ownership
    if (booking.clientId == null || booking.clientId.toString() !== clientId.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized to cancel this booking" });
    }

    const currentStatus = (booking.status ?? "").toString().toLowerCase();
    if (["cancelled", "completed", "rejected"].includes(currentStatus)) {
      return res.status(409).json({ success: false, message: `Cannot cancel booking with status '${booking.status}'` });
    }

    // Update status + push a tracking entry
    booking.status = "cancelled";
    booking.updatedAt = new Date();
    if (!Array.isArray((booking as any).trackingHistory)) (booking as any).trackingHistory = [];
    (booking as any).trackingHistory.push({
      status: "Cancelled",
      message: "Booking cancelled by client",
      timestamp: new Date(),
    });

    await booking.save();

    // Optionally populate to return richer object (client, business, service)
    const populated = (await Booking.findById(booking._id)
      .populate({ path: "clientId", select: "firstName lastName email phone fcmToken fcmTokens", model: User })
      .populate({ path: "businessId", select: "businessName location fcmTokens clientId", model: BusinessInfo })
      .populate({ path: "serviceId", select: "title price duration", model: ServiceOffered })
      .lean()
      .exec()) as any;

    // Prepare notification objects and tokens
    let notification: any = {};
    try {
      // Use either booking.serviceTitle (explicit stored string) or populated.serviceId.title (populated doc)
      const serviceTitle = (booking as any).serviceTitle ?? (populated?.serviceId ? (populated.serviceId as any).title : "your booking");

      const formattedDateTime = booking.scheduledAt
        ? new Date(booking.scheduledAt).toLocaleString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          })
        : "";

      // Build client's full name (prefer populated client fields, fallback to booking.contactName)
      let clientFullName = "the client";
      const clientDoc = populated?.clientId ?? null;
      if (clientDoc) {
        const fn = (clientDoc.firstName ?? "").toString().trim();
        const ln = (clientDoc.lastName ?? "").toString().trim();
        if (fn || ln) {
          clientFullName = `${fn}${fn && ln ? " " : ""}${ln}`.trim();
        }
      }
      if ((clientFullName === "the client" || clientFullName.trim() === "") && booking.contactName) {
        const contact = (booking as any).contactName ?? "";
        if (typeof contact === "string" && contact.trim().length > 0) clientFullName = contact.trim();
      }

      // Notify business/provider first (similar to add-bookings)
      const businessDoc = (populated as any)?.businessId ?? null;
      const providerTokens: string[] = [];
      if (businessDoc) {
        if (Array.isArray(businessDoc.fcmTokens)) {
          for (const t of businessDoc.fcmTokens) {
            if (typeof t === "string" && t.trim().length > 0) providerTokens.push(t);
          }
        }
        // fallback: try to fetch owner user fcmToken if the business doc references clientId
        if (providerTokens.length === 0 && businessDoc.clientId) {
          try {
            const owner = await User.findById(businessDoc.clientId).select("fcmToken fcmTokens").lean().exec() as any;
            if (owner) {
              if (Array.isArray(owner.fcmTokens)) {
                for (const t of owner.fcmTokens) {
                  if (typeof t === "string" && t.trim().length > 0) providerTokens.push(t);
                }
              }
              if ((!Array.isArray(owner.fcmTokens) || providerTokens.length === 0) && typeof owner.fcmToken === "string" && owner.fcmToken.trim().length > 0) {
                providerTokens.push(owner.fcmToken);
              }
            }
          } catch (e) {
            console.warn("Failed to lookup business owner for tokens:", e);
          }
        }
      }

      const providerTitle = "Booking cancelled";
      // use client's full name here
      const providerBody = `${serviceTitle} scheduled on ${formattedDateTime} was cancelled by ${clientFullName}.`;

      if (providerTokens.length > 0) {
        const provResult = await sendPushToTokens(
          providerTokens,
          { title: providerTitle, body: providerBody, data: { bookingId: String(booking._id), type: "booking_cancelled" } },
          { androidChannelId: "bookings", apnsCategory: "BOOKING_CANCELLED" }
        );
        notification.provider = provResult;
        if (Array.isArray((provResult as any).failedTokens) && (provResult as any).failedTokens.length > 0 && businessDoc && businessDoc._id) {
          try {
            await BusinessInfo.updateOne({ _id: businessDoc._id }, { $pull: { fcmTokens: { $in: (provResult as any).failedTokens } } }).exec();
            notification.providerPruned = (provResult as any).failedTokens;
          } catch (e) {
            console.warn("Failed to prune invalid business tokens", e);
          }
        }
      } else {
        notification.provider = { note: "No fcm tokens found for business/provider." };
      }

      // Notify client (so the client device also receives a push if they have multiple devices)
      const clientTokens: string[] = [];
      if (clientDoc) {
        if (Array.isArray(clientDoc.fcmTokens)) {
          for (const t of clientDoc.fcmTokens) {
            if (typeof t === "string" && t.trim().length > 0) clientTokens.push(t);
          }
        }
        if ((!Array.isArray(clientDoc.fcmTokens) || clientTokens.length === 0) && typeof clientDoc.fcmToken === "string" && clientDoc.fcmToken.trim().length > 0) {
          clientTokens.push(clientDoc.fcmToken);
        }
      }

      const clientTitle = "Booking cancelled";
      const clientBody = `${serviceTitle} scheduled on ${formattedDateTime} has been cancelled.`;

      if (clientTokens.length > 0) {
        const clientResult = await sendPushToTokens(
          clientTokens,
          { title: clientTitle, body: clientBody, data: { bookingId: String(booking._id), type: "booking_cancelled" } },
          { androidChannelId: "bookings", apnsCategory: "BOOKING_CANCELLED" }
        );
        notification.client = clientResult;
        if (Array.isArray((clientResult as any).failedTokens) && (clientResult as any).failedTokens.length > 0 && clientDoc && clientDoc._id) {
          try {
            if (Array.isArray(clientDoc.fcmTokens)) {
              await User.updateOne({ _id: clientDoc._id }, { $pull: { fcmTokens: { $in: (clientResult as any).failedTokens } } }).exec();
              notification.clientPruned = (clientResult as any).failedTokens;
            } else if (clientDoc.fcmToken && (clientResult as any).failedTokens.includes(clientDoc.fcmToken)) {
              await User.updateOne({ _id: clientDoc._id }, { $unset: { fcmToken: 1 } }).exec();
              notification.clientPruned = (clientResult as any).failedTokens;
            }
          } catch (e) {
            console.warn("Failed to prune invalid client tokens", e);
          }
        }
      } else {
        notification.client = { note: "No fcm tokens found for client." };
      }
    } catch (notifErr) {
      console.error("Cancel booking notification failed:", notifErr);
      notification = notification || {};
      notification.error = notifErr instanceof Error ? notifErr.message : String(notifErr);
    }

    return res.status(200).json({ success: true, message: "Booking cancelled", booking: populated, notification });
  } catch (err) {
    console.error("POST /bookings/:id/cancel error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: (err as Error).message });
  }
});

// POST /reject/:id
router.post("/reject/:id", async (req: Request, res: Response) => {
  try {
    const bookingId = req.params.id;
    const { reason, actorId } = req.body ?? {};

    if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    // find booking
    const booking = await Booking.findById(bookingId).exec();
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const currentStatus = (booking.status ?? "").toString().toLowerCase();
    if (["cancelled", "completed", "rejected"].includes(currentStatus)) {
      return res.status(409).json({
        success: false,
        message: `Cannot reject booking with status '${booking.status}'`,
      });
    }

    // update booking
    booking.status = "rejected";
    if (reason && typeof reason === "string" && reason.trim().length > 0) {
      // store trimmed reason
      (booking as any).rejectionReason = reason.trim();
    } else {
      // ensure field is unset if not provided
      (booking as any).rejectionReason = undefined;
    }
    booking.updatedAt = new Date();

    await booking.save();

    // populate to return richer object
    const populated = (await Booking.findById(booking._id)
  .populate({ path: "clientId", select: "firstName lastName email phone fcmToken fcmTokens", model: User })
  .populate({ path: "businessId", select: "businessName location", model: BusinessInfo })
  .populate({ path: "serviceId", select: "title price duration", model: ServiceOffered })
  .lean()
  .exec()) as any;

    // Try to send notification to client (best-effort)
    let notificationResult: any = null;
    try {
      // collect tokens from client doc (support fcmToken single or fcmTokens array)
      const clientDoc = populated?.clientId as any | null;
      const tokens: string[] = [];

      if (clientDoc) {
        if (Array.isArray(clientDoc.fcmTokens)) {
          for (const t of clientDoc.fcmTokens) {
            if (typeof t === "string" && t.trim()) tokens.push(t);
          }
        }
        if (!clientDoc.fcmTokens && typeof clientDoc.fcmToken === "string" && clientDoc.fcmToken.trim()) {
          tokens.push(clientDoc.fcmToken);
        }
      }

      if (tokens.length === 0) {
        notificationResult = { note: "No fcm tokens found for client." };
      } else {
        // Compose notification
        const title = "Booking rejected";
        const formattedDateTime = booking.scheduledAt
          ? new Date(booking.scheduledAt).toLocaleString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            })
          : "";

        const serviceTitle = (booking as any).serviceTitle ?? (populated?.serviceId?.title ?? "your booking");
        const body = reason && typeof reason === "string" && reason.trim().length > 0
          ? `${serviceTitle} scheduled on ${formattedDateTime} was rejected. Reason: ${String(reason).trim()}`
          : `${serviceTitle} scheduled on ${formattedDateTime} was rejected.`;

        const dataPayload: Record<string, string> = {
          bookingId: String(booking._id),
          type: "booking_rejected",
        };

        const multicastMessage: any = {
          tokens,
          notification: { title, body },
          data: dataPayload,
          android: {
            priority: "high",
            notification: {
              channelId: "bookings",
              clickAction: "FLUTTER_NOTIFICATION_CLICK",
              sound: "default",
            },
          },
          apns: {
            headers: { "apns-priority": "10" },
            payload: {
              aps: {
                alert: { title, body },
                sound: "default",
                category: "BOOKING_REJECTED",
              },
            },
          },
        };

        const legacyPayload: any = {
          notification: { title, body },
          data: dataPayload,
          android: {
            priority: "high",
            notification: {
              channelId: "bookings",
              click_action: "FLUTTER_NOTIFICATION_CLICK",
            },
          },
          apns: {
            headers: { "apns-priority": "10" },
            payload: {
              aps: {
                alert: { title, body },
                sound: "default",
                category: "BOOKING_REJECTED",
              },
            },
          },
        };

        const messaging = (admin as any)?.messaging?.();
        notificationResult = { successCount: 0, failureCount: 0, responses: [] as any[] };
        const failedTokens: string[] = [];

        if (messaging && typeof messaging.sendEachForMulticast === "function") {
          const sendRes = await messaging.sendEachForMulticast(multicastMessage);
          notificationResult.successCount = sendRes.successCount ?? 0;
          notificationResult.failureCount = sendRes.failureCount ?? 0;
          (sendRes.responses ?? []).forEach((r: any, i: number) => {
            notificationResult.responses.push({ success: !!r.success, error: r.error ? String(r.error) : undefined });
            if (!r.success) {
              const code = r.error?.code ?? String(r.error);
              if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
                failedTokens.push(tokens[i]);
              }
            }
          });
        } else if (messaging && typeof messaging.sendMulticast === "function") {
          const sendRes = await messaging.sendMulticast(multicastMessage);
          notificationResult.successCount = sendRes.successCount ?? 0;
          notificationResult.failureCount = sendRes.failureCount ?? 0;
          (sendRes.responses ?? []).forEach((r: any, i: number) => {
            notificationResult.responses.push({ success: !!r.success, error: r.error ? String(r.error) : undefined });
            if (!r.success) {
              const code = r.error?.code ?? String(r.error);
              if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
                failedTokens.push(tokens[i]);
              }
            }
          });
        } else if (messaging && typeof messaging.sendToDevice === "function") {
          const sendRes = await messaging.sendToDevice(tokens, legacyPayload);
          const results = sendRes.results ?? sendRes.responses ?? sendRes;
          let successCount = 0;
          let failureCount = 0;
          (results ?? []).forEach((r: any, i: number) => {
            if (r && r.error) {
              failureCount++;
              const code = r.error.code ?? String(r.error);
              notificationResult.responses.push({ success: false, error: code });
              if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
                failedTokens.push(tokens[i]);
              }
            } else {
              successCount++;
              notificationResult.responses.push({ success: true });
            }
          });
          notificationResult.successCount = successCount;
          notificationResult.failureCount = failureCount;
        } else {
          notificationResult = { note: "Firebase messaging not available on server." };
        }

        // prune invalid tokens from user document if applicable
        if (failedTokens.length > 0 && clientDoc && clientDoc._id) {
          try {
            // try to remove from either fcmTokens array or single fcmToken
            if (Array.isArray((clientDoc as any).fcmTokens)) {
              await User.updateOne({ _id: clientDoc._id }, { $pull: { fcmTokens: { $in: failedTokens } } }).exec();
              notificationResult.removedInvalidTokens = failedTokens;
            } else if ((clientDoc as any).fcmToken && failedTokens.includes((clientDoc as any).fcmToken)) {
              await User.updateOne({ _id: clientDoc._id }, { $unset: { fcmToken: 1 } }).exec();
              notificationResult.removedInvalidTokens = failedTokens;
            }
          } catch (e) {
            notificationResult.removeError = String(e);
          }
        }
      }
    } catch (notifErr) {
      console.error("Failed to send rejection notification:", notifErr);
      notificationResult = { error: notifErr instanceof Error ? notifErr.message : String(notifErr) };
    }

    return res.status(200).json({
      success: true,
      message: "Booking rejected.",
      booking: populated,
      notification: notificationResult,
    });
  } catch (err) {
    console.error("POST /reject/:id error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: (err as Error).message });
  }
});

// POST /:id/accept
router.post("/:id/accept", async (req: Request, res: Response) => {
  try {
    const bookingId = req.params.id;
    const { actorId } = req.body ?? {}; // optional: who performed the accept (business user)

    if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    // find booking
    const booking = await Booking.findById(bookingId).exec();
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const currentStatus = (booking.status ?? "").toString().toLowerCase();
    // cannot accept if already in final states
    if (["cancelled", "completed", "rejected"].includes(currentStatus)) {
      return res.status(409).json({
        success: false,
        message: `Cannot accept booking with status '${booking.status}'`,
      });
    }
    if (currentStatus === "confirmed") {
      // idempotent response for already-confirmed bookings
      const populatedAlready = (await Booking.findById(booking._id)
        .populate({ path: "clientId", select: "firstName lastName email phone fcmToken fcmTokens", model: User })
        .populate({ path: "businessId", select: "businessName location", model: BusinessInfo })
        .populate({ path: "serviceId", select: "title price duration", model: ServiceOffered })
        .lean()
        .exec()) as any;
      return res.status(200).json({ success: true, message: "Booking already confirmed", booking: populatedAlready });
    }

    // update booking
    booking.status = "confirmed";
    // remove any previous rejectionReason if present
    if ((booking as any).rejectionReason) (booking as any).rejectionReason = undefined;
    booking.updatedAt = new Date();

    await booking.save();

    // populate to return richer object
    const populated = (await Booking.findById(booking._id)
      .populate({ path: "clientId", select: "firstName lastName email phone fcmToken fcmTokens", model: User })
      .populate({ path: "businessId", select: "businessName location", model: BusinessInfo })
      .populate({ path: "serviceId", select: "title price duration", model: ServiceOffered })
      .lean()
      .exec()) as any;

    // Try to send notification to client (best-effort)
    let notificationResult: any = null;
    try {
      const clientDoc = populated?.clientId as any | null;
      const tokens: string[] = [];

      if (clientDoc) {
        if (Array.isArray(clientDoc.fcmTokens)) {
          for (const t of clientDoc.fcmTokens) {
            if (typeof t === "string" && t.trim()) tokens.push(t);
          }
        }
        if (!clientDoc.fcmTokens && typeof clientDoc.fcmToken === "string" && clientDoc.fcmToken.trim()) {
          tokens.push(clientDoc.fcmToken);
        }
      }

      if (tokens.length === 0) {
        notificationResult = { note: "No fcm tokens found for client." };
      } else {
        const title = "Booking confirmed";
        const formattedDateTime = booking.scheduledAt
          ? new Date(booking.scheduledAt).toLocaleString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            })
          : "";
        const serviceTitle = (booking as any).serviceTitle ?? (populated?.serviceId?.title ?? "your booking");
        const body = `${serviceTitle} scheduled on ${formattedDateTime} has been confirmed.`;

        const dataPayload: Record<string, string> = {
          bookingId: String(booking._id),
          type: "booking_confirmed",
        };

        const multicastMessage: any = {
          tokens,
          notification: { title, body },
          data: dataPayload,
          android: {
            priority: "high",
            notification: {
              channelId: "bookings",
              clickAction: "FLUTTER_NOTIFICATION_CLICK",
              sound: "default",
            },
          },
          apns: {
            headers: { "apns-priority": "10" },
            payload: {
              aps: {
                alert: { title, body },
                sound: "default",
                category: "BOOKING_CONFIRMED",
              },
            },
          },
        };

        const legacyPayload: any = {
          notification: { title, body },
          data: dataPayload,
          android: {
            priority: "high",
            notification: {
              channelId: "bookings",
              click_action: "FLUTTER_NOTIFICATION_CLICK",
            },
          },
          apns: {
            headers: { "apns-priority": "10" },
            payload: {
              aps: {
                alert: { title, body },
                sound: "default",
                category: "BOOKING_CONFIRMED",
              },
            },
          },
        };

        const messaging = (admin as any)?.messaging?.();
        notificationResult = { successCount: 0, failureCount: 0, responses: [] as any[] };
        const failedTokens: string[] = [];

        if (messaging && typeof messaging.sendEachForMulticast === "function") {
          const sendRes = await messaging.sendEachForMulticast(multicastMessage);
          notificationResult.successCount = sendRes.successCount ?? 0;
          notificationResult.failureCount = sendRes.failureCount ?? 0;
          (sendRes.responses ?? []).forEach((r: any, i: number) => {
            notificationResult.responses.push({ success: !!r.success, error: r.error ? String(r.error) : undefined });
            if (!r.success) {
              const code = r.error?.code ?? String(r.error);
              if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
                failedTokens.push(tokens[i]);
              }
            }
          });
        } else if (messaging && typeof messaging.sendMulticast === "function") {
          const sendRes = await messaging.sendMulticast(multicastMessage);
          notificationResult.successCount = sendRes.successCount ?? 0;
          notificationResult.failureCount = sendRes.failureCount ?? 0;
          (sendRes.responses ?? []).forEach((r: any, i: number) => {
            notificationResult.responses.push({ success: !!r.success, error: r.error ? String(r.error) : undefined });
            if (!r.success) {
              const code = r.error?.code ?? String(r.error);
              if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
                failedTokens.push(tokens[i]);
              }
            }
          });
        } else if (messaging && typeof messaging.sendToDevice === "function") {
          const sendRes = await messaging.sendToDevice(tokens, legacyPayload);
          const results = sendRes.results ?? sendRes.responses ?? sendRes;
          let successCount = 0;
          let failureCount = 0;
          (results ?? []).forEach((r: any, i: number) => {
            if (r && r.error) {
              failureCount++;
              const code = r.error.code ?? String(r.error);
              notificationResult.responses.push({ success: false, error: code });
              if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
                failedTokens.push(tokens[i]);
              }
            } else {
              successCount++;
              notificationResult.responses.push({ success: true });
            }
          });
          notificationResult.successCount = successCount;
          notificationResult.failureCount = failureCount;
        } else {
          notificationResult = { note: "Firebase messaging not available on server." };
        }

        // prune invalid tokens from client doc if applicable
        if (failedTokens.length > 0 && clientDoc && clientDoc._id) {
          try {
            if (Array.isArray((clientDoc as any).fcmTokens)) {
              await User.updateOne({ _id: clientDoc._id }, { $pull: { fcmTokens: { $in: failedTokens } } }).exec();
              notificationResult.removedInvalidTokens = failedTokens;
            } else if ((clientDoc as any).fcmToken && failedTokens.includes((clientDoc as any).fcmToken)) {
              await User.updateOne({ _id: clientDoc._id }, { $unset: { fcmToken: 1 } }).exec();
              notificationResult.removedInvalidTokens = failedTokens;
            }
          } catch (e) {
            notificationResult.removeError = String(e);
          }
        }
      }
    } catch (notifErr) {
      console.error("Failed to send confirmation notification:", notifErr);
      notificationResult = { error: notifErr instanceof Error ? notifErr.message : String(notifErr) };
    }

    return res.status(200).json({
      success: true,
      message: "Booking confirmed.",
      booking: populated,
      notification: notificationResult,
    });
  } catch (err) {
    console.error("POST /:id/accept error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: (err as Error).message });
  }
});

// POST /:id/track
router.post("/:id/track", async (req: Request, res: Response) => {
  try {
    const bookingId = req.params.id;
    const { status, message, actorId } = req.body ?? {};

    if (!bookingId || !mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    if (!status || typeof status !== "string" || status.trim().length === 0) {
      return res.status(400).json({ success: false, message: "Missing 'status' in request body." });
    }

    // normalize status label (e.g., "Preparing", "On the way", "Arrived", "Completed")
    const statusLabel = String(status).trim();
    const statusLower = statusLabel.toLowerCase();

    // find booking
    const booking = await Booking.findById(bookingId).exec();
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const currentStatus = (booking.status ?? "").toString().toLowerCase();
    // disallow updating tracking for bookings in final states
    if (["cancelled", "rejected"].includes(currentStatus)) {
      return res.status(409).json({
        success: false,
        message: `Cannot update tracking for booking with status '${booking.status}'`,
      });
    }
    if (currentStatus === "completed") {
      return res.status(409).json({
        success: false,
        message: "Booking already completed; tracking cannot be updated.",
      });
    }

    // Build tracking entry
    const now = new Date();
    const trackingEntry: any = {
      status: statusLabel,
      message: typeof message === "string" ? message.trim() : "",
      actorId: actorId ? actorId : undefined,
      timestamp: now,
    };

    // update booking fields
    (booking as any).tracking = statusLabel;
    (booking as any).trackingMessage = typeof message === "string" ? message.trim() : "";
    // ensure trackingHistory array exists then push
    if (!Array.isArray((booking as any).trackingHistory)) {
      (booking as any).trackingHistory = [];
    }
    (booking as any).trackingHistory.push(trackingEntry);

    // update overall booking status: completed => completed, else keep/ensure confirmed
    if (statusLower === "completed") {
      booking.status = "completed";
    } else {
      // keep existing status if it's already 'confirmed', otherwise set to 'confirmed'
      booking.status = booking.status && booking.status.toString().toLowerCase() === "confirmed" ? booking.status : "confirmed";
    }

    booking.updatedAt = now;

    await booking.save();

    // populate to return richer object
    const populated = (await Booking.findById(booking._id)
      .populate({ path: "clientId", select: "firstName lastName email phone fcmToken fcmTokens", model: User })
      .populate({ path: "businessId", select: "businessName location", model: BusinessInfo })
      .populate({ path: "serviceId", select: "title price duration", model: ServiceOffered })
      .lean()
      .exec()) as any;

    // Try to send notification to client (best-effort)
    let notificationResult: any = null;
    try {
      const clientDoc = populated?.clientId as any | null;
      const tokens: string[] = [];

      if (clientDoc) {
        if (Array.isArray(clientDoc.fcmTokens)) {
          for (const t of clientDoc.fcmTokens) {
            if (typeof t === "string" && t.trim()) tokens.push(t);
          }
        }
        if (!clientDoc.fcmTokens && typeof clientDoc.fcmToken === "string" && clientDoc.fcmToken.trim()) {
          tokens.push(clientDoc.fcmToken);
        }
      }

      if (tokens.length === 0) {
        notificationResult = { note: "No fcm tokens found for client." };
      } else {
        const title = `Booking update: ${statusLabel}`;
        // prefer provided message as body; if not, construct a short message
        const body = (typeof message === "string" && message.trim().length > 0)
          ? message.trim()
          : `${(booking as any).serviceTitle ?? (populated?.serviceId?.title ?? "Your booking")} status updated to ${statusLabel}.`;

        const dataPayload: Record<string, string> = {
          bookingId: String(booking._id),
          type: "booking_tracking",
          trackingStatus: statusLabel,
        };

        const multicastMessage: any = {
          tokens,
          notification: { title, body },
          data: dataPayload,
          android: {
            priority: "high",
            notification: {
              channelId: "bookings",
              clickAction: "FLUTTER_NOTIFICATION_CLICK",
              sound: "default",
            },
          },
          apns: {
            headers: { "apns-priority": "10" },
            payload: {
              aps: {
                alert: { title, body },
                sound: "default",
                category: "BOOKING_TRACKING",
              },
            },
          },
        };

        const legacyPayload: any = {
          notification: { title, body },
          data: dataPayload,
          android: {
            priority: "high",
            notification: {
              channelId: "bookings",
              click_action: "FLUTTER_NOTIFICATION_CLICK",
            },
          },
          apns: {
            headers: { "apns-priority": "10" },
            payload: {
              aps: {
                alert: { title, body },
                sound: "default",
                category: "BOOKING_TRACKING",
              },
            },
          },
        };

        const messaging = (admin as any)?.messaging?.();
        notificationResult = { successCount: 0, failureCount: 0, responses: [] as any[] };
        const failedTokens: string[] = [];

        if (messaging && typeof messaging.sendEachForMulticast === "function") {
          const sendRes = await messaging.sendEachForMulticast(multicastMessage);
          notificationResult.successCount = sendRes.successCount ?? 0;
          notificationResult.failureCount = sendRes.failureCount ?? 0;
          (sendRes.responses ?? []).forEach((r: any, i: number) => {
            notificationResult.responses.push({ success: !!r.success, error: r.error ? String(r.error) : undefined });
            if (!r.success) {
              const code = r.error?.code ?? String(r.error);
              if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
                failedTokens.push(tokens[i]);
              }
            }
          });
        } else if (messaging && typeof messaging.sendMulticast === "function") {
          const sendRes = await messaging.sendMulticast(multicastMessage);
          notificationResult.successCount = sendRes.successCount ?? 0;
          notificationResult.failureCount = sendRes.failureCount ?? 0;
          (sendRes.responses ?? []).forEach((r: any, i: number) => {
            notificationResult.responses.push({ success: !!r.success, error: r.error ? String(r.error) : undefined });
            if (!r.success) {
              const code = r.error?.code ?? String(r.error);
              if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
                failedTokens.push(tokens[i]);
              }
            }
          });
        } else if (messaging && typeof messaging.sendToDevice === "function") {
          const sendRes = await messaging.sendToDevice(tokens, legacyPayload);
          const results = sendRes.results ?? sendRes.responses ?? sendRes;
          let successCount = 0;
          let failureCount = 0;
          (results ?? []).forEach((r: any, i: number) => {
            if (r && r.error) {
              failureCount++;
              const code = r.error.code ?? String(r.error);
              notificationResult.responses.push({ success: false, error: code });
              if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
                failedTokens.push(tokens[i]);
              }
            } else {
              successCount++;
              notificationResult.responses.push({ success: true });
            }
          });
          notificationResult.successCount = successCount;
          notificationResult.failureCount = failureCount;
        } else {
          notificationResult = { note: "Firebase messaging not available on server." };
        }

        // prune invalid tokens from client doc if applicable
        if (failedTokens.length > 0 && clientDoc && clientDoc._id) {
          try {
            if (Array.isArray((clientDoc as any).fcmTokens)) {
              await User.updateOne({ _id: clientDoc._id }, { $pull: { fcmTokens: { $in: failedTokens } } }).exec();
              notificationResult.removedInvalidTokens = failedTokens;
            } else if ((clientDoc as any).fcmToken && failedTokens.includes((clientDoc as any).fcmToken)) {
              await User.updateOne({ _id: clientDoc._id }, { $unset: { fcmToken: 1 } }).exec();
              notificationResult.removedInvalidTokens = failedTokens;
            }
          } catch (e) {
            notificationResult.removeError = String(e);
          }
        }
      }
    } catch (notifErr) {
      console.error("Failed to send tracking notification:", notifErr);
      notificationResult = { error: notifErr instanceof Error ? notifErr.message : String(notifErr) };
    }

    return res.status(200).json({
      success: true,
      message: "Tracking updated.",
      booking: populated,
      notification: notificationResult,
    });
  } catch (err) {
    console.error("POST /:id/track error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: (err as Error).message });
  }
});

router.get("/by-business/:businessId", async (req: Request, res: Response) => {
  try {
    const { businessId } = req.params;
    const { page = "1", limit = "20", status, dateFrom, dateTo } = req.query;

    if (!businessId || !mongoose.isValidObjectId(businessId)) {
      return res
        .status(400)
        .json({ message: "Invalid or missing businessId." });
    }

    // Optional: verify business exists (we return its operatingSchedule)
    const businessExists = await BusinessInfo.findById(businessId)
      .select("_id operatingSchedule businessName")
      .lean()
      .exec();
    if (!businessExists) {
      return res.status(404).json({ message: "Business not found." });
    }

    const pg = Math.max(parseInt(String(page), 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(String(limit), 10) || 20, 1), 200);

    const qry: any = { businessId: new mongoose.Types.ObjectId(businessId) };

    // status filter (accept comma-separated)
    if (status) {
      const statuses = String(status)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (statuses.length === 1) {
        qry.status = statuses[0];
      } else if (statuses.length > 1) {
        qry.status = { $in: statuses };
      }
    }

    // date range filter on scheduledAt
    if (dateFrom || dateTo) {
      qry.scheduledAt = {};
      if (dateFrom) {
        const df = new Date(String(dateFrom));
        if (!Number.isNaN(df.getTime())) qry.scheduledAt.$gte = df;
      }
      if (dateTo) {
        const dt = new Date(String(dateTo));
        if (!Number.isNaN(dt.getTime())) qry.scheduledAt.$lte = dt;
      }
      if (Object.keys(qry.scheduledAt).length === 0) delete qry.scheduledAt;
    }

    const total = await Booking.countDocuments(qry).exec();

    const bookings = await Booking.find(qry)
      .sort({ scheduledAt: -1, createdAt: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .populate({
        path: "clientId",
        select: "firstName lastName email phone",
        model: User,
      })
      .populate({
        path: "serviceId",
        select: "title price duration",
        model: ServiceOffered,
      })
      .lean()
      .exec();

    return res.status(200).json({
      message: "Bookings fetched.",
      total,
      page: pg,
      limit: lim,
      business: businessExists,
      bookings, // ⬅️ use converted version
    });
  } catch (err) {
    console.error("GET /bookings/by-business error:", err);
    return res
      .status(500)
      .json({ message: "Server error.", error: (err as Error).message });
  }
});

router.get("/quickbook", async (req: Request, res: Response) => {
  try {
    const { clientId, limit = "5", since } = req.query;

    if (!clientId || typeof clientId !== "string" || !mongoose.isValidObjectId(clientId)) {
      return res.status(400).json({ message: "Missing or invalid clientId query parameter." });
    }

    const lim = Math.max(1, Math.min(50, parseInt(String(limit), 10) || 5));
    const match: any = {
      clientId: new mongoose.Types.ObjectId(clientId),
      // Prefer completed. If you also want other statuses, adjust this filter.
      status: "completed",
    };

    // optional date filter: only bookings since X
    if (since && typeof since === "string") {
      const dt = new Date(since);
      if (!Number.isNaN(dt.getTime())) {
        match.scheduledAt = { $gte: dt };
      }
    }

    /**
     * Aggregation pipeline:
     * 1) match by clientId and status (and optional date)
     * 2) group by service key (serviceId if present, else serviceTitle string)
     *    and collect count, lastBooked, businessIds (to pick a sample provider)
     * 3) sort by count desc, lastBooked desc
     * 4) limit
     * 5) lookup service document (if serviceId present)
     * 6) lookup sample business info (use first businessId in array)
     * 7) projection
     */
    const pipeline: any[] = [
      { $match: match },
      // keep fields we need
      {
        $project: {
          serviceId: 1,
          serviceTitle: 1,
          businessId: 1,
          scheduledAt: 1,
        },
      },

      // group by serviceId when present, otherwise by serviceTitle
      {
        $group: {
          _id: {
            serviceId: { $ifNull: ["$serviceId", null] }, // might be ObjectId or null
            serviceTitle: { $ifNull: ["$serviceTitle", ""] }, // fallback string
          },
          count: { $sum: 1 },
          lastBooked: { $max: "$scheduledAt" },
          businessIds: { $addToSet: "$businessId" }, // to pick a sample business/provider
        },
      },

      // sort by most used first, then most recent
      { $sort: { count: -1, lastBooked: -1 } },

      // limit results
      { $limit: lim },

      // If grouped service has serviceId, populate service details from ServiceOffered
      {
        $lookup: {
          from: ServiceOffered.collection.name,
          localField: "_id.serviceId",
          foreignField: "_id",
          as: "serviceDoc",
        },
      },
      // lookup one business (sample) for provider info
      {
        $lookup: {
          from: BusinessInfo.collection.name,
          localField: "businessIds",
          foreignField: "_id",
          as: "businessDocs",
        },
      },

      // shape output
      {
        $project: {
          _id: 0,
          // prefer returning serviceId as string when exists
          serviceId: { $cond: [{ $ifNull: ["$_id.serviceId", false] }, { $toString: "$_id.serviceId" }, null] },
          // prefer serviceDoc.title if exists else grouped serviceTitle
          serviceTitle: {
            $cond: [
              { $gt: [{ $size: "$serviceDoc" }, 0] },
              { $ifNull: [{ $first: "$serviceDoc.title" }, "$_id.serviceTitle"] },
              "$_id.serviceTitle",
            ],
          },
          count: 1,
          lastBooked: 1,
          // include a short service object (first serviceDoc) if available
          service: { $arrayElemAt: ["$serviceDoc", 0] },
          // choose first business doc (if exists) as sample provider
          sampleBusiness: { $arrayElemAt: ["$businessDocs", 0] },
          businessCount: { $size: "$businessIds" },
        },
      },
    ];

    const agg = await Booking.aggregate(pipeline).allowDiskUse(true).exec();

    // Convert ObjectIds to strings where necessary in nested docs (lean lookups are plain objects)
    const items = agg.map((it: any) => {
      const out: any = {
        serviceId: it.serviceId || null,
        serviceTitle: it.serviceTitle || "",
        count: it.count || 0,
        lastBooked: it.lastBooked ? new Date(it.lastBooked).toISOString() : null,
        businessCount: it.businessCount || 0,
      };

      if (it.service && typeof it.service === "object") {
        out.service = {
          id: it.service._id ? String(it.service._id) : null,
          title: it.service.title ?? it.serviceTitle ?? null,
          price: it.service.price ?? null,
          duration: it.service.duration ?? null,
          raw: it.service,
        };
      }

      if (it.sampleBusiness && typeof it.sampleBusiness === "object") {
        out.sampleBusiness = {
          id: it.sampleBusiness._id ? String(it.sampleBusiness._id) : null,
          businessName: it.sampleBusiness.businessName ?? it.sampleBusiness.title ?? null,
          logo: it.sampleBusiness.logo ?? null,
          location: it.sampleBusiness.location ?? null,
          raw: it.sampleBusiness,
        };
      }

      return out;
    });

    return res.status(200).json({
      message: "Quick-book items fetched.",
      items,
      count: items.length,
    });
  } catch (err) {
    console.error("GET /client/quickbook error:", err);
    return res.status(500).json({ message: "Server error.", error: (err as Error).message });
  }
});


export default router;
