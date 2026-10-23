
import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';

import Site from '../models/Site.js';
import SiteAttendance from '../models/SiteAttendance.js';
import { authenticateMobile } from '../middleware/mobileAuth.js';
import { asyncHandler as wrap } from '../utils/asyncHandler.js';

const router = Router();

router.use(authenticateMobile);

// =====================================================
// STRICT GPS CONFIGURATION
// =====================================================

const MAX_GPS_ACCURACY_METERS = 50;
const MAX_GPS_AGE_MS = 30 * 1000;
const MAX_FUTURE_MS = 5 * 1000;
const SITE_TIME_ZONE = 'Asia/Kolkata';

// =====================================================
// INPUT VALIDATION
// =====================================================

const gpsSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracyMeters: z.number().finite().positive().max(10000),
  capturedAt: z.string().datetime({ offset: true })
}).strict();

const requestIdSchema = z.string().uuid();
// Indoor requests are unverified employee statements, never GPS evidence.
const indoorReason = z.string().trim().min(20).max(400);
const indoorCheckInSchema = z.object({
  siteId: z.string(), requestId: requestIdSchema, reason: indoorReason
}).strict();
const indoorCheckOutSchema = z.object({
  requestId: requestIdSchema, reason: indoorReason
}).strict();

const checkInSchema = gpsSchema.extend({
  siteId: z.string(),
  requestId: requestIdSchema
});

const checkOutSchema = gpsSchema.extend({
  requestId: requestIdSchema
});

// =====================================================
// DISTANCE CALCULATION
// =====================================================

function haversine(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;

  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) *
    Math.cos(lat2 * rad) *
    Math.sin(dLng / 2) ** 2;

  const bounded = Math.max(0, Math.min(1, a));

  return (
    6371000 *
    2 *
    Math.atan2(
      Math.sqrt(bounded),
      Math.sqrt(1 - bounded)
    )
  );
}

// =====================================================
// CHECK SITE MASTER GPS
// =====================================================

function getSiteGps(site) {
  const gps = site?.gps;

  if (!gps) {
    return null;
  }

  const latitude = gps.latitude;
  const longitude = gps.longitude;
  const radiusMeters = gps.radiusMeters;

  // Do not convert null to zero.
  // A missing location must never be treated as valid.
  if (
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    typeof radiusMeters !== 'number' ||
    !Number.isFinite(radiusMeters) ||
    radiusMeters < 50 ||
    radiusMeters > 10000
  ) {
    return null;
  }

  return {
    latitude,
    longitude,
    radiusMeters
  };
}

// =====================================================
// STRICT GPS VERIFICATION
// =====================================================

function validateGpsEvidence(input, site) {
  const siteGps = getSiteGps(site);

  // 1. Site coordinates must exist.
  if (!siteGps) {
    return {
      error: 'SITE_GPS_NOT_CONFIGURED',
      message:
        'Customer site GPS is not configured. Contact HR.'
    };
  }

  // 2. Phone GPS must be valid.
  if (
    !Number.isFinite(input.latitude) ||
    !Number.isFinite(input.longitude) ||
    !Number.isFinite(input.accuracyMeters) ||
    input.accuracyMeters <= 0
  ) {
    return {
      error: 'INVALID_GPS',
      message:
        'Valid GPS location is required.'
    };
  }

  // 3. Reject inaccurate readings.
  if (
    input.accuracyMeters >
    MAX_GPS_ACCURACY_METERS
  ) {
    return {
      error: 'LOW_GPS_ACCURACY',
      message:
        `GPS accuracy must be ${MAX_GPS_ACCURACY_METERS} ` +
        'metres or better. Move outdoors and retry.'
    };
  }

  // 4. Reject stale or future-dated readings.
  const capturedTime = Date.parse(input.capturedAt);
  const ageMs = Date.now() - capturedTime;

  if (
    !Number.isFinite(capturedTime) ||
    !Number.isFinite(ageMs) ||
    ageMs > MAX_GPS_AGE_MS ||
    ageMs < -MAX_FUTURE_MS
  ) {
    return {
      error: 'STALE_LOCATION',
      message:
        'GPS location is outdated. ' +
        'Capture your current location again.'
    };
  }

  // 5. Calculate distance on the server.
  const distanceMeters = haversine(
    input.latitude,
    input.longitude,
    siteGps.latitude,
    siteGps.longitude
  );

  if (!Number.isFinite(distanceMeters)) {
    return {
      error: 'INVALID_DISTANCE',
      message:
        'Unable to verify distance from customer site.'
    };
  }

  // 6. Conservative boundary verification.
  // Distance plus GPS accuracy must fit in site radius.
  if (
    distanceMeters + input.accuracyMeters >
    siteGps.radiusMeters
  ) {
    return {
      error: 'OUTSIDE_SITE_RADIUS',
      message:
        'You are outside the approved customer site. ' +
        `Distance: ${Math.round(distanceMeters)} m. ` +
        `Accuracy: ${Math.round(input.accuracyMeters)} m. ` +
        `Allowed radius: ${siteGps.radiusMeters} m.`
    };
  }

  // Valid GPS evidence.
  return {
    gps: {
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyMeters: input.accuracyMeters,
      capturedAt: new Date(capturedTime),
      distanceMeters: Math.round(distanceMeters),
      withinRadius: true
    }
  };
}

