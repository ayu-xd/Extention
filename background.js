const SUPABASE_URL = "https://pkzkoixryggxktaybwkp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBremtvaXhyeWdneGt0YXlid2twIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2MDQ2MDQsImV4cCI6MjA5MjE4MDYwNH0.G21RTb9scU7biERl1HqKQYOCUYV4pKStKF9Ls4lo8rY";

importScripts("assets/imageStorage.js");

let state = {
  accessToken: null,
  refreshToken: null,
  browserId: null,
  browserLabel: null,
  instanceKey: null,
  lastSessionSync: 0,
  stats: { completed: 0, failed: 0 },
  isProcessing: false,
  processingLockAcquiredAt: 0,
  mainTabId: null,
  additionalTabId: null,
  lastTaskCompletedAt: 0,
  emptyPollCount: 0
};

async function persistDebugLog(msg) {
  try {
    const stored = await chrome.storage.local.get('engineLogs');
    const entry = `<div>[${new Date().toLocaleTimeString()}] ${escapeHtml(String(msg))}</div>`;
    const logHtml = (stored.engineLogs || '') + entry;
    const entries = logHtml.match(/<div>/g) || [];
    let updated = logHtml;

    if (entries.length > 500) {
      const parts = logHtml.split(/(?=<div>)/).filter(Boolean);
      updated = parts.slice(-500).join('');
    }

    await chrome.storage.local.set({ engineLogs: updated });
  } catch (e) {
    console.warn('Failed to persist debug log:', e);
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function debugLog(msg) {
  persistDebugLog(msg).catch(()=>{});
  chrome.runtime.sendMessage({ type: "DEBUG_LOG", msg }).catch(()=>null);
}

async function syncStatsFromDatabase() {
  if (!state.browserId) return state.stats;

  try {
    const rows = await supabaseReq(`dm_tasks?select=id,status&browser_instance_id=eq.${state.browserId}&status=in.(completed,failed)`);
    const stats = (rows || []).reduce((acc, row) => {
      if (row.status === 'completed') acc.completed += 1;
      if (row.status === 'failed') acc.failed += 1;
      return acc;
    }, { completed: 0, failed: 0 });

    state.stats = stats;
    await chrome.storage.local.set({ stats });
    chrome.runtime.sendMessage({ type: "STATS_UPDATE", stats }).catch(()=>null);
    return stats;
  } catch (err) {
    debugLog(`Stats sync error: ${err.message}`);
    return state.stats;
  }
}

// ---------------------------------------------------------------------------
// Supabase REST Client
// ---------------------------------------------------------------------------
async function supabaseReq(path, method = "GET", body = null, _retried = false) {
  const headers = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${state.accessToken ? state.accessToken : SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation"
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, options);
  if (res.status === 401 && !_retried && state.refreshToken) {
    debugLog("Token expired, refreshing...");
    const refreshed = await refreshAccessToken();
    if (refreshed) return supabaseReq(path, method, body, true);
  }
  if (!res.ok) {
    throw new Error(`Supabase error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Upsert (POST ...?on_conflict=...) with merge-duplicates. Used for the new
// per-account `contact_account_outreach` table so re-sending state for the same
// (contact, browser) pair updates instead of erroring on the unique constraint.
async function supabaseUpsert(path, body, onConflict, _retried = false) {
  const headers = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${state.accessToken ? state.accessToken : SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=representation"
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}?on_conflict=${onConflict}`, {
    method: "POST", headers, body: JSON.stringify(body)
  });
  if (res.status === 401 && !_retried && state.refreshToken) {
    debugLog("Token expired, refreshing...");
    const refreshed = await refreshAccessToken();
    if (refreshed) return supabaseUpsert(path, body, onConflict, true);
  }
  if (!res.ok) {
    throw new Error(`Supabase upsert error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Dual-write: mirror per-account outreach state into contact_account_outreach.
// Non-fatal by design — the global `contacts` write is still the source of truth
// in Phase 1, so a failure here must never break a send.
async function caoUpsert(contactId, fields) {
  try {
    if (!contactId || !state.browserId) return;
    const userId = getUserIdFromToken(state.accessToken);
    if (!userId) return;
    await supabaseUpsert(
      "contact_account_outreach",
      {
        user_id: userId,
        contact_id: contactId,
        browser_instance_id: state.browserId,
        updated_at: new Date().toISOString(),
        ...fields
      },
      "contact_id,browser_instance_id"
    );
  } catch (err) {
    debugLog(`[CAO] dual-write failed (non-fatal): ${err.message}`);
  }
}

async function refreshAccessToken() {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: state.refreshToken })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || "Refresh failed");
    state.accessToken = data.access_token;
    state.refreshToken = data.refresh_token;
    await chrome.storage.local.set({ accessToken: state.accessToken, refreshToken: state.refreshToken });
    // Clear any previous session-expired flag
    await chrome.storage.local.remove('sessionExpired');
    debugLog("Token refreshed!");
    return true;
  } catch (err) {
    debugLog(`Refresh failed: ${err.message}`);
    // Session honesty: mark as expired so the popup shows "Reconnect"
    // instead of a fake "Online" state. Clear tokens but keep browserId
    // so re-sync can re-adopt the same browser row.
    state.accessToken = null;
    state.refreshToken = null;
    await chrome.storage.local.set({ sessionExpired: true });
    await chrome.storage.local.remove(['accessToken', 'refreshToken']);
    stopEngine();
    chrome.runtime.sendMessage({ type: "HUB_SESSION_EXPIRED" }).catch(()=>null);
    debugLog("[Session] Marked as expired. Popup will show Reconnect screen.");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Extension Core Logic
// ---------------------------------------------------------------------------

async function init() {
  const data = await chrome.storage.local.get(['accessToken', 'refreshToken', 'browserId', 'browserLabel', 'instanceKey', 'stats', 'mainTabId', 'additionalTabId', 'enginePaused']);
  if (data.accessToken) state.accessToken = data.accessToken;
  if (data.refreshToken) state.refreshToken = data.refreshToken;
  if (data.browserId) state.browserId = data.browserId;
  if (data.browserLabel) state.browserLabel = data.browserLabel;
  if (data.instanceKey) state.instanceKey = data.instanceKey;
  if (data.stats) state.stats = data.stats;
  if (data.mainTabId) state.mainTabId = data.mainTabId;
  if (data.additionalTabId) state.additionalTabId = data.additionalTabId;

  // Heartbeat runs 24/7 — even when paused — so the web app knows the browser is online.
  // Clear any stale leaseExpiresAt so the first write after restart always goes through,
  // preventing browsers from showing Offline after a reload or DB migration.
  if (state.browserId) {
    chrome.alarms.create("engine_heartbeat", { periodInMinutes: 1 });
    await chrome.storage.local.remove('leaseExpiresAt');
    sendHeartbeat(true).catch(()=>{});
  }

  if (data.enginePaused) {
    debugLog("[Init] Engine is paused, skipping task engine auto-start.");
    return;
  }

  if (state.refreshToken && state.browserId) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      startEngine();
      await syncStatsFromDatabase();
    }
  } else if (state.accessToken && state.browserId) {
    startEngine();
    await syncStatsFromDatabase();
  }
}

async function handleLogin(email, password) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    
    if (!res.ok) throw new Error(data.error_description || data.msg || "Authentication failed");
    
    state.accessToken = data.access_token;
    state.refreshToken = data.refresh_token;
    await chrome.storage.local.set({ accessToken: state.accessToken, refreshToken: state.refreshToken });

    chrome.runtime.sendMessage({ type: "HUB_LOGIN_SUCCESS" }).catch(()=>null);
  } catch(err) {
    chrome.runtime.sendMessage({ type: "HUB_LOGIN_ERROR", error: err.message }).catch(()=>null);
  }
}

function getUserIdFromToken(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload).sub;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auto-Pair: create or adopt a browser_instances row without user input.
// Called after session sync or login. RLS permits owner-scoped inserts.
// Handles UNIQUE(ig_username) conflicts by adopting the existing row.
// ---------------------------------------------------------------------------

function generateInstanceKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let key = "";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) key += "-";
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

// Ensures this browser has a STABLE instance_key persisted in chrome.storage.
// The key (not row count) is the identity of "this physical browser": it lets us
// tell apart "the same machine reconnecting" (same key → adopt) from "a new
// distinct browser" (different key → always create a fresh row).
async function ensureInstanceKey() {
  if (state.instanceKey) return state.instanceKey;
  let stored = null;
  try {
    stored = (await chrome.storage.local.get('instanceKey')).instanceKey || null;
  } catch (e) {}
  if (stored) {
    state.instanceKey = stored;
    return stored;
  }
  const key = generateInstanceKey();
  state.instanceKey = key;
  try {
    await chrome.storage.local.set({ instanceKey: key });
  } catch (e) {}
  debugLog(`[AutoPair] Created persistent instance key: ${key}`);
  return key;
}

async function autoPairBrowser() {
  if (state.browserId) {
    debugLog("[AutoPair] Already paired — skipping.");
    return;
  }

  const userId = getUserIdFromToken(state.accessToken);
  if (!userId) {
    debugLog("[AutoPair] No valid token — cannot pair.");
    return;
  }

  try {
    // This browser's stable identity. Whoever owns this key owns the row.
    const myKey = await ensureInstanceKey();

    // Fetch this user's existing rows (including instance_key) so we can
    // tell a re-adopt (same key) apart from a brand-new browser (new key).
    const existing = await supabaseReq(
      `browser_instances?user_id=eq.${userId}&select=id,label,instance_key,ig_username&order=created_at.desc`
    );
    const mine = (existing || []).find(r => r.instance_key === myKey);

    if (mine) {
      // Same key = this same extension reconnecting → adopt this row.
      state.browserId = mine.id;
      state.browserLabel = mine.label || "Browser";
      await chrome.storage.local.set({
        browserId: state.browserId,
        browserLabel: state.browserLabel,
      });
      debugLog(`[AutoPair] Adopted same-instance browser: ${mine.label} (${mine.id})`);
    } else {
      // No row matches our key → this is a NEW distinct browser. Create one.
      // A different key on an existing row is NOT ours to reuse.
      let key = myKey;
      let inserted = null;
      try {
        inserted = await supabaseReq(
          `browser_instances`,
          "POST",
          {
            user_id: userId,
            instance_key: key,
            label: "Chrome",
            status: "active",
          }
        );
      } catch (insertErr) {
        // If 23505 on instance_key (rare collision), retry with new key
        if (String(insertErr).includes("duplicate") || String(insertErr).includes("23505")) {
          debugLog("[AutoPair] Key collision — retrying with new key.");
          const key2 = generateInstanceKey();
          key = key2;
          state.instanceKey = key2;
          await chrome.storage.local.set({ instanceKey: key2 });
          try {
            inserted = await supabaseReq(
              `browser_instances`,
              "POST",
              { user_id: userId, instance_key: key2, label: "Chrome", status: "active" }
            );
          } catch (retryErr) {
            throw new Error(`Auto-pair retry failed: ${retryErr}`);
          }
        } else {
          throw new Error(`Auto-pair insert failed: ${insertErr}`);
        }
      }

      if (inserted && inserted.length > 0) {
        state.browserId = inserted[0].id;
        state.browserLabel = "Chrome";
      }

      await chrome.storage.local.set({
        browserId: state.browserId,
        browserLabel: state.browserLabel,
      });
      debugLog(`[AutoPair] Created new browser: ${state.browserId}`);
    }

    // Start the engine + heartbeat
    await syncStatsFromDatabase();
    startEngine();
    await chrome.storage.local.remove('leaseExpiresAt');
    _workHoursCache = null;
    sendHeartbeat(true).catch(()=>{});
    chrome.runtime.sendMessage({ type: "HUB_CONNECTED_SUCCESS", label: state.browserLabel, stats: state.stats }).catch(()=>null);
  } catch (err) {
    debugLog(`[AutoPair] Error: ${err.message}`);
    chrome.runtime.sendMessage({ type: "HUB_CONNECTED_ERROR", error: err.message }).catch(()=>null);
  }
}

async function fetchBrowsers() {
  try {
    const userId = getUserIdFromToken(state.accessToken);
    if (!userId) {
      debugLog("Cannot fetch browsers: invalid or missing token");
      chrome.runtime.sendMessage({ type: "FETCH_BROWSERS_SUCCESS", browsers: [] }).catch(()=>null);
      return;
    }
    const browsers = await supabaseReq(`browser_instances?user_id=eq.${userId}&select=id,label,instance_key&order=created_at.desc`);
    const list = browsers || [];

    // Only surface rows that belong to THIS physical browser (same instance_key),
    // so a user can't accidentally pick a row owned by another machine.
    const myKey = await ensureInstanceKey();
    const own = list.filter(b => b.instance_key === myKey);

    // Legacy fallback: if we have NO own-key row yet (e.g. paired before this
    // fix, so the key was never stored), show all rows so the user can still
    // pick one. handleConnect will adopt the chosen row's key.
    const result = own.length > 0 ? own : list;

    chrome.runtime.sendMessage({ type: "FETCH_BROWSERS_SUCCESS", browsers: result }).catch(()=>null);
  } catch (err) {
    debugLog(`Fetch browsers error: ${err.message}`);
  }
}

async function handleConnect(browserId, browserLabel) {
  if (!browserId) {
    chrome.runtime.sendMessage({ type: "HUB_CONNECTED_ERROR", error: "No browser ID provided" }).catch(()=>null);
    return;
  }
  if (browserId.startsWith("MANUAL_KEY:")) {
    const manualKey = browserId.split(":")[1];
    debugLog(`Resolving manual key ${manualKey}...`);
    try {
      const res = await supabaseReq(`browser_instances?instance_key=eq.${manualKey}&select=id`);
      if (res && res.length > 0) {
        browserId = res[0].id;
        debugLog(`Resolved manually!`);
      } else {
        throw new Error("Pairing key not found in DB");
      }
    } catch (err) {
      debugLog(`Resolve Error: ${err.message}`);
      chrome.runtime.sendMessage({ type: "HUB_CONNECTED_ERROR", error: err.message }).catch(()=>null);
      return;
    }
  }

  try {
    state.browserId = browserId;
    state.browserLabel = browserLabel;
    state.stats = { completed: 0, failed: 0 };

    // Adopt the connected row's instance_key so THIS browser owns it going
    // forward. This keeps auto-pair, the dropdown filter, and IG-detection all
    // key-consistent. If the row has no key yet, generate one and stamp it.
    const myKey = await ensureInstanceKey();
    try {
      const rows = await supabaseReq(`browser_instances?select=id,instance_key&eq.id.${browserId}`);
      const row = rows && rows[0];
      if (row && row.instance_key && row.instance_key !== myKey) {
        // The user explicitly chose this row — claim it as this browser.
        state.instanceKey = row.instance_key;
        await chrome.storage.local.set({ instanceKey: row.instance_key });
        debugLog(`[Connect] Adopted instance key ${row.instance_key} for row ${browserId}`);
      } else if (row && !row.instance_key) {
        // Row has no key — stamp ours onto it.
        await supabaseReq(`browser_instances?id=eq.${browserId}`, "PATCH", { instance_key: myKey });
        debugLog(`[Connect] Stamped instance key ${myKey} onto un-keyed row ${browserId}`);
      }
    } catch (adoptErr) {
      debugLog(`[Connect] Note: could not sync instance_key (${adoptErr.message})`);
    }

    await chrome.storage.local.set({ 
      browserId: state.browserId, 
      browserLabel: state.browserLabel,
      stats: state.stats 
    });

    await syncStatsFromDatabase();

    startEngine();
    await chrome.storage.local.remove('leaseExpiresAt');
    _workHoursCache = null; // invalidate working-hours cache on new connection
    sendHeartbeat(true).catch(()=>{});
    chrome.runtime.sendMessage({ type: "HUB_CONNECTED_SUCCESS", label: state.browserLabel, stats: state.stats }).catch(()=>null);
  } catch (err) {
    debugLog(`Connect error: ${err.message}`);
    chrome.runtime.sendMessage({ type: "HUB_CONNECTED_ERROR", error: err.message }).catch(()=>null);
  }
}

async function startEngine() {
  stopEngine();
  console.log(`Starting Engine with Browser ID: ${state.browserId}`);
  debugLog(`Engine started for ${state.browserLabel}`);

  // Reset any tasks stuck in "processing" back to "pending" (crash recovery)
  if (state.browserId) {
    try {
      const stale = await supabaseReq(`dm_tasks?browser_instance_id=eq.${state.browserId}&status=eq.processing`, "PATCH", { status: "pending" });
      if (stale && stale.length > 0) {
        debugLog(`[Recovery] Reset ${stale.length} stuck processing task(s) back to pending`);
      }
    } catch (err) {
      debugLog(`[Recovery] Failed to reset stale tasks: ${err.message}`);
    }
  }

  // Create alarms for the Manifest V3 background script.
  // Heartbeat must ALWAYS be scheduled whenever a browser is active — the auto-pair
  // flow never passes through init(), and init() only creates it if a browserId was
  // already present at boot. Creating here guarantees the 24/7 heartbeat alarm exists
  // on every connect/pair. (alarms.create is idempotent: same name replaces.)
  chrome.alarms.create("engine_heartbeat", { periodInMinutes: 1 }); // Every 1 min keep-alive
  chrome.alarms.create("engine_poll", { periodInMinutes: 0.25 }); // 15 seconds
  chrome.alarms.create("engine_refresh_token", { periodInMinutes: 45 }); // Refresh JWT every 45 min
  chrome.alarms.create("engine_collect_messages", { periodInMinutes: 2 }); // Every 2 min read-receipt check

  // Trigger initial runs
  pollTasks();
}

function stopEngine() {
  // NOTE: engine_heartbeat is NOT cleared here — it runs 24/7 so the web app knows the browser is online
  chrome.alarms.clear("engine_poll");
  chrome.alarms.clear("engine_refresh_token");
  chrome.alarms.clear("engine_collect_messages");
  console.log("Engine stopped.");
}

// Listen to alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "engine_heartbeat") {
    sendHeartbeat().catch(()=>{});
    // Self-heal: if we have a browserId, aren't paused, but the engine_poll
    // alarm doesn't exist (e.g. refresh failed at init → engine never started),
    // restart the engine now. This recovers from the "engine dead" gap.
    if (state.browserId && state.accessToken) {
      const paused = await chrome.storage.local.get('enginePaused');
      if (!paused.enginePaused) {
        const pollAlarm = await chrome.alarms.get('engine_poll');
        if (!pollAlarm) {
          debugLog("[Self-Heal] engine_poll alarm missing but browser is active — restarting engine.");
          startEngine();
        }
      }
    }
  } else if (alarm.name === "engine_poll") {
    pollTasks().catch(()=>{});
  } else if (alarm.name === "engine_refresh_token") {
    // Only refresh if the web app is NOT open (it owns the token when it is).
    // The webapp-content.js fires HUB_SESSION_SYNCED every 2s while open,
    // which updates state.accessToken. If we also refresh, we risk a
    // rotation collision that kills the token family.
    if (Date.now() - (state.lastSessionSync || 0) > 15000) {
      refreshAccessToken().catch(()=>{});
    } else {
      debugLog("[Token] Skipping extension refresh — web app is open (it owns the token).");
    }
  } else if (alarm.name === "engine_collect_messages") {
    collectMessagesJob().catch(()=>{});
  }
});

async function collectMessagesJob() {
  if (!state.browserId || state.isProcessing) return;
  const pauseData = await chrome.storage.local.get('enginePaused');
  if (pauseData.enginePaused) return;
  if (!state.mainTabId) return;

  if (state.lastTaskCompletedAt && Date.now() - state.lastTaskCompletedAt < 60000) {
    debugLog("[Collector] Skipping — a DM was sent less than 60s ago, waiting for Instagram to settle.");
    return;
  }

  try {
    debugLog("[Collector] Running periodic read-receipt check via React Fiber...");
    await chrome.tabs.sendMessage(state.mainTabId, {
      type: "adblock:info:to-content",
      isEmit: true,
      data: { type: "collectMessages", data: {} }
    }).catch(() => null);
  } catch (err) {
    debugLog(`[Collector] Error triggering collectMessages: ${err.message}`);
  }
}

async function processCollectedMessages(readReceipts) {
  try {
    if (!Array.isArray(readReceipts) || readReceipts.length === 0) return;

    const seenUsernames = new Set();
    const repliedUsernames = new Set();
    let seenCount = 0;
    let replyCount = 0;

    for (const entry of readReceipts) {
      if (!entry || !entry.username) continue;

      if (entry.hasSeen || entry.hasReply) {
        seenUsernames.add(entry.username.toLowerCase());
        if (entry.hasSeen) seenCount++;
        if (entry.hasReply) {
          replyCount++;
          repliedUsernames.add(entry.username.toLowerCase());
        }
      }
    }

    if (seenUsernames.size > 0) {
      const userList = Array.from(seenUsernames);
      debugLog(`[Collector] Found ${userList.length} contact(s) — ${seenCount} seen, ${replyCount} replied.`);

      for (let i = 0; i < userList.length; i += 50) {
        const chunk = userList.slice(i, i + 50);
        const inQuery = chunk.map(u => `"${u}"`).join(",");
        await supabaseReq(
          `contacts?media_seen=eq.false&username=in.(${inQuery})`,
          "PATCH",
          { media_seen: true, media_seen_at: new Date().toISOString() }
        );
        // Dual-write per-account seen state. The seen/reply came from THIS
        // browser's logged-in IG account, so it belongs to (contact, thisBrowser).
        try {
          const seenContacts = await supabaseReq(`contacts?select=id&username=in.(${inQuery})`);
          for (const c of (seenContacts || [])) {
            await caoUpsert(c.id, { media_seen: true, media_seen_at: new Date().toISOString() });
          }
        } catch (e) {
          debugLog(`[CAO] seen dual-write failed (non-fatal): ${e.message}`);
        }
      }
    }

    // Leads who replied: proactively cancel their remaining follow-ups so we never
    // DM someone who already responded — the belt-and-suspenders behind the send-time guard.
    if (repliedUsernames.size > 0) {
      const repliedList = Array.from(repliedUsernames);
      for (let i = 0; i < repliedList.length; i += 50) {
        const chunk = repliedList.slice(i, i + 50);
        const inQuery = chunk.map(u => `"${u}"`).join(",");
        const contacts = await supabaseReq(`contacts?select=id&username=in.(${inQuery})`);
        for (const contact of (contacts || [])) {
          // Persist the reply (global + per-account) so the scheduler stops
          // generating ghost follow-ups for this lead. NOT media_seen — this is
          // a genuine reply detected from the Relay store.
          try {
            await supabaseReq(`contacts?id=eq.${contact.id}`, "PATCH",
              { replied: true, replied_at: new Date().toISOString() });
          } catch (e) { debugLog(`[Replied] global persist failed (non-fatal): ${e.message}`); }
          await caoUpsert(contact.id, { replied: true, replied_at: new Date().toISOString() });
          await cancelPendingFollowups(contact.id, "lead_replied");
        }
      }
    }
  } catch (err) {
    debugLog(`[Collector] Error processing collected messages: ${err.message}`);
  }
}

// Cancel any still-pending follow-up tasks for a contact (e.g. after they replied).
// Only touches 'pending' rows — an in-flight 'processing' task is left alone.
// Cross-account fix: scoped by browser_instance_id so a reply received by THIS
// account only cancels THIS account's follow-ups — never another account's.
async function cancelPendingFollowups(contactId, reason) {
  if (!contactId) return 0;
  try {
    const browserFilter = state.browserId ? `&browser_instance_id=eq.${state.browserId}` : "";
    const cancelled = await supabaseReq(
      `dm_tasks?contact_id=eq.${contactId}&status=eq.pending&task_type=like.followup_*${browserFilter}`,
      "PATCH",
      { status: "skipped", error_reason: reason }
    );
    const count = Array.isArray(cancelled) ? cancelled.length : 0;
    if (count > 0) {
      debugLog(`[Collector] Cancelled ${count} pending follow-up(s) for contact ${contactId} (${reason}).`);
    }
    return count;
  } catch (err) {
    debugLog(`[Collector] Error cancelling follow-ups for contact ${contactId}: ${err.message}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Working Hours Safety Clamp (not a scheduling brain — the server schedules)
// ---------------------------------------------------------------------------

let _workHoursCache = null;

async function getUserWorkingHours() {
  if (_workHoursCache) return _workHoursCache;
  try {
    const userId = getUserIdFromToken(state.accessToken);
    if (!userId) return { start: 9, end: 18, timezone: 'UTC' };
    const settings = await supabaseReq(`user_settings?select=timezone,work_start_hour,work_end_hour&user_id=eq.${userId}`);
    const s = settings?.[0];
    _workHoursCache = {
      start: s?.work_start_hour ?? 9,
      end: s?.work_end_hour ?? 18,
      timezone: s?.timezone || 'UTC'
    };
    return _workHoursCache;
  } catch {
    return { start: 9, end: 18, timezone: 'UTC' };
  }
}

function isWithinWorkingHours(wh) {
  const nowHour = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: wh.timezone }).format(new Date()),
    10
  );
  if (wh.start < wh.end) return nowHour >= wh.start && nowHour < wh.end;
  return nowHour >= wh.start || nowHour < wh.end;
}

async function sendHeartbeat(force = false) {
  if (!state.browserId) return;
  try {
    const stored = await chrome.storage.local.get('leaseExpiresAt');
    const leaseExpiresAt = stored.leaseExpiresAt || 0;

    // Only write to DB when lease expires within 2 minutes (or not set yet).
    // This cuts heartbeat writes from every 1 min to every ~8-9 min.
    // force=true bypasses the check — used on startup and new connections.
    if (!force && leaseExpiresAt > Date.now() + 120_000) {
      debugLog(`Heartbeat skipped — lease valid for ${Math.round((leaseExpiresAt - Date.now()) / 1000)}s`);
      return;
    }

    const newExpiresAt = Date.now() + 600_000; // 10-minute lease
    const manifest = chrome.runtime.getManifest();
    const heartbeatPayload = {
      last_heartbeat_at: new Date().toISOString(),
      expires_at: new Date(newExpiresAt).toISOString(),
      status: 'active',
      extension_version: manifest.version,
      last_seen_at: new Date().toISOString(),
    };
    // Add platform/user_agent once (on force=true, i.e. first heartbeat)
    if (force) {
      try {
        const platformInfo = await chrome.runtime.getPlatformInfo();
        heartbeatPayload.platform = platformInfo.os || 'unknown';
      } catch {}
      heartbeatPayload.user_agent = navigator.userAgent || '';
    }
    await supabaseReq(`browser_instances?id=eq.${state.browserId}`, "PATCH", heartbeatPayload);
    await chrome.storage.local.set({ leaseExpiresAt: newExpiresAt });
    debugLog(`Heartbeat sent! Lease renewed for 10 min.`);
  } catch (err) {
    console.error("Heartbeat failed:", err);
    debugLog(`Heartbeat Error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Pacing Engine Helpers (centralized — server schedules, extension clamps)
// ---------------------------------------------------------------------------

async function pollTasks() {
  if (!state.browserId) return;
  const pacingData = await chrome.storage.local.get('wakeUpAt');
  if (pacingData.wakeUpAt && Date.now() < pacingData.wakeUpAt) {
    return; // Still sleeping until next scheduled task
  }

  if (state.isProcessing) {
    if (Date.now() - state.processingLockAcquiredAt > 600000) {
      debugLog(`[System] Auto-recovering locked engine.`);
      state.isProcessing = false;
    } else {
      return;
    }
  }

  // Acquire lock immediately (before any awaits) to prevent TOCTOU race
  state.isProcessing = true;
  state.processingLockAcquiredAt = Date.now();

  try {
    // Check if engine is paused by user
    const pauseData = await chrome.storage.local.get('enginePaused');
    if (pauseData.enginePaused) {
      debugLog(`[Poll] Engine paused by user, skipping.`);
      return;
    }

    // Working hours safety clamp (not a scheduling brain — server schedules)
    // Prevents past-due tasks from firing outside working hours.
    const wh = await getUserWorkingHours();
    if (!isWithinWorkingHours(wh)) {
      // Sleep until working hours start
      const nowHour = parseInt(
        new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: wh.timezone }).format(new Date()),
        10
      );
      const nowMin = new Date().getMinutes();
      let minsUntilOpen;
      if (nowHour < wh.start) minsUntilOpen = (wh.start - nowHour) * 60 - nowMin;
      else minsUntilOpen = (24 - nowHour + wh.start) * 60 - nowMin;
      const wakeMs = Date.now() + Math.max(minsUntilOpen, 1) * 60 * 1000;
      await chrome.storage.local.set({ wakeUpAt: wakeMs });
      debugLog(`[Poll] Outside working hours (${nowHour}h, window ${wh.start}-${wh.end}). Sleeping ${minsUntilOpen}m.`);
      return;
    }

    // 1. Fetch a pending task that is due now (scheduled_at <= now OR scheduled_at IS NULL)
    // NULL scheduled_at = old task generated before centralized pacing = "due now"
    const nowIso = new Date().toISOString();
    const url = `dm_tasks?select=*,campaigns!inner(status)&browser_instance_id=eq.${state.browserId}&status=eq.pending&campaigns.status=eq.active&or=(scheduled_at.is.null,scheduled_at.lte.${nowIso})&order=scheduled_at.asc.nullslast,created_at.asc&limit=1`;
    const tasks = await supabaseReq(url);

    if (!tasks || tasks.length === 0) {
      // Nothing due — find the next future scheduled_at so we sleep until then
      // instead of blind backoff. One cheap query.
      try {
        const future = await supabaseReq(`dm_tasks?select=scheduled_at&browser_instance_id=eq.${state.browserId}&status=eq.pending&scheduled_at=not.is.null&order=scheduled_at.asc&limit=1`);
        if (future && future.length > 0 && future[0].scheduled_at) {
          const nextAt = new Date(future[0].scheduled_at).getTime();
          const sleepMs = Math.max(nextAt - Date.now(), 5000); // min 5s safety
          await chrome.storage.local.set({ wakeUpAt: Date.now() + sleepMs });
          debugLog(`[Poll] 0 due tasks. Next at ${future[0].scheduled_at}. Sleeping ${Math.round(sleepMs/1000)}s.`);
        } else {
          // No future tasks at all — back off
          const BACKOFF_MS = [30000, 60000, 120000, 300000];
          const backoffMs = BACKOFF_MS[Math.min(state.emptyPollCount, BACKOFF_MS.length - 1)];
          state.emptyPollCount++;
          await chrome.storage.local.set({ wakeUpAt: Date.now() + backoffMs });
          debugLog(`[Poll] 0 tasks at all. Backing off ${backoffMs / 1000}s.`);
        }
      } catch {
        state.emptyPollCount++;
      }
      return;
    }

    const task = tasks[0];
    state.emptyPollCount = 0;
    delete task.campaigns;

    // 3-minute hard floor — even if the server stamps 20 tasks at the same
    // second, the extension clamps to max 1 send per 3 minutes.
    if (state.lastTaskCompletedAt && Date.now() - state.lastTaskCompletedAt < 180000) {
      const waitMs = 180000 - (Date.now() - state.lastTaskCompletedAt);
      await chrome.storage.local.set({ wakeUpAt: Date.now() + waitMs });
      debugLog(`[Floor] 3-min hard floor — waiting ${Math.round(waitMs/1000)}s before next send.`);
      return;
    }

    if (task.contact_id) {
      const contacts = await supabaseReq(`contacts?select=username,full_name&id=eq.${task.contact_id}`);
      if (contacts && contacts.length > 0) {
        task.contacts = contacts[0];
      }
    }

    await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", { status: "processing", claimed_at: new Date().toISOString() });

    debugLog(`Processing task: ${task.task_type}`);

    let taskSucceeded = false;
    try {
      const result = await executeTask(task);

      if (result?.isLimited) {
        debugLog("[Pacing] Rate limit detected from content script! Pausing engine to prevent ban.");
        await chrome.storage.local.set({ enginePaused: true });
        // Auto-resume after cooldown_after_error minutes (read from user_settings)
        const whSettings = await getUserWorkingHours();
        // cooldown is not in the cached wh object — fetch separately if needed
        // For now, default to 30 min auto-resume
        setTimeout(() => {
          chrome.storage.local.get('enginePaused', async (data) => {
            if (data.enginePaused) {
              await chrome.storage.local.remove('enginePaused');
              debugLog("[Pacing] Auto-resuming after rate-limit cooldown.");
            }
          });
        }, 30 * 60 * 1000);
      }

      if (result?.skippedReply) {
        await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
          status: "skipped",
          error_reason: "lead_replied"
        });
        state.stats.failed++;
        debugLog(`Task Skipped (lead replied): ${task.task_type}`);
      } else {
        await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
          status: "completed",
          completed_at: new Date().toISOString()
        });

        if (task.contact_id && task.task_type === 'first_dm') {
          await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
            status: "dmed",
            dmed_at: new Date().toISOString(),
            assigned_browser_id: state.browserId
          });
          await caoUpsert(task.contact_id, {
            status: "dmed",
            dmed_at: new Date().toISOString(),
            campaign_id: task.campaign_id || null
          });
        } else if (task.contact_id && task.task_type.startsWith('followup_')) {
          const stepLetter = task.task_type.replace('followup_1', '').toUpperCase() || 'A';
          await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
            followup_1a_sent: true,
            current_follow_up: `1${stepLetter}`,
            last_follow_up_at: new Date().toISOString()
          });
          await caoUpsert(task.contact_id, {
            followup_1a_sent: true,
            current_follow_up: `1${stepLetter}`,
            last_follow_up_at: new Date().toISOString()
          });
        }

        state.stats.completed++;
        state.lastTaskCompletedAt = Date.now();
        taskSucceeded = true;
        debugLog(`Task Completed: ${task.task_type}`);
      }
    } catch (err) {
      console.error("Task failed:", err);
      const isThreadBusy = err.message?.includes("thread is busy");
      if (isThreadBusy) {
        await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", { status: "pending" });
        debugLog(`[Recovery] Task ${task.task_type} re-queued as pending (thread was busy)`);
      } else {
        const isPermanentError = [
          "user_is_unreachable",
          "user_not_found",
          "cannot_message_user",
          "account_disabled",
          "rate_limited_error"
        ].includes(err.unreachableType);

        const currentRetries = Number(task.retry_count || 0);

        if (!isPermanentError && currentRetries < 3) {
          const nextRetry = currentRetries + 1;
          debugLog(`[Retry Engine] Transient error on task ${task.id} (${err.message}). Retrying (${nextRetry}/3)...`);
          
          await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
            status: "pending",
            retry_count: nextRetry,
            error_reason: `[Attempt ${nextRetry}/3] ${err.message || String(err)}`
          });

          const wakeUpAt = Date.now() + 30000;
          await chrome.storage.local.set({ wakeUpAt });
        } else {
          await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
            status: "failed",
            error_reason: currentRetries >= 3 
              ? `Failed after 3 retries. Last error: ${err.message || String(err)}`
              : (err.message || String(err)),
            unreachable_type: err.unreachableType || null
          });
          
          if (err.unreachableType === "rate_limited_error") {
            debugLog("[Pacing] Rate limit error detected! Pausing engine to prevent ban.");
            await chrome.storage.local.set({ enginePaused: true });
          } else if (err.unreachableType && task.contact_id) {
            await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
              status: "unreachable"
            });
          }

          state.stats.failed++;
          debugLog(`Task Permanently Failed: ${err.message} ${err.unreachableType ? `[${err.unreachableType}]` : ''}`);
        }
      }
    }

    await chrome.storage.local.set({ stats: state.stats });
    chrome.runtime.sendMessage({ type: "STATS_UPDATE", stats: state.stats }).catch(()=>null);

    // No local pacing sleep — the server's scheduled_at on the next task
    // determines when we wake. The poll query + wakeUpAt logic above
    // handles this automatically.

  } catch (err) {
    console.error("Polling error:", err);
  } finally {
    state.isProcessing = false;
  }
}

// ---------------------------------------------------------------------------
// Instagram Tab & Content Script Communication
// ---------------------------------------------------------------------------

async function executeTask(task) {
  if (task.task_type === 'first_dm') {
    const targetUsername = task.contacts?.username;
    if (!targetUsername) throw new Error("Missing target username in contact relation");

    let hasImage = false;
    let imageUsername = null;
    let imageArrayBuffer = null;
    let imageType = null;
    
    debugLog(`[Image Lookup] Starting image lookup for username: "${targetUsername}"`);
    debugLog(`[Image Lookup] globalThis exists: ${typeof globalThis !== "undefined"} | ImageStorage exists: ${!!globalThis?.ImageStorage}`);
    
    if (typeof globalThis !== "undefined" && globalThis.ImageStorage) {
      try {
        const totalImages = await globalThis.ImageStorage.getAllImagesCount();
        debugLog(`[Image Lookup] Total images in DB: ${totalImages}`);
        
        const img = await globalThis.ImageStorage.getImage(targetUsername);
        debugLog(`[Image Lookup] getImage("${targetUsername}") returned: ${img ? `Blob(size=${img.size}, type="${img.type}")` : "null"}`);
        
        if (img) {
          hasImage = true;
          imageUsername = targetUsername;
          imageType = img.type || "image/jpeg"; // Fallback if MIME type is empty (e.g. file was saved with non-image extension)
          // Convert Blob to ArrayBuffer for passing through the Chrome Messaging bridge
          const arrayBuf = await img.arrayBuffer();
          // Convert ArrayBuffer to Array for JSON serialization just in case structured cloning fails over MV3 boundaries
          imageArrayBuffer = Array.from(new Uint8Array(arrayBuf));
          debugLog(`[Image Manager] Found local image for ${targetUsername} | type=${imageType} | bufferLen=${imageArrayBuffer.length} | sizeKB=${Math.round(imageArrayBuffer.length/1024)}`);
        } else {
          debugLog(`[Image Lookup] No image found for "${targetUsername}" — the image may not have been saved or the username key doesn't match`);
        }
      } catch(imgErr) {
        debugLog(`[Image Lookup] ERROR retrieving image: ${imgErr?.toString()}`);
      }
    } else {
      debugLog(`[Image Lookup] SKIPPED — ImageStorage not available on globalThis`);
    }

    // If we have an image but the message template doesn't include [IMAGE], append it
    let finalMessageText = task.message_text;
    if (hasImage && !finalMessageText.includes('[IMAGE]')) {
      finalMessageText = finalMessageText + '\n[IMAGE]';
      debugLog(`[Image Manager] Message template missing [IMAGE] token — auto-appended`);
    }

    const payload = {
      target: { username: targetUsername },
      message: { text: finalMessageText },
      taskId: task.id,
      hasImage,
      imageUsername,
      imageType,
      imageArrayBuffer
    };

    debugLog(`[Image Payload] hasImage=${hasImage} | imageType=${imageType} | bufferExists=${!!imageArrayBuffer} | bufferLen=${imageArrayBuffer?.length ?? 0} | msgHasToken=${finalMessageText.includes('[IMAGE]')}`);
    return new Promise((resolve, reject) => {
      let resolved = false;

      const handler = (message, sender) => {
        if (sender.tab?.id !== state.mainTabId) return;
        if (message.type === "adblock:info:to-background" && message.isEmit) {
          const payload = message.data;
          if (payload.type === "successTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            const data = payload.data;
            (async () => {
              try {
                if (data.threadId) {
                  await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
                    thread_id: data.threadId,
                    last_message_id: data.lastMessageId || null,
                    last_message_ts: data.lastMessageTimestamp || new Date().toISOString(),
                    is_limited: !!data.isLimited
                  });
                  // Also write thread_id to contacts so the scheduler can
                  // include it when generating followup_ task rows.
                  // Phase 1 cross-account: only set the GLOBAL thread_id if it is
                  // currently NULL (i.e. this is the first-ever account to DM the
                  // lead). A 2nd account's thread must NOT overwrite it — that
                  // would point account A's pending follow-ups at account B's thread.
                  if (task.contact_id) {
                    try {
                      const existing = await supabaseReq(`contacts?select=thread_id&id=eq.${task.contact_id}`);
                      const currentThreadId = existing && existing[0] ? existing[0].thread_id : null;
                      if (!currentThreadId) {
                        await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
                          thread_id: data.threadId
                        });
                      }
                    } catch (e) {
                      // Fallback: preserve old behavior if the read fails.
                      await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
                        thread_id: data.threadId
                      });
                    }
                    // Dual-write per-account thread (always this account's own thread).
                    await caoUpsert(task.contact_id, { assigned_thread_id: data.threadId });
                  }
                }
                // Write back a live-resolved real name so follow-ups use the fast
                // server-side path instead of re-scraping every time. Only when:
                //  - the extension actually scraped a name this send (resolvedFullName),
                //  - and the stored full_name is still a username-placeholder
                //    (empty or equal to the username) — never clobber a real name
                //    or a manual override the user set.
                if (data.resolvedFullName && task.contact_id) {
                  try {
                    const storedFull = (task.contacts?.full_name || "").trim();
                    const storedUser = (task.contacts?.username || "").replace(/^@/, "").trim().toLowerCase();
                    const isPlaceholder = !storedFull || storedFull.trim().toLowerCase() === storedUser;
                    const newFull = String(data.resolvedFullName).trim();
                    if (isPlaceholder && newFull && newFull.toLowerCase() !== storedFull.toLowerCase()) {
                      await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
                        full_name: newFull
                      });
                      debugLog(`[Name] Persisted live-resolved full_name for ${task.contact_id}: "${newFull}"`);
                    }
                  } catch (e) {
                    // Non-fatal: resolution still worked, only the write-back failed.
                    debugLog(`[Name] Write-back skipped for ${task.contact_id}: ${e?.toString()}`);
                  }
                }
                if (data.response === true && task.contact_id) {
                  debugLog(`[Guard] Lead replied — skipping send for task ${task.id}, cancelling remaining follow-ups.`);
                  await cancelPendingFollowups(task.contact_id, "lead_replied");
                  await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
                    media_seen: true,
                    media_seen_at: new Date().toISOString(),
                    replied: true,
                    replied_at: new Date().toISOString()
                  });
                  // Dual-write per-account seen + replied state
                  await caoUpsert(task.contact_id, {
                    media_seen: true,
                    media_seen_at: new Date().toISOString(),
                    replied: true,
                    replied_at: new Date().toISOString()
                  });
                  // Signal pollTasks: nothing was sent (reply skip) — don't charge quota,
                  // don't advance the chain, mark the task skipped not completed.
                  resolve({ isLimited: !!data.isLimited, skippedReply: true });
                  return;
                }
                resolve({ isLimited: !!data.isLimited });
              } catch (err) {
                resolve({ isLimited: !!data.isLimited });
              }
            })();
          } else if (payload.type === "errorTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            const errReason = payload.data.error || "DM failed";
            const errType = payload.data.unreachableType || null;

            const errObj = new Error(errReason);
            errObj.unreachableType = errType;
            reject(errObj);
          }
        }
      };

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.runtime.onMessage.removeListener(handler);
          reject(new Error("Task timed out waiting for content script response"));
        }
      }, 300000);

      chrome.runtime.onMessage.addListener(handler);

      (async () => {
        try {
          const res = await sendTaskToContent("main", "sendMessage", payload);
          if (!res?.success) {
            if (!resolved) {
              resolved = true;
              chrome.runtime.onMessage.removeListener(handler);
              clearTimeout(timeoutId);
              reject(new Error(res?.error?.error || "Send message failed to start"));
            }
          }
        } catch (err) {
          if (!resolved) {
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      })();
    });
  }
  else if (task.task_type.startsWith('followup_')) {
    const targetUsername = task.contacts?.username;
    if (!targetUsername) throw new Error("Missing target username in contact relation");

    // Follow-ups use the ColdDMs thread-open path. The main tab opens DMs, then
    // (because isOpenNewTab is set) calls findUserInDialogWithoutClick to scrape
    // the LIVE candidate.id off Instagram's freshly rendered search results,
    // always closes the search dialog, and hands off via sendMessageAdditionalTab.
    // The additional tab then opens https://www.instagram.com/direct/t/<live id>/
    // directly (thread already on screen, no search box) and sends there.
    //
    // We deliberately use the FRESH live id, never the stored thread_id: the
    // stored thread_id is a URL numeric id captured in a previous session, and
    // Instagram's open-check (_checkIfOpenUserRequired) compares it against the
    // live React store's thread_key — the two schemes don't always match, which
    // caused the old false "Dialog is not opened" failures. ColdDMs re-derives a
    // fresh id at send time; so do we. thread_id / assigned_thread_id remain
    // stored for observability only. targetUrl stays null so the MAIN tab does
    // not navigate — only the additional tab opens the live thread URL.
    const targetUrl = null;
    debugLog(`[Followup] Routing via main-tab live-id scrape -> additional-tab thread open for ${targetUsername}`);

    const payload = {
      target: { username: targetUsername },
      message: { text: task.message_text },
      taskId: task.id,
      skipMessageExistsCheck: false,
      isOpenNewTab: true
    };

    return new Promise((resolve, reject) => {
      let resolved = false;

      const handler = (message, sender) => {
        if (sender.tab?.id !== state.mainTabId && sender.tab?.id !== state.additionalTabId) return;
        if (message.type === "adblock:info:to-background" && message.isEmit) {
          const payload = message.data;
          if (payload.type === "successTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            const data = payload.data;
            (async () => {
              try {
                if (data.threadId) {
                  await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
                    thread_id: data.threadId,
                    last_message_id: data.lastMessageId || null,
                    last_message_ts: data.lastMessageTimestamp || new Date().toISOString(),
                    is_limited: !!data.isLimited
                  });
                  // Dual-write per-account thread (this account's own thread)
                  if (task.contact_id) {
                    await caoUpsert(task.contact_id, { assigned_thread_id: data.threadId });
                  }
                }
                if (data.response === true && task.contact_id) {
                  debugLog(`[Guard] Lead replied — skipping send for task ${task.id}, cancelling remaining follow-ups.`);
                  await cancelPendingFollowups(task.contact_id, "lead_replied");
                  await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
                    media_seen: true,
                    media_seen_at: new Date().toISOString(),
                    replied: true,
                    replied_at: new Date().toISOString()
                  });
                  // Dual-write per-account seen + replied state
                  await caoUpsert(task.contact_id, {
                    media_seen: true,
                    media_seen_at: new Date().toISOString(),
                    replied: true,
                    replied_at: new Date().toISOString()
                  });
                  // Signal pollTasks: nothing was sent (reply skip) — don't charge quota,
                  // don't advance the chain, mark the task skipped not completed.
                  resolve({ isLimited: !!data.isLimited, skippedReply: true });
                  return;
                }
                resolve({ isLimited: !!data.isLimited });
              } catch (err) {
                resolve({ isLimited: !!data.isLimited });
              }
            })();
          } else if (payload.type === "errorTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            const errObj = new Error(payload.data.error || "Followup failed");
            errObj.unreachableType = payload.data.unreachableType || null;
            reject(errObj);
          }
        }
      };

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.runtime.onMessage.removeListener(handler);
          reject(new Error("Followup task timed out waiting for content script response"));
        }
      }, 300000);

      chrome.runtime.onMessage.addListener(handler);

      (async () => {
        try {
          const res = await sendTaskToContent("main", "sendMessage", payload, targetUrl);
          if (!res?.success) {
            if (!resolved) {
              resolved = true;
              chrome.runtime.onMessage.removeListener(handler);
              clearTimeout(timeoutId);
              reject(new Error(res?.error?.error || "Send message failed to start"));
            }
          }
        } catch (err) {
          if (!resolved) {
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      })();
    });
  } 
  else if (task.task_type === 'scrape_followers' || task.task_type === 'scrape_following') {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const handler = (message, sender) => {
        if (sender.tab?.id !== state.additionalTabId) return;
        if (message.type === "adblock:info:to-background" && message.isEmit) {
          const payload = message.data;
          if (payload.type === "successTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            (async () => {
              try {
                const targets = payload.data.targets;
                if (targets && targets.length > 0) {
                  const params = JSON.parse(task.message_text);
                  const typeStr = task.task_type === 'scrape_followers' ? "followers" : "following";

                  const listRes = await supabaseReq(`target_lists`, "POST", {
                    user_id: task.user_id,
                    name: `Scraped: ${params.target} (${typeStr})`,
                    type: "raw",
                    count: targets.length
                  });

                  if (listRes && listRes.length > 0) {
                    const listId = listRes[0].id;

                    let contactIds = [];
                    for (let i = 0; i < targets.length; i += 1000) {
                      const chunk = targets.slice(i, i + 1000);
                      const contactsToInsert = chunk.map(t => ({
                        user_id: task.user_id,
                        username: t.username,
                        full_name: t.fullName || t.username,
                        status: 'not_started'
                      }));

                      const cRes = await supabaseReq(`contacts?select=id`, "POST", contactsToInsert);
                      if (cRes) contactIds = contactIds.concat(cRes.map(c => c.id));
                    }

                    for (let i = 0; i < contactIds.length; i += 1000) {
                      const chunk = contactIds.slice(i, i + 1000);
                      const links = chunk.map(cId => ({
                        target_list_id: listId,
                        contact_id: cId
                      }));
                      await supabaseReq(`target_list_items`, "POST", links);
                    }
                  }
                }
                resolve(true);
              } catch (err) {
                reject(err);
              }
            })();
          } else if (payload.type === "errorTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);
            reject(new Error(payload.data.error || "Scraping failed"));
          }
        }
      };

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.runtime.onMessage.removeListener(handler);
          reject(new Error("Scrape task timed out waiting for content script response"));
        }
      }, 300000);

      chrome.runtime.onMessage.addListener(handler);

      (async () => {
        try {
          const params = JSON.parse(task.message_text);
          const res = await sendTaskToContent("additional", "parsing", {
            taskId: task.id,
            username: params.target,
            type: task.task_type === 'scrape_followers' ? "followers" : "following",
            limit: params.limit
          });

          if (!res?.success) {
             if (!resolved) {
               resolved = true;
               chrome.runtime.onMessage.removeListener(handler);
               clearTimeout(timeoutId);
               reject(new Error(res?.error?.error || "Failed to start scrape"));
             }
          }
        } catch (err) {
          if (!resolved) {
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      })();
    });
  }
  else {
    throw new Error(`Unsupported task_type: ${task.task_type}`);
  }
}

