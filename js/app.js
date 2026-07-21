/* ==========================================================
   송방 SongBang — 노래방 랜덤 뽑기 앱
   ========================================================== */
(() => {
  "use strict";

  const STORAGE_KEY = "songbang.v1";
  const HISTORY_LIMIT = 30;

  // ---------- 상태 ----------
  let state = loadState();
  let pickerSource = "my"; // 'my' | 'chart' | 'both'
  let pickerGenre = "";
  let chartGenreFilter = "";
  let editingId = null;
  let lastResult = null; // 마지막 뽑기 결과
  let spinning = false;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          mySongs: Array.isArray(parsed.mySongs) ? parsed.mySongs : [],
          history: Array.isArray(parsed.history) ? parsed.history : [],
        };
      }
    } catch (e) { /* 손상된 데이터는 초기화 */ }
    return { mySongs: [], history: [] };
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // ---------- 유틸 ----------
  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function songKey(title, artist) {
    return (title + "|" + artist).toLowerCase().replace(/\s+/g, "");
  }

  function isToday(ts) {
    const d = new Date(ts), now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth() === now.getMonth() &&
           d.getDate() === now.getDate();
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  // ---------- 탭 ----------
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-panel").forEach((p) =>
        p.classList.toggle("active", p.id === btn.dataset.tab));
      window.scrollTo({ top: 0 });
    });
  });

  // ---------- 뽑기: 소스/장르 필터 ----------
  const allGenres = [...new Set(CHART_TOP100.map((s) => s.genre))];

  function buildGenrePills() {
    const wrap = $("#genre-pills");
    allGenres.forEach((g) => {
      const b = document.createElement("button");
      b.className = "pill small";
      b.dataset.genre = g;
      b.textContent = g;
      wrap.appendChild(b);
    });
    wrap.addEventListener("click", (e) => {
      const b = e.target.closest(".pill");
      if (!b) return;
      pickerGenre = b.dataset.genre;
      wrap.querySelectorAll(".pill").forEach((p) => p.classList.toggle("active", p === b));
      updatePoolInfo();
    });

    // 차트 탭 장르 필터
    const cwrap = $("#chart-genre-pills");
    allGenres.forEach((g) => {
      const b = document.createElement("button");
      b.className = "pill small";
      b.dataset.genre = g;
      b.textContent = g;
      cwrap.appendChild(b);
    });
    cwrap.addEventListener("click", (e) => {
      const b = e.target.closest(".pill");
      if (!b) return;
      chartGenreFilter = b.dataset.genre;
      cwrap.querySelectorAll(".pill").forEach((p) => p.classList.toggle("active", p === b));
      renderChart();
    });
  }

  $("#source-pills").addEventListener("click", (e) => {
    const b = e.target.closest(".pill");
    if (!b) return;
    pickerSource = b.dataset.source;
    $("#source-pills").querySelectorAll(".pill").forEach((p) => p.classList.toggle("active", p === b));
    updatePoolInfo();
  });

  $("#exclude-today").addEventListener("change", updatePoolInfo);

  // ---------- 뽑기 풀 ----------
  function matchGenre(song, genre) {
    if (!genre) return true;
    if (song.genre) return song.genre === genre;
    // 내 노래는 태그로 장르 매칭 (예: 태그에 '발라드'가 있으면 발라드로 취급)
    return (song.tags || []).some((t) => t.replace(/\s+/g, "") === genre.replace(/\s+/g, ""));
  }

  function buildPool() {
    let pool = [];
    if (pickerSource === "my" || pickerSource === "both") {
      pool = pool.concat(state.mySongs.map((s) => ({ ...s, source: "my" })));
    }
    if (pickerSource === "chart" || pickerSource === "both") {
      const myKeys = new Set(state.mySongs.map((s) => songKey(s.title, s.artist)));
      pool = pool.concat(
        CHART_TOP100
          .filter((s) => pickerSource === "chart" || !myKeys.has(songKey(s.title, s.artist)))
          .map((s) => ({ ...s, source: "chart" }))
      );
    }
    pool = pool.filter((s) => matchGenre(s, pickerGenre));

    if ($("#exclude-today").checked) {
      const todayKeys = new Set(
        state.history.filter((h) => isToday(h.pickedAt)).map((h) => h.key)
      );
      const filtered = pool.filter((s) => !todayKeys.has(songKey(s.title, s.artist)));
      // 오늘 다 뽑아버렸으면 제외 없이 전체에서
      if (filtered.length > 0) pool = filtered;
    }
    return pool;
  }

  function updatePoolInfo() {
    const n = buildPool().length;
    const srcName = { my: "내 노래", chart: "인기차트", both: "내 노래 + 인기차트" }[pickerSource];
    $("#pool-info").textContent =
      n > 0 ? `${srcName}에서 ${n}곡 중 하나를 뽑아요` : `뽑을 수 있는 곡이 없어요`;
  }

  // ---------- 슬롯머신 뽑기 ----------
  $("#btn-pick").addEventListener("click", doPick);
  $("#btn-repick").addEventListener("click", doPick);

  function doPick() {
    if (spinning) return;
    const pool = buildPool();
    const slotText = $("#slot-text");

    if (pool.length === 0) {
      if (pickerSource === "my" && state.mySongs.length === 0) {
        toast("내 노래가 비어있어요! 인기차트에서 담아보세요 🔥");
      } else {
        toast("조건에 맞는 곡이 없어요. 필터를 바꿔보세요!");
      }
      return;
    }

    const winner = pool[Math.floor(Math.random() * pool.length)];
    spinning = true;
    $("#btn-pick").disabled = true;
    $("#result-card").classList.add("hidden");
    slotText.classList.add("spinning");

    // 점점 느려지는 슬롯 연출
    const delays = [];
    let d = 55;
    while (d < 340) { delays.push(d); d *= 1.18; }

    let i = 0;
    const spinStep = () => {
      if (i < delays.length) {
        const s = pool[Math.floor(Math.random() * pool.length)];
        slotText.innerHTML =
          `${esc(s.title)}<br><span class="slot-artist">${esc(s.artist)}</span>`;
        setTimeout(spinStep, delays[i++]);
      } else {
        finishPick(winner);
      }
    };
    spinStep();
  }

  function finishPick(song) {
    spinning = false;
    $("#btn-pick").disabled = false;
    const slotText = $("#slot-text");
    slotText.classList.remove("spinning");
    slotText.innerHTML =
      `✨ ${esc(song.title)} ✨<br><span class="slot-artist">${esc(song.artist)}</span>`;

    lastResult = song;
    showResult(song);
    recordHistory(song);
  }

  function showResult(song) {
    $("#result-title").textContent = song.title;
    $("#result-artist").textContent = song.artist;

    const chips = [];
    if (song.source === "chart") chips.push(`🔥 인기차트 ${song.rank}위`);
    if (song.source === "my") chips.push("🎤 내 노래");
    if (song.genre) chips.push(song.genre);
    if (song.year) chips.push(String(song.year));
    if (song.tj) chips.push(`TJ ${song.tj}`);
    if (song.ky) chips.push(`금영 ${song.ky}`);
    (song.tags || []).forEach((t) => chips.push(`#${t}`));
    $("#result-meta").innerHTML =
      chips.map((c) => `<span class="meta-chip">${esc(c)}</span>`).join("");

    const inMy = state.mySongs.some(
      (s) => songKey(s.title, s.artist) === songKey(song.title, song.artist)
    );
    $("#btn-save-result").classList.toggle("hidden", song.source !== "chart" || inMy);
    $("#result-card").classList.remove("hidden");
  }

  $("#btn-save-result").addEventListener("click", () => {
    if (!lastResult) return;
    addChartSongToMy(lastResult);
    $("#btn-save-result").classList.add("hidden");
  });

  // ---------- 히스토리 ----------
  function recordHistory(song) {
    state.history.unshift({
      key: songKey(song.title, song.artist),
      title: song.title,
      artist: song.artist,
      source: song.source,
      pickedAt: Date.now(),
    });
    state.history = state.history.slice(0, HISTORY_LIMIT);
    saveState();
    renderHistory();
    updatePoolInfo();
  }

  function renderHistory() {
    const ul = $("#history-list");
    if (state.history.length === 0) {
      ul.innerHTML = `<li class="empty-msg">아직 뽑은 노래가 없어요</li>`;
      return;
    }
    ul.innerHTML = state.history.map((h) => {
      const t = new Date(h.pickedAt);
      const timeStr = isToday(h.pickedAt)
        ? `오늘 ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`
        : `${t.getMonth() + 1}/${t.getDate()}`;
      const icon = h.source === "chart" ? "🔥" : "🎤";
      return `<li class="history-item">
        <span class="history-song">${icon} ${esc(h.title)} <span class="h-artist">— ${esc(h.artist)}</span></span>
        <span class="history-time">${timeStr}</span>
      </li>`;
    }).join("");
  }

  $("#btn-clear-history").addEventListener("click", () => {
    if (state.history.length === 0) return;
    if (!confirm("뽑기 기록을 모두 지울까요?")) return;
    state.history = [];
    saveState();
    renderHistory();
    updatePoolInfo();
    toast("기록을 지웠어요");
  });

  // ---------- 내 노래 ----------
  function parseTags(raw) {
    return [...new Set(
      String(raw || "").split(",").map((t) => t.trim()).filter(Boolean)
    )].slice(0, 8);
  }

  $("#add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("#input-title").value.trim();
    const artist = $("#input-artist").value.trim();
    if (!title || !artist) return;

    const tj = $("#input-tj").value.trim();
    const ky = $("#input-ky").value.trim();
    const tags = parseTags($("#input-tags").value);

    if (editingId) {
      const song = state.mySongs.find((s) => s.id === editingId);
      if (song) Object.assign(song, { title, artist, tj, ky, tags });
      toast("수정했어요 ✏️");
      stopEditing();
    } else {
      const key = songKey(title, artist);
      if (state.mySongs.some((s) => songKey(s.title, s.artist) === key)) {
        toast("이미 저장된 노래예요!");
        return;
      }
      state.mySongs.unshift({ id: uid(), title, artist, tj, ky, tags, addedAt: Date.now() });
      toast(`'${title}' 추가! 🎤`);
    }
    saveState();
    $("#add-form").reset();
    renderMySongs();
    renderChart();
    updatePoolInfo();
  });

  function startEditing(song) {
    editingId = song.id;
    $("#input-title").value = song.title;
    $("#input-artist").value = song.artist;
    $("#input-tj").value = song.tj || "";
    $("#input-ky").value = song.ky || "";
    $("#input-tags").value = (song.tags || []).join(", ");
    $("#btn-add").textContent = "💾 수정 저장";
    $("#btn-cancel-edit").classList.remove("hidden");
    $("#input-title").focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function stopEditing() {
    editingId = null;
    $("#add-form").reset();
    $("#btn-add").textContent = "➕ 추가하기";
    $("#btn-cancel-edit").classList.add("hidden");
  }

  $("#btn-cancel-edit").addEventListener("click", stopEditing);
  $("#my-search").addEventListener("input", renderMySongs);

  function renderMySongs() {
    const q = $("#my-search").value.trim().toLowerCase();
    const songs = state.mySongs.filter(
      (s) => !q || s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)
    );
    $("#my-count").textContent = state.mySongs.length;

    const ul = $("#my-song-list");
    if (songs.length === 0) {
      ul.innerHTML = `<li class="empty-msg">${
        q ? "검색 결과가 없어요" : "아직 저장한 노래가 없어요.<br>인기차트에서 ♥를 눌러 담아보세요!"
      }</li>`;
      return;
    }
    ul.innerHTML = songs.map((s) => {
      const nums = [s.tj && `TJ ${esc(s.tj)}`, s.ky && `금영 ${esc(s.ky)}`].filter(Boolean).join(" · ");
      const tags = (s.tags || []).map((t) => `<span class="tag-chip">#${esc(t)}</span>`).join("");
      return `<li class="song-item" data-id="${s.id}">
        <div class="song-info">
          <div class="song-title">${esc(s.title)}</div>
          <div class="song-sub">${esc(s.artist)}${nums ? " · " + nums : ""}</div>
          ${tags ? `<div class="song-tags">${tags}</div>` : ""}
        </div>
        <div class="song-actions">
          <button class="icon-btn" data-act="edit" title="수정">✏️</button>
          <button class="icon-btn" data-act="del" title="삭제">🗑️</button>
        </div>
      </li>`;
    }).join("");
  }

  $("#my-song-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".icon-btn");
    if (!btn) return;
    const id = btn.closest(".song-item").dataset.id;
    const song = state.mySongs.find((s) => s.id === id);
    if (!song) return;

    if (btn.dataset.act === "del") {
      if (!confirm(`'${song.title}'을(를) 삭제할까요?`)) return;
      state.mySongs = state.mySongs.filter((s) => s.id !== id);
      if (editingId === id) stopEditing();
      saveState();
      renderMySongs();
      renderChart();
      updatePoolInfo();
      toast("삭제했어요");
    } else if (btn.dataset.act === "edit") {
      startEditing(song);
    }
  });

  // ---------- 인기차트 ----------
  $("#chart-search").addEventListener("input", renderChart);

  function addChartSongToMy(chartSong) {
    const key = songKey(chartSong.title, chartSong.artist);
    if (state.mySongs.some((s) => songKey(s.title, s.artist) === key)) return;
    state.mySongs.unshift({
      id: uid(),
      title: chartSong.title,
      artist: chartSong.artist,
      tj: "",
      ky: "",
      tags: chartSong.genre ? [chartSong.genre] : [],
      addedAt: Date.now(),
    });
    saveState();
    renderMySongs();
    renderChart();
    updatePoolInfo();
    toast(`'${chartSong.title}' 내 노래에 추가! ❤️`);
  }

  function renderChart() {
    const q = $("#chart-search").value.trim().toLowerCase();
    const myKeys = new Set(state.mySongs.map((s) => songKey(s.title, s.artist)));

    const songs = CHART_TOP100.filter((s) => {
      const matchQ = !q || s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q);
      const matchG = !chartGenreFilter || s.genre === chartGenreFilter;
      return matchQ && matchG;
    });

    const ul = $("#chart-list");
    if (songs.length === 0) {
      ul.innerHTML = `<li class="empty-msg">검색 결과가 없어요</li>`;
      return;
    }
    ul.innerHTML = songs.map((s) => {
      const hearted = myKeys.has(songKey(s.title, s.artist));
      return `<li class="song-item" data-rank="${s.rank}">
        <span class="song-rank${s.rank <= 3 ? " top3" : ""}">${s.rank}</span>
        <div class="song-info">
          <div class="song-title">${esc(s.title)}</div>
          <div class="song-sub">${esc(s.artist)} · ${esc(s.genre)} · ${s.year}</div>
        </div>
        <div class="song-actions">
          <button class="icon-btn heart-btn${hearted ? " hearted" : ""}" data-act="heart" title="내 노래에 담기">❤️</button>
        </div>
      </li>`;
    }).join("");
  }

  $("#chart-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".heart-btn");
    if (!btn) return;
    const rank = Number(btn.closest(".song-item").dataset.rank);
    const song = CHART_TOP100.find((s) => s.rank === rank);
    if (!song) return;
    if (btn.classList.contains("hearted")) {
      toast("이미 내 노래에 있어요!");
      return;
    }
    addChartSongToMy(song);
  });

  // ---------- 내보내기 / 가져오기 ----------
  $("#btn-export").addEventListener("click", () => {
    if (state.mySongs.length === 0) {
      toast("내보낼 노래가 없어요");
      return;
    }
    const blob = new Blob(
      [JSON.stringify({ app: "songbang", version: 1, mySongs: state.mySongs }, null, 2)],
      { type: "application/json" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "songbang-my-songs.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("내 노래 목록을 저장했어요 💾");
  });

  $("#btn-import").addEventListener("click", () => $("#import-file").click());

  $("#import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const songs = Array.isArray(data.mySongs) ? data.mySongs : (Array.isArray(data) ? data : null);
        if (!songs) throw new Error("형식이 달라요");
        const existing = new Set(state.mySongs.map((s) => songKey(s.title, s.artist)));
        let added = 0;
        songs.forEach((s) => {
          if (!s || !s.title || !s.artist) return;
          const key = songKey(s.title, s.artist);
          if (existing.has(key)) return;
          existing.add(key);
          state.mySongs.push({
            id: uid(),
            title: String(s.title).slice(0, 80),
            artist: String(s.artist).slice(0, 60),
            tj: String(s.tj || "").slice(0, 8),
            ky: String(s.ky || "").slice(0, 8),
            tags: parseTags(Array.isArray(s.tags) ? s.tags.join(",") : s.tags),
            addedAt: s.addedAt || Date.now(),
          });
          added++;
        });
        saveState();
        renderMySongs();
        renderChart();
        updatePoolInfo();
        toast(added > 0 ? `${added}곡을 가져왔어요 📥` : "새로 가져올 노래가 없어요");
      } catch (err) {
        toast("파일을 읽을 수 없어요 😢");
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  });

  // ---------- 서비스 워커 (오프라인/PWA) ----------
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  // ---------- 초기화 ----------
  buildGenrePills();
  renderMySongs();
  renderChart();
  renderHistory();
  updatePoolInfo();
})();