// =====================================================
// REPORTING TIME / LATENESS
// =====================================================

function calculateArrivalStatus(
  serverTime,
  reportingTime
) {
  if (
    typeof reportingTime !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(
      reportingTime
    )
  ) {
    return {
      arrivalStatus: 'UNCONFIGURED',
      lateMinutes: null
    };
  }

  const formatter = new Intl.DateTimeFormat(
    'en-GB',
    {
      timeZone: SITE_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }
  );

  const parts = formatter.formatToParts(
    serverTime
  );

  const hour = Number(
    parts.find(p => p.type === 'hour')?.value
  );

  const minute = Number(
    parts.find(p => p.type === 'minute')?.value
  );

  const [reportHour, reportMinute] =
    reportingTime.split(':').map(Number);

  const arrivalMinutes =
    hour * 60 + minute;

  const reportingMinutes =
    reportHour * 60 + reportMinute;

  const lateMinutes = Math.max(
    0,
    arrivalMinutes - reportingMinutes
  );

  return {
    arrivalStatus:
      lateMinutes > 0 ? 'LATE' : 'ON_TIME',
    lateMinutes
  };
}

// =====================================================
// RESPONSE FORMAT — KEEP ANDROID COMPATIBILITY
// =====================================================

function compact(d) {
  return {
    id: String(d._id),
    siteId: String(d.site),
    siteName: d.siteSnapshot?.name,
    siteCity: d.siteSnapshot?.city,
    checkedInAt: d.checkedInAt,
    checkedOutAt: d.checkedOutAt,
    open: d.open,
    verificationStatus: d.verificationStatus,
    reviewReasons: d.reviewReasons,
    arrivalStatus: d.arrivalStatus,
    lateMinutes: d.lateMinutes,
    reportingTime: d.reportingTime,
    checkIn: d.checkIn,
    checkOut: d.checkOut,
    checkInMethod: d.checkInMethod || 'GPS',
    checkOutMethod: d.checkOutMethod || (d.checkedOutAt ? 'GPS' : null),
    indoorCheckInReason: d.indoorCheckInReason || '',
    indoorCheckOutReason: d.indoorCheckOutReason || '' 
  };
}

// =====================================================
// GET ACTIVE SITE MASTER
// =====================================================

router.get('/sites', wrap(async (req, res) => {
  const sites = await Site.find({
    active: true
  })
    .select(
      'code customerName name city state ' +
      'address reportingTime gps active'
    )
    .sort({
      customerName: 1,
      name: 1
    })
    .lean();

  return res.json({
    sites: sites.map(site => ({
      id: String(site._id),
      code: site.code,
      customerName: site.customerName,
      name: site.name,
      city: site.city,
      state: site.state,
      address: site.address,
      reportingTime: site.reportingTime,
      radiusMeters:
        site.gps?.radiusMeters ?? 200,
      gpsConfigured:
        getSiteGps(site) !== null
    }))
  });
}));

// =====================================================
// GET CURRENT ATTENDANCE
// =====================================================

router.get(
  '/attendance/current',
  wrap(async (req, res) => {
    const attendance =
      await SiteAttendance.findOne({
        employee: req.mobileEmployee._id,
        open: true
      }).lean();

    return res.json({
      attendance: attendance
        ? compact(attendance)
        : null
    });
  })
);

// =====================================================
// GET ATTENDANCE HISTORY
// =====================================================

router.get(
  '/attendance/history',
  wrap(async (req, res) => {
    const records =
      await SiteAttendance.find({
        employee: req.mobileEmployee._id
      })
        .sort({ checkedInAt: -1 })
        .limit(60)
        .lean();

    return res.json({
      attendance: records.map(compact)
    });
  })
);

