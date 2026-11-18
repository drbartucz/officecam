const $ = (id) => document.getElementById(id);
let liveTimer;
let overviewTimer;
let videoTimer;
let currentMonth = "";
let seenPhotoAt = null;
let photos = [];

async function api(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function showApp(authenticated) {
  $("login-view").classList.toggle("hidden", authenticated);
  $("app-view").classList.toggle("hidden", !authenticated);
  $("logout").classList.toggle("hidden", !authenticated);
  if (authenticated) startDashboard();
  else { clearInterval(liveTimer); clearInterval(overviewTimer); clearInterval(videoTimer); }
}
function formatTime(date) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }
function updateClock() {
  $("clock-time").textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());
  $("clock-zone").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll("_", " ").toUpperCase();
}
async function updateLive() {
  if (document.hidden) return;
  try {
    const response = await fetch(`/api/live?t=${Date.now()}`, { cache: "no-store" });
    if (response.status === 401) return showApp(false);
    if (!response.ok) throw new Error("Offline");
    const blob = await response.blob();
    const nextUrl = URL.createObjectURL(blob);
    const image = $("live-image");
    const previousUrl = image.dataset.url;
    image.src = nextUrl;
    image.dataset.url = nextUrl;
    image.classList.remove("hidden");
    $("live-placeholder").classList.add("hidden");
    $("live-badge").classList.remove("offline");
    $("live-badge").lastElementChild.textContent = "Live";
    $("live-updated").textContent = `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(new Date())}`;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  } catch {
    $("live-badge").classList.add("offline");
    $("live-badge").lastElementChild.textContent = "Waiting for camera";
    $("live-image").classList.add("hidden");
    $("live-placeholder").classList.remove("hidden");
  }
}
async function updateOverview() {
  try {
    const data = await api("/api/overview");
    const previous = $("month-select").value;
    const options = data.months.map((month) => `<option value="${month}">${new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`))}</option>`).join("");
    $("month-select").innerHTML = data.months.length ? `<option value="all">All time</option>${options}` : `<option value="">No photos yet</option>`;
    $("month-select").value = data.months.includes(previous) || previous === "all" ? previous : data.months[0] || "";
    const archiveChanged = data.lastPhotoAt && data.lastPhotoAt !== seenPhotoAt;
    seenPhotoAt = data.lastPhotoAt;
    if ($("month-select").value !== currentMonth || archiveChanged) await selectMonth();
  } catch (error) { $("video-status").textContent = error.message; }
}
async function selectMonth() {
  currentMonth = $("month-select").value;
  clearInterval(videoTimer);
  $("video-player").pause();
  $("video-player").removeAttribute("src");
  $("video-player").classList.add("hidden");
  $("download-video").classList.add("hidden");
  if (!currentMonth) { $("prepare-video").disabled = true; return; }
  const data = await api(`/api/photos?month=${currentMonth}`);
  photos = data.photos;
  $("photo-count").textContent = `${photos.length.toLocaleString()} photo${photos.length === 1 ? "" : "s"}`;
  const seconds = Math.ceil(photos.length / 24);
  $("video-duration").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} video`;
  $("archive-range").textContent = currentMonth === "all" ? "All time" : currentMonth;
  $("prepare-video").disabled = !photos.length;
  $("video-status").textContent = photos.length ? "Prepare the video to watch these frames." : "No photos in this period.";
  const grid = $("photo-grid");
  grid.replaceChildren();
  for (const photo of photos.slice(-8).reverse()) {
    const link = document.createElement("a");
    link.className = "photo-card";
    link.href = `/api/photo?key=${encodeURIComponent(photo.key)}`;
    link.target = "_blank";
    link.rel = "noopener";
    const image = document.createElement("img");
    image.src = link.href;
    image.alt = `Photo captured ${formatTime(new Date(photo.at))}`;
    image.loading = "lazy";
    const label = document.createElement("span");
    label.textContent = formatTime(new Date(photo.at));
    link.append(image, label);
    grid.append(link);
  }
  if (!photos.length) grid.innerHTML = '<p class="muted">No photos yet. The first one will appear after the next hourly capture.</p>';
  await updateVideoState();
}
async function updateVideoState() {
  if (!currentMonth) return;
  const state = await api(`/api/video/status?month=${currentMonth}`);
  if (state.state === "ready") {
    const url = `${state.url}&t=${Date.now()}`;
    if ($("video-player").src !== new URL(url, location.href).href) $("video-player").src = url;
    $("video-player").classList.remove("hidden");
    $("download-video").href = url;
    $("download-video").classList.remove("hidden");
    $("video-status").textContent = "Ready to watch.";
    $("prepare-video").textContent = "Video ready";
    clearInterval(videoTimer);
  } else if (state.state === "building") {
    $("video-status").textContent = "Preparing your video. This may take a few minutes for a large archive.";
    $("prepare-video").textContent = "Preparing…";
    $("prepare-video").disabled = true;
  } else if (state.state === "failed") {
    $("video-status").textContent = `Video preparation failed: ${state.error || "try again"}`;
    $("prepare-video").textContent = "Try again";
    $("prepare-video").disabled = false;
    clearInterval(videoTimer);
  } else {
    $("prepare-video").textContent = "Prepare video ↗";
    $("prepare-video").disabled = state.state === "empty";
  }
}
async function startDashboard() {
  updateClock();
  await updateOverview();
  await updateLive();
  clearInterval(liveTimer);
  clearInterval(overviewTimer);
  liveTimer = setInterval(updateLive, 1500);
  overviewTimer = setInterval(updateOverview, 60_000);
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("password").value }) });
    $("password").value = "";
    showApp(true);
  } catch (error) { $("login-error").textContent = error.message; }
});
$("logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); showApp(false); });
$("month-select").addEventListener("change", () => selectMonth().catch((error) => { $("video-status").textContent = error.message; }));
$("prepare-video").addEventListener("click", async () => {
  try {
    await api(`/api/video?month=${currentMonth}`, { method: "POST" });
    await updateVideoState();
    clearInterval(videoTimer);
    videoTimer = setInterval(() => updateVideoState().catch(() => {}), 3000);
  } catch (error) { $("video-status").textContent = error.message; }
});
setInterval(updateClock, 30_000);
api("/api/session").then((data) => showApp(data.authenticated)).catch(() => showApp(false));
