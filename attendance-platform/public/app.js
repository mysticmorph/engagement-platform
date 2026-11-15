// Host website: loads a meeting report by meeting ID from /api.
(function () {
  const COLORS = { FOCUSED: "#22c55e", DISTRACTED: "#f59e0b", DROWSY: "#f97316", SLEEPING: "#ef4444", ABSENT: "#64748b" };
  const STATES = ["FOCUSED", "DISTRACTED", "DROWSY", "SLEEPING", "ABSENT"];
  const LABELS = { FOCUSED: "Focused", DISTRACTED: "Distracted", DROWSY: "Drowsy", SLEEPING: "Sleeping", ABSENT: "Absent" };
  const $ = id => document.getElementById(id);
  const charts = {};
  let currentMeeting = "";

  const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--";
  const fmtDuration = sec => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
    return h ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, "0")}s`;
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function setMsg(text, isErr) { const m = $("msg"); m.textContent = text; m.className = "msg" + (isErr ? " err" : ""); }
  function chart(id, config) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($(id), config);
  }

  function show(id, on) { $(id).classList.toggle("hidden", !on); }

  // Logged out: only the login form is visible.
  function showLogin(message) {
    show("loginCard", true);
    show("findForm", false);
    show("logoutBtn", false);
    show("overallCard", false);
    show("attendeeCard", false);
    show("detailCard", false);
    $("hostInfo").textContent = "";
    setMsg(message || "", !!message);
  }

  // Logged in: show the meeting ID form and reports.
  function showApp(username) {
    show("loginCard", false);
    show("findForm", true);
    show("logoutBtn", true);
    $("hostInfo").textContent = `Logged in as ${username}`;
    setMsg("");
  }

  async function getJSON(url) {
    const r = await fetch(url);
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) showLogin(body.error || "Log in as a host to view reports");
    if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
    return body;
  }

  async function loadReport(meetingId) {
    setMsg("Loading...");
    const data = await getJSON(`/api/meetings/${encodeURIComponent(meetingId)}/report`);
    currentMeeting = meetingId;
    setMsg("");
    renderOverall(data);
    renderAttendees(data.attendees);
    $("detailCard").classList.add("hidden");
    history.replaceState(null, "", `?meeting=${encodeURIComponent(meetingId)}`);
  }

  function renderOverall(data) {
    const o = data.overall;
    $("overallCard").classList.remove("hidden");
    $("overallTitle").textContent = `Overall attendance: ${data.meetingId}`;
    $("sAttendees").textContent = o.attendees;
    $("sAttended").textContent = o.attended;
    $("sAttendancePct").textContent = o.attendancePct + "%";
    $("sAttention").textContent = o.attentionPct + "%";
    $("sSleep").textContent = o.sleepEpisodes;
    $("sDrowsy").textContent = o.drowsyEpisodes;

    chart("overallChart", {
      type: "line",
      data: {
        labels: o.timeline.map(p => fmtTime(p.minute)),
        datasets: [{ label: "Attention %", data: o.timeline.map(p => p.attentionPct), borderColor: "#60a5fa",
          borderWidth: 2, pointRadius: 0, tension: 0.2, fill: false }]
      },
      options: { responsive: true, maintainAspectRatio: false, animation: false,
        scales: { y: { min: 0, max: 100, ticks: { color: "#8a94ab" }, grid: { color: "#262f45" } },
                  x: { ticks: { color: "#8a94ab", maxTicksLimit: 8 }, grid: { display: false } } },
        plugins: { legend: { display: false } } }
    });

    chart("stateChart", {
      type: "doughnut",
      data: {
        labels: STATES.map(s => LABELS[s]),
        datasets: [{ data: STATES.map(s => o.stateSharePct[s]), backgroundColor: STATES.map(s => COLORS[s]), borderWidth: 0 }]
      },
      options: { responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { position: "bottom", labels: { color: "#8a94ab" } } } }
    });
  }

  function renderAttendees(attendees) {
    $("attendeeCard").classList.remove("hidden");
    const rows = attendees.map(a => `
      <tr data-id="${esc(a.attendeeId)}">
        <td>${esc(a.name)}</td>
        <td>${a.presentPct}% ${a.attended ? "" : '<span class="pill" style="background:#f59e0b">&lt;1 min</span>'}</td>
        <td>${a.attentionPct}%</td>
        <td>${a.sleepEpisodes}</td>
        <td>${a.drowsyEpisodes}</td>
        <td>${fmtDuration(a.presentSeconds)}</td>
        <td>${fmtTime(a.firstSeen)}</td>
        <td>${fmtTime(a.lastSeen)}</td>
      </tr>`).join("");
    $("attendeeRows").innerHTML = rows || `<tr><td colspan="8">No attendees.</td></tr>`;
  }

  async function loadAttendee(attendeeId, name) {
    const data = await getJSON(`/api/meetings/${encodeURIComponent(currentMeeting)}/attendees/${encodeURIComponent(attendeeId)}`);
    $("detailCard").classList.remove("hidden");
    $("detailTitle").textContent = `Detail: ${name}`;
    const t = data.timeline;
    chart("detailChart", {
      type: "bar",
      data: {
        labels: t.map(p => fmtTime(p.minute)),
        datasets: STATES.map(s => ({ label: LABELS[s], backgroundColor: COLORS[s], data: t.map(p => p.seconds[s]) }))
      },
      options: { responsive: true, maintainAspectRatio: false, animation: false,
        scales: { x: { stacked: true, ticks: { color: "#8a94ab", maxTicksLimit: 12 }, grid: { display: false } },
                  y: { stacked: true, max: 60, title: { display: true, text: "seconds in minute", color: "#8a94ab" },
                       ticks: { color: "#8a94ab" }, grid: { color: "#262f45" } } },
        plugins: { legend: { display: false } } }
    });
    $("detailCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("findForm").addEventListener("submit", e => {
    e.preventDefault();
    const id = $("meetingId").value.trim();
    loadReport(id).catch(err => {
      setMsg(err.message, true);
      $("overallCard").classList.add("hidden");
      $("attendeeCard").classList.add("hidden");
      $("detailCard").classList.add("hidden");
    });
  });

  $("attendeeRows").addEventListener("click", e => {
    const row = e.target.closest("tr[data-id]");
    if (!row) return;
    const name = row.children[0].textContent;
    loadAttendee(row.dataset.id, name).catch(err => setMsg(err.message, true));
  });

  // Open the report for ?meeting=ID links, once logged in.
  function openPresetMeeting() {
    const preset = new URLSearchParams(location.search).get("meeting");
    if (preset) { $("meetingId").value = preset; loadReport(preset).catch(err => setMsg(err.message, true)); }
  }

  $("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const r = await fetch("/api/host/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("loginUser").value, password: $("loginPass").value })
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return setMsg(body.error || "Login failed", true);
    $("loginPass").value = "";
    showApp(body.username);
    openPresetMeeting();
  });

  $("logoutBtn").addEventListener("click", async () => {
    await fetch("/api/host/logout", { method: "POST" });
    showLogin("Logged out.");
  });

  // On page load: check for an existing login session.
  fetch("/api/host/me").then(async r => {
    if (!r.ok) return showLogin();
    const me = await r.json();
    showApp(me.username);
    openPresetMeeting();
  }).catch(() => showLogin("Cannot reach the server."));
})();