// =====================================================
// GPS CHECK-IN
// =====================================================

router.post(
  '/attendance/check-in',
  wrap(async (req, res) => {
    const parsed = checkInSchema.safeParse(
      req.body
    );

    if (!parsed.success) {
      return res.status(400).json({
        message:
          'Invalid check-in data or GPS evidence.'
      });
    }

    const input = parsed.data;

    if (!mongoose.isValidObjectId(input.siteId)) {
      return res.status(400).json({
        message: 'Invalid customer site.'
      });
    }

    const employeeId =
      req.mobileEmployee._id;

    // Repeated network request with the same ID.
    const previous =
      await SiteAttendance.findOne({
        employee: employeeId,
        checkInRequestId: input.requestId
      }).lean();

    if (previous) {
      return res.json({
        attendance: compact(previous),
        alreadyProcessed: true
      });
    }

    // Prevent second active check-in.
    const active =
      await SiteAttendance.findOne({
        employee: employeeId,
        open: true
      }).lean();

    if (active) {
      return res.status(409).json({
        message:
          'You already have an active check-in. ' +
          'Contact HR if a previous checkout was missed.',
        attendance: compact(active)
      });
    }

    const site = await Site.findOne({
      _id: input.siteId,
      active: true
    }).lean();

    if (!site) {
      return res.status(404).json({
        message:
          'Customer site not found or inactive.'
      });
    }

    // STRICT GPS CHECK BEFORE DATABASE INSERT.
    const validation =
      validateGpsEvidence(input, site);

    if (validation.error) {
      return res.status(422).json({
        code: validation.error,
        message: validation.message
      });
    }

    const gpsEvidence = validation.gps;

    // Server time — do not trust phone time
    // for official attendance timestamps.
    const serverTime = new Date();

    const punctuality =
      calculateArrivalStatus(
        serverTime,
        site.reportingTime
      );

    try {
      const attendance =
        await SiteAttendance.create({
          employee: employeeId,
          site: site._id,

          siteSnapshot: {
            code: site.code,
            name: site.name,
            city: site.city,
            radiusMeters:
              site.gps.radiusMeters
          },

          checkIn: gpsEvidence,
          checkInMethod: 'GPS',
          checkedInAt: serverTime,
          checkInRequestId: input.requestId,

          open: true,
          verificationStatus: 'PENDING',
          reviewReasons: [],

          reportingTime: site.reportingTime,
          ...punctuality
        });

      return res.status(201).json({
        attendance: compact(attendance),
        alreadyProcessed: false
      });
    } catch (error) {
      if (error.code !== 11000) {
        throw error;
      }

      const same =
        await SiteAttendance.findOne({
          employee: employeeId,
          checkInRequestId: input.requestId
        }).lean();

      if (same) {
        return res.json({
          attendance: compact(same),
          alreadyProcessed: true
        });
      }

      return res.status(409).json({
        message:
          'An active attendance already exists. ' +
          'Refresh the attendance screen.'
      });
    }
  })
);

// =====================================================
// GPS CHECK-OUT
// =====================================================

router.post(
  '/attendance/check-out',
  wrap(async (req, res) => {
    const parsed =
      checkOutSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        message:
          'Invalid checkout data or GPS evidence.'
      });
    }

    const input = parsed.data;
    const employeeId =
      req.mobileEmployee._id;

    // Idempotency for repeated checkout requests.
    const previous =
      await SiteAttendance.findOne({
        employee: employeeId,
        checkOutRequestId: input.requestId
      }).lean();

    if (previous) {
      return res.json({
        attendance: compact(previous),
        alreadyProcessed: true
      });
    }

    const active =
      await SiteAttendance.findOne({
        employee: employeeId,
        open: true
      }).lean();

    if (!active) {
      return res.status(409).json({
        message:
          'No active check-in found.'
      });
    }

    const site =
      await Site.findById(
        active.site
      ).lean();

    // STRICT GPS CHECK FOR CHECKOUT.
    const validation =
      validateGpsEvidence(input, site);

    if (validation.error) {
      return res.status(422).json({
        code: validation.error,
        message: validation.message
      });
    }

    const serverTime = new Date();

    const updated =
      await SiteAttendance.findOneAndUpdate(
        {
          _id: active._id,
          employee: employeeId,
          open: true
        },
        {
          $set: {
            open: false,
            checkOut: validation.gps,
            checkOutMethod: 'GPS',
            checkedOutAt: serverTime,
            checkOutRequestId: input.requestId,

            verificationStatus: 'PENDING',
            reviewedBy: null,
            reviewedAt: null,
            reviewNote: ''
          }
        },
        {
          new: true
        }
      );

    if (!updated) {
      const same =
        await SiteAttendance.findOne({
          employee: employeeId,
          checkOutRequestId: input.requestId
        }).lean();

      if (same) {
        return res.json({
          attendance: compact(same),
          alreadyProcessed: true
        });
      }

      return res.status(409).json({
        message:
          'Attendance already checked out. ' +
          'Refresh attendance history.'
      });
    }

    return res.json({
      attendance: compact(updated),
      alreadyProcessed: false
    });
  })
);

