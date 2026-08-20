/* WatchLog Cloud Sync - Supabase v2
   Browser-safe Supabase client. Uses only Project URL + Publishable Key.
   No service_role/secret key belongs in this file. */
(function () {
  "use strict";

  const CONFIG_KEY = "watchlog-supabase-config-v1";
  const CLOUD_TABLE = "watchlog_items";

  let client = null;
  let clientUrl = "";
  let currentUser = null;
  let connectPromise = null;
  let authListenerBound = false;
  let syncing = false;
  let syncTimer = null;
  const knownHashes = new Map();

  function getConfig() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function normalizeUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function saveConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({
      url: normalizeUrl(cfg.url),
      key: String(cfg.key || "").trim()
    }));
  }

  function configured() {
    const c = getConfig();
    return !!(normalizeUrl(c.url) && String(c.key || "").trim());
  }

  function status(text, ok) {
    const el = document.getElementById("cloudStatus");
    if (!el) return;
    el.textContent = text || "";
    el.className = ok === false ? "cloudStatus error" : "cloudStatus";
  }

  function userLabel() {
    const el = document.getElementById("cloudUser");
    if (!el) return;

    if (currentUser) {
      el.textContent = `✓ Signed in as ${currentUser.email || "your account"}`;
      el.classList.add("cloudSignedIn");
    } else {
      el.textContent = "Not signed in";
      el.classList.remove("cloudSignedIn");
    }
  }

  function updateUI() {
    const c = getConfig();
    const url = document.getElementById("supabaseUrl");
    const key = document.getElementById("supabaseKey");

    if (url && document.activeElement !== url) url.value = c.url || "";
    if (key && document.activeElement !== key) key.value = c.key || "";

    userLabel();

    const auth = document.getElementById("cloudAuthBox");
    if (auth) auth.classList.toggle("hidden", !configured());

    const configuredMsg = document.getElementById("cloudConfigHint");
    if (configuredMsg) {
      configuredMsg.textContent = configured()
        ? (currentUser
            ? "Supabase is connected and your WatchLog account is signed in."
            : "Supabase is configured. Sign in to sync your WatchLog across devices.")
        : "Enter your Supabase Project URL and Publishable Key, then save the connection.";
    }

    const signIn = document.getElementById("cloudSignIn");
    const signUp = document.getElementById("cloudSignUp");
    const signOut = document.getElementById("cloudSignOut");
    const syncNow = document.getElementById("cloudSyncNow");
    const upload = document.getElementById("cloudUploadLocal");

    if (signIn) signIn.disabled = !!currentUser;
    if (signUp) signUp.disabled = !!currentUser;
    if (signOut) signOut.disabled = !currentUser;
    if (syncNow) syncNow.disabled = !currentUser;
    if (upload) upload.disabled = !currentUser;
  }

  function hashItem(item) {
    try { return JSON.stringify(item); }
    catch { return String(item); }
  }

  async function connect() {
    if (!window.supabase) {
      throw new Error("Supabase library did not load. Check your internet connection.");
    }

    const c = getConfig();
    const url = normalizeUrl(c.url);
    const key = String(c.key || "").trim();

    if (!url || !key) {
      throw new Error("Supabase URL and Publishable Key are required.");
    }

    // Reuse the same client. This prevents multiple GoTrueClient instances.
    if (client && clientUrl === url) {
      if (!currentUser) {
        const { data, error } = await client.auth.getSession();
        if (error) throw error;
        currentUser = data?.session?.user || null;
        updateUI();
      }
      return client;
    }

    // Avoid two simultaneous createClient() calls during page startup.
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
      // If the saved URL changed, stop using the previous client.
      // The old instance is no longer referenced by WatchLog.
      if (client && clientUrl !== url) {
        try { await client.auth.signOut({ scope: "local" }); } catch {}
        client = null;
        clientUrl = "";
        currentUser = null;
        authListenerBound = false;
      }

      client = window.supabase.createClient(url, key, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true
        }
      });
      clientUrl = url;

      const { data, error } = await client.auth.getSession();
      if (error) throw error;

      currentUser = data?.session?.user || null;

      if (!authListenerBound) {
        authListenerBound = true;
        client.auth.onAuthStateChange((_event, session) => {
          currentUser = session?.user || null;
          updateUI();

          if (currentUser) {
            setTimeout(() => {
              cloudPullAndMerge().catch(err => {
                console.error("WatchLog cloud auth sync:", err);
              });
            }, 0);
          } else {
            knownHashes.clear();
            status("Signed out. Local data is still available on this device.", true);
          }
        });
      }

      updateUI();
      return client;
    })();

    try {
      return await connectPromise;
    } finally {
      connectPromise = null;
    }
  }

  async function saveConnection() {
    const url = document.getElementById("supabaseUrl")?.value.trim() || "";
    const key = document.getElementById("supabaseKey")?.value.trim() || "";

    if (!url || !key) {
      status("Enter both Supabase values.", false);
      return;
    }

    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error();
    } catch {
      status("Invalid Supabase Project URL.", false);
      return;
    }

    const normalized = normalizeUrl(url);
    const old = getConfig();

    try {
      saveConfig({ url: normalized, key });

      // Keep the existing client when the URL is unchanged.
      // This avoids the Multiple GoTrueClient warning.
      if (!client || clientUrl !== normalized) {
        await connect();
      } else {
        updateUI();
      }

      const { data } = await client.auth.getSession();

      if (data?.session?.user) {
        currentUser = data.session.user;
        updateUI();
        status(`✓ Connection saved. Signed in as ${currentUser.email}.`, true);
        await cloudPullAndMerge();
      } else {
        status("✓ Connection saved. Now sign in to sync your WatchLog.", true);
      }
    } catch (e) {
      // Restore previous config if a brand-new connection failed.
      if (old?.url && old?.key && old.url !== normalized) {
        saveConfig(old);
      }
      status("✗ " + (e.message || "Could not connect."), false);
    }

    updateUI();
  }

  async function signUp() {
    try {
      await connect();

      const email = document.getElementById("cloudEmail")?.value.trim() || "";
      const password = document.getElementById("cloudPassword")?.value || "";

      if (!email || password.length < 6) {
        throw new Error("Enter an email and a password of at least 6 characters.");
      }

      const { data, error } = await client.auth.signUp({ email, password });
      if (error) throw error;

      if (data?.session?.user) {
        currentUser = data.user;
        updateUI();
        status(`✓ Account created and signed in as ${currentUser.email}. Syncing…`, true);
        await cloudPullAndMerge();
      } else {
        status("✓ Account created. Confirm your email, then use Sign In.", true);
      }
    } catch (e) {
      status("✗ " + (e.message || "Sign-up failed."), false);
    }

    updateUI();
  }

  async function signIn() {
    try {
      await connect();

      const email = document.getElementById("cloudEmail")?.value.trim() || "";
      const password = document.getElementById("cloudPassword")?.value || "";

      if (!email || !password) {
        throw new Error("Enter your email and password.");
      }

      const { data, error } = await client.auth.signInWithPassword({
        email,
        password
      });

      if (error) throw error;
      if (!data?.session?.user) throw new Error("Sign-in succeeded but no session was returned.");

      currentUser = data.session.user;
      updateUI();
      status(`✓ Signed in as ${currentUser.email}. Syncing your library…`, true);

      await cloudPullAndMerge();
    } catch (e) {
      status("✗ " + (e.message || "Sign-in failed."), false);
      updateUI();
    }
  }

  async function signOut() {
    try {
      if (client) {
        const { error } = await client.auth.signOut();
        if (error) throw error;
      }

      currentUser = null;
      knownHashes.clear();
      updateUI();
      status("Signed out. Local data remains on this device.", true);
    } catch (e) {
      status("✗ " + (e.message || "Sign-out failed."), false);
    }
  }

  async function fetchCloud() {
    if (!client || !currentUser) return [];

    const { data, error } = await client
      .from(CLOUD_TABLE)
      .select("id,data,deleted,updated_at")
      .order("updated_at", { ascending: true });

    if (error) throw error;

    return (data || []).map(row => {
      const item = row.data && typeof row.data === "object"
        ? row.data
        : { id: row.id };

      if (!item.id) item.id = row.id;
      if (row.deleted) item.__deleted = true;
      return item;
    });
  }

  async function cloudPullAndMerge() {
    if (!client || !currentUser || syncing) return;

    syncing = true;

    try {
      status("☁ Syncing…", true);

      const remote = await fetchCloud();

      // Cloud is authoritative for items that already exist there.
      // This prevents an older local copy on another device from
      // overwriting a newer rating/date/poster/etc. in Supabase.
      const tombstones = new Set(
        remote.filter(x => x && x.__deleted).map(x => String(x.id))
      );

      const remoteItems = remote.filter(x => x && !x.__deleted);
      const remoteIds = new Set(remoteItems.map(x => String(x.id)));

      const local = (
        Array.isArray(window.watchlogGetLibrary?.())
          ? window.watchlogGetLibrary()
          : []
      ).filter(x => x && x.id && !tombstones.has(String(x.id)));

      // Keep only local items that do not exist in the cloud.
      // Existing cloud records always win during a pull/merge.
      const localOnly = local.filter(x => !remoteIds.has(String(x.id)));

      const mergedMap = new Map();

      for (const item of remoteItems) {
        if (item?.id) mergedMap.set(String(item.id), item);
      }

      for (const item of localOnly) {
        if (item?.id) mergedMap.set(String(item.id), item);
      }

      const merged = Array.from(mergedMap.values());

      window.watchlogSetLibrary(merged);

      if (typeof window.migrate === "function") {
        window.migrate();
      } else if (typeof window.render === "function") {
        window.render();
      }

      const finalLibrary = (
        Array.isArray(window.watchlogGetLibrary?.())
          ? window.watchlogGetLibrary()
          : merged
      ).filter(x => x && x.id && !tombstones.has(String(x.id)));

      // Mark the cloud records as already known so they are never
      // re-uploaded merely because we performed a pull.
      knownHashes.clear();

      for (const item of remoteItems) {
        if (item?.id) {
          knownHashes.set(String(item.id), hashItem(item));
        }
      }

      // Upload only genuinely local-only records.
      // Never upload the merged cloud records back to Supabase.
      if (localOnly.length) {
        await upsertItems(localOnly);
      }

      // The migration/render step can alter the local representation.
      // Refresh the known hashes for cloud items after the merge.
      for (const item of finalLibrary) {
        const id = String(item.id);
        if (remoteIds.has(id)) {
          knownHashes.set(id, hashItem(item));
        }
      }

      status(
        `✓ Signed in as ${currentUser.email}. Synced ${finalLibrary.length} title${finalLibrary.length === 1 ? "" : "s"} across devices.`,
        true
      );

      if (typeof window.render === "function") window.render();
    } catch (e) {
      console.error("WatchLog cloud pull:", e);
      status("✗ Cloud sync failed: " + (e.message || "Unknown error"), false);
    } finally {
      syncing = false;
    }
  }

  async function upsertItems(items) {
    if (!client || !currentUser || !Array.isArray(items) || !items.length) return;

    const rows = [];

    for (const item of items) {
      if (!item?.id || item.__deleted) continue;

      const id = String(item.id);
      const h = hashItem(item);

      if (knownHashes.get(id) === h) continue;

      rows.push({
        id,
        user_id: currentUser.id,
        data: item,
        deleted: false,
        updated_at: new Date().toISOString()
      });

      knownHashes.set(id, h);
    }

    if (!rows.length) return;

    const { error } = await client
      .from(CLOUD_TABLE)
      .upsert(rows, { onConflict: "user_id,id" });

    if (error) {
      for (const row of rows) knownHashes.delete(row.id);
      throw error;
    }
  }

  async function syncNow(items) {
    if (!client || !currentUser || syncing) return;

    syncing = true;

    try {
      const snapshot = Array.isArray(items)
        ? items.filter(x => x && x.id)
        : (window.watchlogGetLibrary?.() || []).filter(x => x && x.id);

      await upsertItems(snapshot);

      status(
        `✓ Signed in as ${currentUser.email}. Saved to cloud · ${new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit"
        })}`,
        true
      );
    } catch (e) {
      console.error("WatchLog cloud save:", e);
      status(
        "⚠ Saved locally; cloud sync will retry. " + (e.message || ""),
        false
      );
    } finally {
      syncing = false;
    }
  }

  function scheduleSync(items) {
    if (!client || !currentUser) return;

    clearTimeout(syncTimer);

    const snapshot = Array.isArray(items)
      ? items.map(x => ({ ...x }))
      : [];

    syncTimer = setTimeout(() => {
      syncNow(snapshot).catch(console.error);
    }, 450);
  }

  async function deleteItem(id) {
    if (!client || !currentUser) return;

    const sid = String(id);

    const { error } = await client
      .from(CLOUD_TABLE)
      .upsert({
        id: sid,
        user_id: currentUser.id,
        data: null,
        deleted: true,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,id" });

    if (error) throw error;
    knownHashes.delete(sid);
  }

  async function syncAll() {
    await cloudPullAndMerge();
  }

  async function migrateLocalToCloud() {
    if (!client || !currentUser) {
      throw new Error("Sign in first.");
    }

    const items = Array.isArray(window.watchlogGetLibrary?.())
      ? window.watchlogGetLibrary()
      : [];

    await upsertItems(items);

    status(
      `✓ Signed in as ${currentUser.email}. Uploaded ${items.length} local title${items.length === 1 ? "" : "s"} to the cloud.`,
      true
    );
  }

  window.watchlogCloud = {
    getConfig,
    configured,
    connect,
    saveConnection,
    signUp,
    signIn,
    signOut,
    syncNow,
    scheduleSync,
    deleteItem,
    syncAll,
    migrateLocalToCloud,
    isSignedIn: () => !!currentUser,
    getCurrentUser: () => currentUser,
    updateUI
  };
})();
