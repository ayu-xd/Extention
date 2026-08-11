/**
 * Web App Content Script (Auto-Login Sync)
 * Injected into the DMDroid web app to detect the Supabase session
 * and securely pass it to the extension background.
 *
 * NAMESPACE-GUARDED: only accepts the DMDroid project's session key,
 * not any random Supabase app's token (prevents session clobbering).
 */

// The DMDroid Supabase project ref — must match SUPABASE_URL in background.js
const DMDROID_PROJECT_REF = "pkzkoixryggxktaybwkp";
const SESSION_KEY_PREFIX = `sb-${DMDROID_PROJECT_REF}-auth-token`;

function scanForSupabaseSession() {
  try {
    // Only look for the DMDroid-specific key — ignore all other Supabase apps
    const value = localStorage.getItem(SESSION_KEY_PREFIX);
    if (value) {
      const session = JSON.parse(value);
      if (session && session.access_token && session.refresh_token) {
        console.log("[DmDroid] Auto-login: Found DMDroid session. Syncing to background...");
        chrome.runtime.sendMessage({
          type: "HUB_SESSION_SYNCED",
          payload: {
            accessToken: session.access_token,
            refreshToken: session.refresh_token
          }
        }).then(() => {
          console.log("[DmDroid] Auto-login sync successful.");
        }).catch((err) => {
          console.log("[DmDroid] Auto-login sync error (background might not be listening):", err);
        });
        return true;
      }
    }
  } catch (err) {
    console.error("[DmDroid] Auto-Login Sync Error:", err);
  }
  return false;
}

// Initial scan
scanForSupabaseSession();

// Periodically check in case they log in later while keeping the tab open
setInterval(() => {
  scanForSupabaseSession();
}, 2000);