// =====================================================
// INDOOR EXCEPTION REQUESTS — NOT GPS-VERIFIED
// The employee states they are on site; HR must independently
// verify before approving the completed attendance record.
// =====================================================

router.post('/attendance/indoor-check-in', wrap(async (req, res) => {
  const parsed = indoorCheckInSchema.safeParse(req.body);
  if (!parsed.success || !mongoose.isValidObjectId(parsed.data?.siteId))
    return res.status(400).json({ message: 'Select a valid site and provide a reason of 20-400 characters.' });
  const { siteId, requestId, reason } = parsed.data;
  const employeeId = req.mobileEmployee._id;

  const previous = await SiteAttendance.findOne({ employee: employeeId, checkInRequestId: requestId }).lean();
  if (previous) return res.json({ attendance: compact(previous), alreadyProcessed: true });
  const active = await SiteAttendance.findOne({ employee: employeeId, open: true }).lean();
  if (active) return res.status(409).json({ message: 'An active visit exists. Check out or contact HR.', attendance: compact(active) });
  const site = await Site.findOne({ _id: siteId, active: true }).lean();
  if (!site) return res.status(404).json({ message: 'Site is inactive or does not exist.' });
  const serverTime = new Date();
  try {
    const attendance = await SiteAttendance.create({
      employee: employeeId, site: site._id,
      siteSnapshot: { code: site.code, name: site.name, city: site.city, radiusMeters: site.gps?.radiusMeters },
      checkIn: null, checkInMethod: 'HR_EXCEPTION', indoorCheckInReason: reason,
      checkedInAt: serverTime, checkInRequestId: requestId,
      open: true, verificationStatus: 'PENDING',
      reviewReasons: ['INDOOR_CHECK_IN_UNVERIFIED'],
      reportingTime: site.reportingTime,
      ...calculateArrivalStatus(serverTime, site.reportingTime)
    });
    return res.status(201).json({ attendance: compact(attendance), alreadyProcessed: false,
      message: 'Indoor check-in request recorded; location NOT verified. HR review required.' });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const same = await SiteAttendance.findOne({ employee: employeeId, checkInRequestId: requestId }).lean();
    if (same) return res.json({ attendance: compact(same), alreadyProcessed: true });
    return res.status(409).json({ message: 'An attendance record already exists. Refresh.' });
  }
}));

router.post('/attendance/indoor-check-out', wrap(async (req, res) => {
  const parsed = indoorCheckOutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Provide a reason of 20-400 characters.' });
  const { requestId, reason } = parsed.data;
  const employeeId = req.mobileEmployee._id;
  const previous = await SiteAttendance.findOne({ employee: employeeId, checkOutRequestId: requestId }).lean();
  if (previous) return res.json({ attendance: compact(previous), alreadyProcessed: true });
  const updated = await SiteAttendance.findOneAndUpdate(
    { employee: employeeId, open: true },
    {
      $set: {
        open: false, checkedOutAt: new Date(), checkOut: null,
        checkOutMethod: 'HR_EXCEPTION', indoorCheckOutReason: reason,
        checkOutRequestId: requestId, verificationStatus: 'PENDING',
        reviewedBy: null, reviewedAt: null, reviewNote: ''
      },
      $addToSet: { reviewReasons: 'INDOOR_CHECK_OUT_UNVERIFIED' }
    }, { new: true }
  );
  if (!updated) {
    const same = await SiteAttendance.findOne({ employee: employeeId, checkOutRequestId: requestId }).lean();
    if (same) return res.json({ attendance: compact(same), alreadyProcessed: true });
    return res.status(409).json({ message: 'No active check-in. Refresh before retrying.' });
  }
  return res.json({ attendance: compact(updated), alreadyProcessed: false,
    message: 'Indoor checkout request recorded; location NOT verified. HR review required.' });
}));

export default router;