function randUrl() {
  const urls = [
    "https://www.instagram.com/instagram",
    "https://instagram.com",
    "https://www.instagram.com/direct/inbox/",
    "https://www.instagram.com/explore/"
  ];
  return urls[Math.floor(Math.random() * urls.length)];
}

async function openTab(type, targetUrl = null) {
  const stateKey = type === 'main' ? 'mainTabId' : 'additionalTabId';

  if (state[stateKey]) {
    try {
      const tab = await chrome.tabs.get(state[stateKey]);
      if (tab && !tab.discarded) {
        // For the additional tab with no explicit target, force-navigate to the DM
        // inbox so we never reuse a stale thread page from a previous task. The
        // content script then opens the correct thread live by username.
        const effectiveUrl = targetUrl || (type === 'additional' ? "https://www.instagram.com/direct/inbox/" : null);
        debugLog(`Reusing existing ${type} tab ${state[stateKey]}`);
        if (effectiveUrl && tab.url !== effectiveUrl) {
          debugLog(`Navigating ${type} tab to target URL: ${effectiveUrl}`);
          await chrome.tabs.update(tab.id, { url: effectiveUrl });
          for (let i = 0; i < 25; i++) {
            try {
              const t = await chrome.tabs.get(tab.id);
              if (t.status === "complete") break;
            } catch(e) { break; }
            await sleep(400);
          }
        }
        return state[stateKey];
      }
    } catch (e) {
      state[stateKey] = null;
    }
  }

  debugLog(`Opening pinned Instagram ${type} tab...`);

  const tab = await chrome.tabs.create({
    url: targetUrl || randUrl(),
    active: false,
    index: 0,
    pinned: true
  });

  state[stateKey] = tab.id;
  await chrome.storage.local.set({ [stateKey]: tab.id });

  debugLog(`Tab opened (${type}): ${tab.id}, waiting for load...`);

  for (let i = 0; i < 25; i++) {
    try {
      const t = await chrome.tabs.get(tab.id);
      if (t.status === "complete") break;
    } catch(e) { break; }
    await sleep(400);
  }

  debugLog(`Tab ready (${type}).`);
  return tab.id;
}

