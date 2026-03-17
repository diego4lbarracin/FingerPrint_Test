const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

require("dotenv").config();

const app = express();
const port = Number(process.env.PORT || 4000);
const matchThreshold = Number(process.env.MATCH_THRESHOLD || 0.72);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env",
  );
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin)
      ) {
        return callback(null, true);
      }
      return callback(new Error("Origin not allowed by CORS"));
    },
  }),
);
app.use(express.json({ limit: "2mb" }));

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function toBase64(input) {
  const normalized = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding
    ? `${normalized}${"=".repeat(4 - padding)}`
    : normalized;
  return padded;
}

function decodeSampleData(base64UrlData) {
  return Buffer.from(toBase64(base64UrlData), "base64");
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function buildBigrams(buffer) {
  const set = new Set();
  if (buffer.length < 2) return set;
  for (let i = 0; i < buffer.length - 1; i += 1) {
    set.add((buffer[i] << 8) | buffer[i + 1]);
  }
  return set;
}

function jaccardSimilarity(leftSet, rightSet) {
  if (leftSet.size === 0 || rightSet.size === 0) return 0;

  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }

  const union = leftSet.size + rightSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function compareTemplates(probeTemplate, enrolledTemplate) {
  if (!probeTemplate || !enrolledTemplate) return 0;
  if (probeTemplate === enrolledTemplate) return 1;

  try {
    const probe = decodeSampleData(probeTemplate);
    const enrolled = decodeSampleData(enrolledTemplate);

    if (probe.length === 0 || enrolled.length === 0) return 0;

    const probeBigrams = buildBigrams(probe);
    const enrolledBigrams = buildBigrams(enrolled);
    const bigramScore = jaccardSimilarity(probeBigrams, enrolledBigrams);

    const lengthScore =
      Math.min(probe.length, enrolled.length) /
      Math.max(probe.length, enrolled.length);

    const sampleWindow = Math.min(128, probe.length, enrolled.length);
    let alignedBytes = 0;
    for (let i = 0; i < sampleWindow; i += 1) {
      if (probe[i] === enrolled[i]) alignedBytes += 1;
    }
    const localAlignmentScore =
      sampleWindow > 0 ? alignedBytes / sampleWindow : 0;

    return 0.6 * bigramScore + 0.25 * lengthScore + 0.15 * localAlignmentScore;
  } catch {
    return 0;
  }
}

function extractPrimarySample(fingerprintPayload) {
  if (
    !fingerprintPayload ||
    !Array.isArray(fingerprintPayload.samples) ||
    fingerprintPayload.samples.length === 0
  ) {
    throw new Error("Fingerprint sample is required");
  }

  const firstSample = fingerprintPayload.samples[0];
  if (
    !firstSample ||
    typeof firstSample.data !== "string" ||
    firstSample.data.length < 20
  ) {
    throw new Error("Invalid fingerprint sample data");
  }

  return {
    sampleData: firstSample.data,
    sampleFormat: Number(fingerprintPayload.sampleFormat || 2),
    deviceId: fingerprintPayload.deviceId || null,
    quality: Number.isInteger(fingerprintPayload.quality)
      ? fingerprintPayload.quality
      : null,
  };
}

function sanitizeUserResponse(user) {
  return {
    id: user.id,
    name: user.name,
    lastName: user.last_name,
    email: user.email,
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, threshold: matchThreshold });
});

app.post("/api/users/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const lastName = String(req.body.lastName || "").trim();
    const email = normalizeEmail(req.body.email);

    if (!name || !lastName || !email) {
      return res
        .status(400)
        .json({ error: "name, lastName and email are required" });
    }

    const primarySample = extractPrimarySample(req.body.fingerprint);
    const templateHash = sha256(primarySample.sampleData);

    const { data: insertedUser, error: userInsertError } = await supabase
      .from("app_users")
      .insert({
        name,
        last_name: lastName,
        email,
      })
      .select("id, name, last_name, email, created_at")
      .single();

    if (userInsertError) {
      if (userInsertError.code === "23505") {
        return res
          .status(409)
          .json({ error: "A user with this email already exists" });
      }
      throw userInsertError;
    }

    const { error: templateInsertError } = await supabase
      .from("fingerprint_templates")
      .insert({
        user_id: insertedUser.id,
        sample_format: primarySample.sampleFormat,
        template_data: primarySample.sampleData,
        template_sha256: templateHash,
        device_id: primarySample.deviceId,
        quality_code: primarySample.quality,
      });

    if (templateInsertError) {
      await supabase.from("app_users").delete().eq("id", insertedUser.id);
      throw templateInsertError;
    }

    return res.status(201).json({
      message: "User registered with fingerprint template",
      user: sanitizeUserResponse(insertedUser),
    });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Unexpected registration error" });
  }
});

app.post("/api/users/authenticate", async (req, res) => {
  try {
    const primarySample = extractPrimarySample(req.body.fingerprint);
    const probeHash = sha256(primarySample.sampleData);

    const { data: templates, error: readError } = await supabase
      .from("fingerprint_templates")
      .select(
        "id, user_id, template_data, app_users!inner(id, name, last_name, email)",
      );

    if (readError) throw readError;

    if (!templates || templates.length === 0) {
      return res
        .status(404)
        .json({
          authenticated: false,
          message: "No enrolled fingerprints found",
        });
    }

    let bestMatch = null;
    for (const row of templates) {
      const score = compareTemplates(
        primarySample.sampleData,
        row.template_data,
      );
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = {
          score,
          user: row.app_users,
        };
      }
    }

    const authenticated = Boolean(
      bestMatch && bestMatch.score >= matchThreshold,
    );

    await supabase.from("auth_attempts").insert({
      matched_user_id: authenticated ? bestMatch.user.id : null,
      probe_template_sha256: probeHash,
      match_score: bestMatch ? Number(bestMatch.score.toFixed(4)) : null,
      success: authenticated,
    });

    if (!authenticated) {
      return res.status(401).json({
        authenticated: false,
        score: bestMatch ? Number(bestMatch.score.toFixed(4)) : 0,
        threshold: matchThreshold,
        message: "Fingerprint did not match any enrolled user",
      });
    }

    return res.json({
      authenticated: true,
      score: Number(bestMatch.score.toFixed(4)),
      threshold: matchThreshold,
      user: sanitizeUserResponse(bestMatch.user),
    });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Unexpected authentication error" });
  }
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Fingerprint API running on http://localhost:${port}`);
});