async function closeTabs() {
  if (state.mainTabId) {
    try { await chrome.tabs.remove(state.mainTabId); } catch(e) {}
    state.mainTabId = null;
    await chrome.storage.local.remove('mainTabId');
    debugLog("Main Tab closed.");
  }
  if (state.additionalTabId) {
    try { await chrome.tabs.remove(state.additionalTabId); } catch(e) {}
    state.additionalTabId = null;
    await chrome.storage.local.remove('additionalTabId');
    debugLog("Additional Tab closed.");
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function sendTaskToContent(tabType, taskType, taskData, targetUrl = null) {
  const tabId = await openTab(tabType, targetUrl);

  debugLog(`Sending '${taskType}' to tab ${tabId}`);

  // Ping first to confirm content script is alive
  let pingOk = false;
  let reloadCount = 0;

  while (!pingOk && reloadCount < 2) {
    for (let i = 0; i < 5; i++) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: "adblock:info:to-content",
          data: { type: "ping", data: {} }
        });
        pingOk = true;
        break;
      } catch(e) {
        await sleep(2000);
      }
    }

    if (!pingOk) {
      reloadCount++;
      debugLog(`Content script not responding. Reloading tab (attempt ${reloadCount}/2)...`);
      await chrome.tabs.reload(tabId, { bypassCache: true });
      await sleep(8000); // Wait for load
    }
  }

  if (!pingOk) {
    const errObj = new Error("Content script still not responding after tab reloads");
    errObj.unreachableType = "instagram_reload_error";
    throw errObj;
  }

  debugLog(`[sendTaskToContent] Sending actual task ${taskType} to tab ${tabId}...`);
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "adblock:info:to-content",
      data: { type: taskType, data: taskData }
    });
    debugLog(`[sendTaskToContent] Task ${taskType} successfully sent. Response: ${JSON.stringify(response)}`);
    return response;
  } catch (err) {
    debugLog(`[sendTaskToContent] ERROR sending task ${taskType} to tab ${tabId}: ${err.message}`);
    throw err;
  }
}

async function sendToContentLite(tabType, taskType, taskData) {
  if (!state[tabType === 'main' ? 'mainTabId' : 'additionalTabId']) return null;
  const tabId = state[tabType === 'main' ? 'mainTabId' : 'additionalTabId'];

  try {
    const pingRes = await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        type: "adblock:info:to-content",
        data: { type: "ping", data: {} }
      }),
      sleep(3000).then(() => null)
    ]);
    if (!pingRes) {
      debugLog(`[sendToContentLite] Content script busy, skipping ${taskType}`);
      return null;
    }

    const response = await chrome.tabs.sendMessage(tabId, {
      type: "adblock:info:to-content",
      data: { type: taskType, data: taskData }
    });
    return response;
  } catch (e) {
    debugLog(`[sendToContentLite] ${taskType} skipped: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "HUB_LOGIN") {
    handleLogin(message.payload.email, message.payload.password).catch(err => debugLog(`Login error: ${err.message}`));
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "FETCH_BROWSERS") {
    fetchBrowsers().catch(err => debugLog(`Fetch browsers error: ${err.message}`));
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_CONNECT") {
    handleConnect(message.payload.browserId, message.payload.browserLabel).catch(err => debugLog(`Connect error: ${err.message}`));
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_DISCONNECT") {
    stopEngine();
    chrome.alarms.clear("engine_heartbeat");
    closeTabs();
    state.browserId = null;
    state.browserLabel = null;
    state.stats = { completed: 0, failed: 0 };
    chrome.storage.local.remove(['browserId', 'browserLabel', 'stats']).catch(()=>null);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "GET_STATS") {
    (async () => {
      try {
        const stats = await syncStatsFromDatabase();
        sendResponse({ ok: true, stats });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.type === "HUB_PAUSE_ENGINE") {
    debugLog("[Engine] Paused by user.");
    stopEngine();
    closeTabs();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_RESUME_ENGINE") {
    debugLog("[Engine] Resumed by user. Opening tab eagerly.");
    chrome.storage.local.remove('wakeUpAt').catch(()=>null);
    startEngine();
    openTab('main').catch(err => debugLog(`Open tab error: ${err.message}`));
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_SESSION_SYNCED") {
    // Track that the web app is open (used to defer extension's own token refresh
    // and avoid rotation collisions that kill the token family).
    state.lastSessionSync = Date.now();

    // Clear session-expired flag if present — the web app has a fresh session
    chrome.storage.local.remove('sessionExpired').catch(()=>null);

    // Check if we already have the same token to avoid unnecessary restarts
    if (state.accessToken !== message.payload.accessToken) {
      state.accessToken = message.payload.accessToken;
      state.refreshToken = message.payload.refreshToken;
      chrome.storage.local.set({ accessToken: state.accessToken, refreshToken: state.refreshToken }).then(async () => {
        chrome.runtime.sendMessage({ type: "HUB_LOGIN_SUCCESS" }).catch(()=>null);
        debugLog("Auto-Login Sync Successful!");
        // Auto-pair: if not already paired, create or adopt a browser row
        if (!state.browserId) {
          await autoPairBrowser();
        }
      }).catch(err => debugLog(`Auto-Login Sync storage error: ${err.message}`));
    }
    sendResponse({ ok: true });
    return;
  }

  // --- Content Script Messages (via BackgroundConnector) ---
  if (message.type === "adblock:info:to-background") {
    const taskType = message.data?.type;
    const taskData = message.data?.data;

    // getTabType: critical — tells content.js it's the "main" tab
    if (taskType === "getTabType") {
      const tabId = sender.tab?.id;
      (async () => {
        try {
          let result = null;
          if (tabId && state.mainTabId && tabId === state.mainTabId) result = "main";
          if (tabId && state.additionalTabId && tabId === state.additionalTabId) result = "additional";
          sendResponse({ success: true, result });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // async response
    }

    // sleep: content script uses this to sleep without blocking
    if (taskType === "sleep") {
      const ms = taskData?.time || 1000;
      (async () => {
        try {
          await sleep(ms);
          sendResponse({ success: true, result: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // pong: content script acknowledges ping
    if (taskType === "pong") {
      sendResponse({ success: true });
      return;
    }

    // log: content script sending a log
    if (taskType === "log") {
      const logMsg = `[Content] ${taskData?.type}`;
      debugLog(logMsg);
      sendResponse({ success: true });
      return;
    }

    // successTask / errorTask: scraping results
    if (taskType === "successTask" || taskType === "errorTask") {
      // already handled by the Promise listener in executeTask
      sendResponse({ success: true });
      return;
    }

    // sendMessageAdditionalTab: main-tab sendMessage couldn't open the thread,
    // so it delegated to us (fallback). Open the additional tab pointed at the
    // thread's live URL and send from there — mirrors ColdDMs startTaskForAdditionalTab.
    if (taskType === "sendMessageAdditionalTab") {
      (async () => {
        try {
          const threadId = taskData?.threadId;
          const threadUrl = threadId ? `https://www.instagram.com/direct/t/${threadId}/` : null;
          const targetU = taskData?.target?.username ?? "(unknown)";
          debugLog(`[Followup->AddlTab] Handoff received for @${targetU} | taskId=${taskData?.taskId} | live threadId=${threadId || "(none)"} | url=${threadUrl || "(no url — will open by username)"}`);
          if (!threadId) {
            debugLog(`[Followup->AddlTab] WARNING: no live threadId in handoff for @${targetU} — additional tab will land on inbox and must self-recover by username.`);
          }
          await sendTaskToContent("additional", "sendMessageFromDialog", {
            target: taskData?.target,
            message: taskData?.message,
            taskId: taskData?.taskId,
            isTakeSnapshot: taskData?.isTakeSnapshot,
            skipMessageExistsCheck: taskData?.skipMessageExistsCheck
          }, threadUrl);
          debugLog(`[Followup->AddlTab] sendMessageFromDialog dispatched to additional tab for @${targetU} | taskId=${taskData?.taskId}`);
          sendResponse({ success: true });
        } catch (err) {
          debugLog(`[Followup->AddlTab] Additional-tab send failed for taskId=${taskData?.taskId}: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // saveMessages: content script sends read receipts for processing
    if (taskType === "saveMessages") {
      (async () => {
        try {
          await processCollectedMessages(taskData?.readReceipts || []);
          sendResponse({ success: true, result: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // registerAccounts: content script reports the logged-in IG account(s).
    // The content script already sends this on every init — the old background
    // dropped it into the default passthrough. Now we use it to auto-detect
    // the IG username and write it to browser_instances.
    if (taskType === "registerAccounts") {
      (async () => {
        try {
          const accounts = taskData?.accounts || [];
          const currentId = taskData?.current_id;
          const currentAccount = accounts.find((a) => a.instagram_id === currentId) || accounts[0];

          if (currentAccount && currentAccount.username && state.browserId) {
            const igUsername = currentAccount.username.toLowerCase().replace(/^@/, "");
            const igUserId = currentAccount.instagram_id || null;

            // Check what's currently stored
            const existing = await supabaseReq(`browser_instances?select=id,ig_username,user_id,instance_key&eq.id.${state.browserId}`);

            if (existing && existing.length > 0) {
              const row = existing[0];
              const storedUsername = row.ig_username ? row.ig_username.toLowerCase().replace(/^@/, "") : null;

              // Only update a row that actually belongs to THIS browser. The row's
              // instance_key is the physical browser's identity — if it differs from
              // ours, this is a DIFFERENT browser, and we must never clobber its
              // IG pairing with the account detected from this tab.
              const myKey = await ensureInstanceKey();
              if (row.instance_key && myKey && row.instance_key !== myKey) {
                debugLog(`[IG Detect] Skipping update — row ${row.id} belongs to a different browser instance (key ${row.instance_key}), not ours (${myKey}).`);
                sendResponse({ success: true, result: [] });
                return;
              }

              if (storedUsername !== igUsername) {
                if (storedUsername) {
                  debugLog(`[IG Detect] MISMATCH: paired as @${storedUsername} but logged in as @${igUsername}. Updating.`);
                } else {
                  debugLog(`[IG Detect] Detected logged-in IG account: @${igUsername}`);
                }

                // Update the browser row with the detected IG username
                await supabaseReq(`browser_instances?id=eq.${state.browserId}`, "PATCH", {
                  ig_username: igUsername,
                  ig_user_id: igUserId,
                });

                // Update the label to show the @handle
                state.browserLabel = `@${igUsername}`;
                await chrome.storage.local.set({ browserLabel: state.browserLabel });
              }
            }
          }

          sendResponse({ success: true, result: [] });
        } catch (err) {
          debugLog(`[IG Detect] Error: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // Default passthrough
    sendResponse({ success: true });
    return;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (state.mainTabId === tabId) state.mainTabId = null;
  if (state.additionalTabId === tabId) state.additionalTabId = null;
});

// Boot
init();
