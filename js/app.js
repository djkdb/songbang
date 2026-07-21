/* ==========================================================
   셋리 — 노래방 랜덤 뽑기 앱
   ========================================================== */
(() => {
  "use strict";

  const STORAGE_KEY = "songbang.v1";
  const HISTORY_LIMIT = 30;

  // ---------- 상태 ----------
  let state = loadState();
  let pickerSource = "my"; // 'my' | 'chart' | 'both'
  let pickerGenre = "";
  let pickerSetlistId = null; // 특정 셋리스트로 좁혀 뽑기 (null=전체)
  let chartGenreFilter = "";
  let editingId = null;
  let openSetlistId = null; // 편집 중인 셋리스트
  let lastResult = null; // 마지막 뽑기 결과
  let spinning = false;

  // 인기차트: 카테고리별(가요/팝/J-POP). 기본은 앱 내장 큐레이션,
  // data/chart.json(자동 업데이트본)이 있으면 그걸로 교체한다.
  const CATS = ["가요", "팝", "J-POP"];
  let chartCategories = {
    "가요": (typeof CHART_TOP100 !== "undefined" ? CHART_TOP100 : []).slice(),
    "팝": (typeof CHART_POP !== "undefined" ? CHART_POP : []).slice(),
    "J-POP": (typeof CHART_JPOP !== "undefined" ? CHART_JPOP : []).slice(),
  };
  let currentCategory = "가요";
  let chart = chartCategories[currentCategory]; // 현재 카테고리의 곡 목록
  let chartMeta = null; // { source, updatedAt }
  let songIndex = []; // 제목 자동완성용 통합 인덱스 (init에서 채움)

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          mySongs: Array.isArray(parsed.mySongs) ? parsed.mySongs : [],
          history: Array.isArray(parsed.history) ? parsed.history : [],
          setlists: Array.isArray(parsed.setlists) ? parsed.setlists : [],
        };
      }
    } catch (e) { /* 손상된 데이터는 초기화 */ }
    return { mySongs: [], history: [], setlists: [] };
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // localStorage 사용 불가(사생활 보호 모드·용량 초과·샌드박스 등)에도 앱은 계속 동작
    }
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

  // 모션 최소화 설정 여부 (멀미·전정계 이슈 사용자 배려)
  function prefersReducedMotion() {
    return window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // 햅틱(짧은 진동) — 지원 기기에서만, 사용자 제스처 안에서 호출
  function haptic(pattern) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch (e) { /* 무시 */ }
    }
  }

  // 라인 아이콘 (currentColor 상속)
  const svg = (inner) =>
    `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const ICON = {
    heart: svg('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>'),
    edit: svg('<path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>'),
    trash: svg('<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'),
  };

  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  // ---------- 탭 ----------
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-panel").forEach((p) =>
        p.classList.toggle("active", p.id === btn.dataset.tab));
      window.scrollTo({ top: 0 });
      if (btn.dataset.tab === "tab-setlist") renderSetlists();
    });
  });

  // ---------- 뽑기: 소스/장르 필터 ----------
  const allGenres = [...new Set(CHART_TOP100.map((s) => s.genre))];

  function buildGenrePills() {
    const wrap = $("#genre-pills");
    allGenres.forEach((g) => {
      const b = document.createElement("button");
      b.className = "chip";
      b.dataset.genre = g;
      b.textContent = g;
      wrap.appendChild(b);
    });
    wrap.addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (!b) return;
      pickerGenre = b.dataset.genre;
      wrap.querySelectorAll(".chip").forEach((p) => p.classList.toggle("active", p === b));
      updatePoolInfo();
    });

    // 차트 탭 장르 필터
    const cwrap = $("#chart-genre-pills");
    allGenres.forEach((g) => {
      const b = document.createElement("button");
      b.className = "chip";
      b.dataset.genre = g;
      b.textContent = g;
      cwrap.appendChild(b);
    });
    cwrap.addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (!b) return;
      chartGenreFilter = b.dataset.genre;
      cwrap.querySelectorAll(".chip").forEach((p) => p.classList.toggle("active", p === b));
      renderChart();
    });
  }

  $("#source-pills").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (!b) return;
    pickerSource = b.dataset.source;
    $("#source-pills").querySelectorAll(".seg-btn").forEach((p) => p.classList.toggle("active", p === b));
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
      let mine = state.mySongs;
      if (pickerSetlistId) {
        const sl = state.setlists.find((x) => x.id === pickerSetlistId);
        const ids = new Set(sl ? sl.songIds : []);
        mine = mine.filter((s) => ids.has(s.id));
      }
      pool = pool.concat(mine.map((s) => ({ ...s, source: "my" })));
    }
    if (pickerSource === "chart" || pickerSource === "both") {
      const myKeys = new Set(state.mySongs.map((s) => songKey(s.title, s.artist)));
      pool = pool.concat(
        chart
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
    let srcName = { my: "내 노래", chart: "인기차트", both: "내 노래 + 인기차트" }[pickerSource];
    if (pickerSetlistId && (pickerSource === "my" || pickerSource === "both")) {
      const sl = state.setlists.find((x) => x.id === pickerSetlistId);
      if (sl) srcName = pickerSource === "both" ? `'${sl.name}' + 인기차트` : `'${sl.name}' 셋리스트`;
    }
    $("#pool-info").textContent =
      n > 0 ? `${srcName}에서 ${n}곡 중 하나를 뽑아요` : `뽑을 수 있는 곡이 없어요`;
  }

  // 소스를 코드에서 바꿀 때(첫 실행/빠른담기 등) 세그먼트 UI도 함께 갱신
  function setSource(src) {
    pickerSource = src;
    $("#source-pills").querySelectorAll(".seg-btn").forEach((p) =>
      p.classList.toggle("active", p.dataset.source === src));
    updatePoolInfo();
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
        toast("내 노래가 비어있어요. 인기차트에서 담아보세요");
      } else {
        toast("조건에 맞는 곡이 없어요. 필터를 바꿔보세요!");
      }
      return;
    }

    const winner = pool[Math.floor(Math.random() * pool.length)];
    spinning = true;
    $("#btn-pick").disabled = true;
    $("#result-card").classList.add("hidden");
    slotText.classList.remove("reveal"); // 다음 공개 때 페이드가 다시 재생되도록

    // 모션 최소화 설정이면 스핀 연출을 건너뛰고 결과만 부드럽게 공개
    if (prefersReducedMotion()) {
      setTimeout(() => finishPick(winner), 140);
      return;
    }

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
    slotText.classList.add("reveal");
    slotText.innerHTML =
      `${esc(song.title)}<br><span class="slot-artist">${esc(song.artist)}</span>`;
    haptic([18, 40, 60]); // 두구두구 끝! 짧은 진동

    lastResult = song;
    showResult(song);
    recordHistory(song);
  }

  function showResult(song) {
    $("#result-title").textContent = song.title;
    $("#result-artist").textContent = song.artist;

    const chips = [];
    if (song.source === "chart") chips.push(`인기차트 ${song.rank}위`);
    if (song.source === "my") chips.push("내 노래");
    if (song.genre) chips.push(song.genre);
    if (song.year) chips.push(String(song.year));
    if (song.tj) chips.push(`TJ ${song.tj}`);
    if (song.ky) chips.push(`금영 ${song.ky}`);
    if (song.keyAdj) chips.push(`키 ${song.keyAdj}`);
    if (song.hi) chips.push(`최고음 ${song.hi}`);
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
      return `<li class="history-item">
        <span class="history-song">${esc(h.title)} <span class="h-artist">— ${esc(h.artist)}</span></span>
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
    const keyAdj = normKeyAdj($("#input-keyadj").value);
    const hi = $("#input-hinote").value.trim();
    const tags = parseTags($("#input-tags").value);

    if (editingId) {
      const song = state.mySongs.find((s) => s.id === editingId);
      if (song) Object.assign(song, { title, artist, tj, ky, keyAdj, hi, tags });
      toast("수정했어요");
      stopEditing();
    } else {
      const key = songKey(title, artist);
      if (state.mySongs.some((s) => songKey(s.title, s.artist) === key)) {
        toast("이미 저장된 노래예요!");
        return;
      }
      state.mySongs.unshift({ id: uid(), title, artist, tj, ky, keyAdj, hi, tags, addedAt: Date.now() });
      haptic(12);
      toast(`'${title}' 담았어요`);
    }
    saveState();
    $("#add-form").reset();
    closeAc();
    renderMySongs();
    renderChart();
    updatePoolInfo();
  });

  // 키 값 정규화: "2" → "+2", "-1"·"+2"·"" 유지
  function normKeyAdj(raw) {
    let v = String(raw || "").trim().replace(/\s+/g, "");
    if (!v) return "";
    if (/^\d+$/.test(v)) v = "+" + v;              // 부호 없는 양수 → +
    if (v === "+0" || v === "-0" || v === "0") return "";
    return v.slice(0, 6);
  }

  function startEditing(song) {
    editingId = song.id;
    $("#input-title").value = song.title;
    $("#input-artist").value = song.artist;
    $("#input-tj").value = song.tj || "";
    $("#input-ky").value = song.ky || "";
    $("#input-keyadj").value = song.keyAdj || "";
    $("#input-hinote").value = song.hi || "";
    $("#input-tags").value = (song.tags || []).join(", ");
    $("#btn-add").textContent = "수정 저장";
    $("#btn-cancel-edit").classList.remove("hidden");
    $("#input-title").focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function stopEditing() {
    editingId = null;
    $("#add-form").reset();
    $("#btn-add").textContent = "추가하기";
    $("#btn-cancel-edit").classList.add("hidden");
  }

  $("#btn-cancel-edit").addEventListener("click", stopEditing);

  // ---------- 제목 자동완성 ----------
  // 앱이 가진 노래 데이터(가요·팝·J-POP·스테디셀러)를 하나의 검색 인덱스로 합친다.
  // 배포 시 라이브 차트가 로드되면 인덱스도 자동으로 넓어지고 TJ 번호까지 포함된다.
  function buildSongIndex() {
    const seen = new Set();
    const list = [];
    const pools = [
      ...Object.values(chartCategories),
      (typeof CHART_EXTRA !== "undefined" ? CHART_EXTRA : []),
    ];
    for (const pool of pools) {
      for (const s of pool || []) {
        if (!s || !s.title || !s.artist) continue;
        const k = songKey(s.title, s.artist);
        if (seen.has(k)) continue;
        seen.add(k);
        list.push({
          title: String(s.title),
          artist: String(s.artist),
          tj: s.tj ? String(s.tj) : "",
          genre: s.genre || "",
          year: s.year || null,
        });
      }
    }
    return list;
  }

  const acNorm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, "");
  const acEl = $("#ac-list");
  const titleEl = $("#input-title");
  let acItems = [];
  let acActive = -1;

  function acHighlight(text, q) {
    const t = String(text);
    if (!q) return esc(t);
    const i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(t);
    return esc(t.slice(0, i)) + '<span class="ac-hl">' + esc(t.slice(i, i + q.length)) +
      "</span>" + esc(t.slice(i + q.length));
  }

  function closeAc() {
    acItems = [];
    acActive = -1;
    acEl.classList.add("hidden");
    acEl.innerHTML = "";
    titleEl.setAttribute("aria-expanded", "false");
  }

  function renderAc() {
    const raw = titleEl.value.trim();
    const q = acNorm(raw);
    if (!q) return closeAc();
    acItems = songIndex
      .filter((s) => acNorm(s.title).includes(q) || acNorm(s.artist).includes(q))
      .sort((a, b) => {
        const as = acNorm(a.title).startsWith(q) ? 0 : 1;
        const bs = acNorm(b.title).startsWith(q) ? 0 : 1;
        return as - bs;
      })
      .slice(0, 8);
    if (acItems.length === 0) return closeAc();
    acActive = -1;
    acEl.innerHTML = acItems.map((s, i) => {
      const sub = [esc(s.artist), s.genre && esc(s.genre), s.year && s.year, s.tj && "TJ " + esc(s.tj)]
        .filter(Boolean).join(" · ");
      return `<li class="ac-item" role="option" data-i="${i}" id="ac-opt-${i}">
        <div class="ac-title">${acHighlight(s.title, raw)}</div>
        <div class="ac-sub">${sub}</div>
      </li>`;
    }).join("");
    acEl.classList.remove("hidden");
    titleEl.setAttribute("aria-expanded", "true");
  }

  function acChoose(i) {
    const s = acItems[i];
    if (!s) return;
    titleEl.value = s.title;
    $("#input-artist").value = s.artist;
    if (s.tj) $("#input-tj").value = s.tj;
    haptic(8);
    closeAc();
    // 이미 담긴 곡이면 바로 알려주기
    const dup = state.mySongs.some((x) => songKey(x.title, x.artist) === songKey(s.title, s.artist));
    if (dup) toast("이미 담긴 노래예요");
    $("#input-tags").focus();
  }

  function acSetActive(n) {
    acActive = n;
    acEl.querySelectorAll(".ac-item").forEach((li, i) =>
      li.classList.toggle("active", i === acActive));
    if (acActive >= 0) {
      titleEl.setAttribute("aria-activedescendant", "ac-opt-" + acActive);
      acEl.children[acActive]?.scrollIntoView({ block: "nearest" });
    } else {
      titleEl.removeAttribute("aria-activedescendant");
    }
  }

  titleEl.addEventListener("input", renderAc);
  titleEl.addEventListener("focus", () => { if (titleEl.value.trim()) renderAc(); });
  titleEl.addEventListener("blur", () => setTimeout(closeAc, 150));
  titleEl.addEventListener("keydown", (e) => {
    if (acEl.classList.contains("hidden") || acItems.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); acSetActive((acActive + 1) % acItems.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); acSetActive((acActive - 1 + acItems.length) % acItems.length); }
    else if (e.key === "Enter" && acActive >= 0) { e.preventDefault(); acChoose(acActive); }
    else if (e.key === "Escape") { closeAc(); }
  });
  acEl.addEventListener("mousedown", (e) => {
    // blur 전에 선택되도록 mousedown 사용
    const li = e.target.closest(".ac-item");
    if (li) { e.preventDefault(); acChoose(Number(li.dataset.i)); }
  });

  $("#my-search").addEventListener("input", renderMySongs);

  function renderMySongs() {
    const q = $("#my-search").value.trim().toLowerCase();
    const songs = state.mySongs.filter(
      (s) => !q || s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)
    );
    $("#my-count").textContent = state.mySongs.length;

    const ul = $("#my-song-list");
    if (songs.length === 0) {
      ul.innerHTML = q
        ? `<li class="empty-msg">검색 결과가 없어요</li>`
        : `<li class="empty-msg">아직 담은 노래가 없어요.<br>부를 노래를 채워야 뽑기가 돌아가요.
             <div class="empty-cta">
               <button type="button" class="key key-fill" data-act="quick10">인기 10곡 바로 담기</button>
               <button type="button" class="key key-line" data-act="go-chart">인기차트에서 고르기</button>
             </div>
           </li>`;
      return;
    }
    ul.innerHTML = songs.map((s) => {
      const nums = [s.tj && `TJ ${esc(s.tj)}`, s.ky && `금영 ${esc(s.ky)}`].filter(Boolean).join(" · ");
      const specs = [
        s.keyAdj && `<span class="spec-chip">키 ${esc(s.keyAdj)}</span>`,
        s.hi && `<span class="spec-chip">최고음 ${esc(s.hi)}</span>`,
      ].filter(Boolean).join("");
      const tags = (s.tags || []).map((t) => `<span class="tag-chip">#${esc(t)}</span>`).join("");
      const chips = specs + tags;
      return `<li class="song-item" data-id="${s.id}">
        <div class="song-info">
          <div class="song-title">${esc(s.title)}</div>
          <div class="song-sub">${esc(s.artist)}${nums ? " · " + nums : ""}</div>
          ${chips ? `<div class="song-tags">${chips}</div>` : ""}
        </div>
        <div class="song-actions">
          <button class="icon-btn" data-act="edit" title="수정" aria-label="${esc(s.title)} 수정">${ICON.edit}</button>
          <button class="icon-btn" data-act="del" title="삭제" aria-label="${esc(s.title)} 삭제">${ICON.trash}</button>
        </div>
      </li>`;
    }).join("");
  }

  // 빈 상태 CTA: 첫 실행 마찰 제거 (뽑기가 바로 되도록)
  function quickAddTop(n) {
    let added = 0;
    chart.slice(0, n).forEach((s) => {
      const key = songKey(s.title, s.artist);
      if (state.mySongs.some((x) => songKey(x.title, x.artist) === key)) return;
      state.mySongs.push({
        id: uid(),
        title: s.title,
        artist: s.artist,
        tj: s.tj ? String(s.tj) : "",
        ky: "",
        tags: s.genre ? [s.genre] : [],
        addedAt: Date.now(),
      });
      added++;
    });
    saveState();
    setSource("my"); // 이제 내 노래가 있으니 기본 소스를 내 노래로
    renderMySongs();
    renderChart();
    haptic(12);
    toast(added > 0 ? `인기 ${added}곡 담았어요. 이제 뽑아보세요` : "이미 다 담겨 있어요");
  }

  $("#my-song-list").addEventListener("click", (e) => {
    const cta = e.target.closest("[data-act='quick10'], [data-act='go-chart']");
    if (cta) {
      if (cta.dataset.act === "quick10") quickAddTop(10);
      else document.querySelector('.tab-btn[data-tab="tab-chart"]').click();
      return;
    }

    const btn = e.target.closest(".icon-btn");
    if (!btn) return;
    const id = btn.closest(".song-item").dataset.id;
    const song = state.mySongs.find((s) => s.id === id);
    if (!song) return;

    if (btn.dataset.act === "del") {
      if (!confirm(`'${song.title}'을(를) 삭제할까요?`)) return;
      state.mySongs = state.mySongs.filter((s) => s.id !== id);
      state.setlists.forEach((sl) => { sl.songIds = sl.songIds.filter((x) => x !== id); });
      if (editingId === id) stopEditing();
      saveState();
      renderMySongs();
      renderChart();
      renderSetlists();
      updatePoolInfo();
      toast("삭제했어요");
    } else if (btn.dataset.act === "edit") {
      startEditing(song);
    }
  });

  // ---------- 인기차트 ----------
  $("#chart-search").addEventListener("input", renderChart);

  // 카테고리 전환 (가요 / 팝 / J-POP)
  function updateCategoryUI() {
    $("#chart-cat").querySelectorAll(".seg-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.cat === currentCategory));
  }
  function setCategory(cat) {
    if (!CATS.includes(cat)) return;
    currentCategory = cat;
    chart = chartCategories[cat] || [];
    // 카테고리를 바꾸면 장르 필터는 전체로 초기화
    chartGenreFilter = "";
    $("#chart-genre-pills").querySelectorAll(".chip").forEach((p) =>
      p.classList.toggle("active", p.dataset.genre === ""));
    updateCategoryUI();
    renderChart();
    updatePoolInfo();
  }
  $("#chart-cat").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (b) setCategory(b.dataset.cat);
  });

  function addChartSongToMy(chartSong) {
    const key = songKey(chartSong.title, chartSong.artist);
    if (state.mySongs.some((s) => songKey(s.title, s.artist) === key)) return;
    state.mySongs.unshift({
      id: uid(),
      title: chartSong.title,
      artist: chartSong.artist,
      tj: chartSong.tj ? String(chartSong.tj) : "", // TJ 차트면 곡번호가 자동으로 담긴다
      ky: "",
      tags: chartSong.genre ? [chartSong.genre] : [],
      addedAt: Date.now(),
    });
    saveState();
    renderMySongs();
    renderChart();
    updatePoolInfo();
    haptic(12);
    toast(`'${chartSong.title}' 담았어요`);
  }

  function renderChart() {
    const q = $("#chart-search").value.trim().toLowerCase();
    const myKeys = new Set(state.mySongs.map((s) => songKey(s.title, s.artist)));

    const songs = chart.filter((s) => {
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
      const sub = [esc(s.artist)];
      if (s.genre) sub.push(esc(s.genre));
      if (s.year) sub.push(String(s.year));
      if (s.tj) sub.push("TJ " + esc(s.tj));
      return `<li class="song-item" data-rank="${s.rank}">
        <span class="song-rank${s.rank <= 3 ? " top3" : ""}">${s.rank}</span>
        <div class="song-info">
          <div class="song-title">${esc(s.title)}</div>
          <div class="song-sub">${sub.join(" · ")}</div>
        </div>
        <div class="song-actions">
          <button class="icon-btn heart-btn${hearted ? " hearted" : ""}" data-act="heart" title="내 노래에 담기" aria-label="${esc(s.title)} ${hearted ? "이미 담김" : "내 노래에 담기"}" aria-pressed="${hearted}">${ICON.heart}</button>
        </div>
      </li>`;
    }).join("");
  }

  $("#chart-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".heart-btn");
    if (!btn) return;
    const rank = Number(btn.closest(".song-item").dataset.rank);
    const song = chart.find((s) => s.rank === rank);
    if (!song) return;
    if (btn.classList.contains("hearted")) {
      toast("이미 내 노래에 있어요!");
      return;
    }
    addChartSongToMy(song);
  });

  // ---------- 셋리스트 ----------
  function setlistSongs(sl) {
    const byId = new Map(state.mySongs.map((s) => [s.id, s]));
    return (sl.songIds || []).map((id) => byId.get(id)).filter(Boolean);
  }

  $("#setlist-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#setlist-name").value.trim();
    if (!name) return;
    state.setlists.unshift({ id: uid(), name: name.slice(0, 30), songIds: [] });
    saveState();
    $("#setlist-form").reset();
    haptic(10);
    renderSetlists();
    renderSetlistPills();
    updatePoolInfo();
    toast(`'${name}' 셋리스트를 만들었어요`);
  });

  function renderSetlists() {
    $("#setlist-count").textContent = state.setlists.length;
    const ul = $("#setlist-list");
    if (state.setlists.length === 0) {
      ul.innerHTML = `<li class="empty-msg">아직 셋리스트가 없어요.<br>위에서 하나 만들어보세요.</li>`;
      return;
    }
    ul.innerHTML = state.setlists.map((sl) => {
      const n = setlistSongs(sl).length;
      const open = sl.id === openSetlistId;
      return `<li class="setlist-item" data-id="${sl.id}">
        <div class="setlist-row">
          <div class="setlist-info" data-act="toggle">
            <div class="setlist-name">${esc(sl.name) || "(이름 없음)"}</div>
            <div class="setlist-meta">${n}곡${open ? " · 편집 중" : ""}</div>
          </div>
          <div class="setlist-actions">
            <button class="mini-btn" data-act="pick"${n === 0 ? " disabled" : ""}>뽑기</button>
            <button class="icon-btn" data-act="toggle" title="편집" aria-label="${esc(sl.name)} 편집">${ICON.edit}</button>
            <button class="icon-btn" data-act="del" title="삭제" aria-label="${esc(sl.name)} 삭제">${ICON.trash}</button>
          </div>
        </div>
        ${open ? renderSetlistEditor(sl) : ""}
      </li>`;
    }).join("");
  }

  function renderSetlistEditor(sl) {
    const ids = new Set(sl.songIds || []);
    const listHtml = state.mySongs.length === 0
      ? `<li class="sl-empty">내 노래가 없어요. 먼저 노래를 담아주세요.</li>`
      : state.mySongs.map((s) => {
          const on = ids.has(s.id);
          return `<li class="sl-song" data-song="${s.id}">
            <span class="check-box${on ? " on" : ""}" aria-hidden="true"></span>
            <div class="sl-song-info">
              <div class="sl-song-title">${esc(s.title)}</div>
              <div class="sl-song-sub">${esc(s.artist)}</div>
            </div>
          </li>`;
        }).join("");
    return `<div class="setlist-editor">
      <input type="text" class="text-in sl-rename" value="${esc(sl.name)}" maxlength="30" aria-label="셋리스트 이름">
      <div class="sl-hint">담을 곡을 눌러 선택하세요.</div>
      <ul class="sl-songs">${listHtml}</ul>
    </div>`;
  }

  function pickFromSetlist(id) {
    const sl = state.setlists.find((x) => x.id === id);
    if (!sl || setlistSongs(sl).length === 0) { toast("셋리스트가 비어있어요"); return; }
    pickerSetlistId = id;
    setSource("my");
    renderSetlistPills();
    document.querySelector('.tab-btn[data-tab="tab-pick"]').click();
    setTimeout(() => doPick(), 60);
  }

  $("#setlist-list").addEventListener("click", (e) => {
    // 에디터 안 곡 토글
    const songRow = e.target.closest(".sl-song");
    if (songRow) {
      const sl = state.setlists.find((x) => x.id === openSetlistId);
      if (!sl) return;
      const sid = songRow.dataset.song;
      const i = sl.songIds.indexOf(sid);
      if (i >= 0) sl.songIds.splice(i, 1); else sl.songIds.push(sid);
      saveState();
      songRow.querySelector(".check-box").classList.toggle("on");
      const item = songRow.closest(".setlist-item");
      const n = setlistSongs(sl).length;
      const meta = item.querySelector(".setlist-meta");
      if (meta) meta.textContent = `${n}곡 · 편집 중`;
      const pickBtn = item.querySelector('.mini-btn[data-act="pick"]');
      if (pickBtn) pickBtn.disabled = n === 0;
      renderSetlistPills();
      updatePoolInfo();
      return;
    }
    const item = e.target.closest(".setlist-item");
    if (!item) return;
    const id = item.dataset.id;
    const sl = state.setlists.find((x) => x.id === id);
    if (!sl) return;
    const actEl = e.target.closest("[data-act]");
    const act = actEl ? actEl.dataset.act : null;
    if (act === "del") {
      if (!confirm(`'${sl.name}' 셋리스트를 삭제할까요? (담긴 노래는 내 노래에 그대로 남아요)`)) return;
      state.setlists = state.setlists.filter((x) => x.id !== id);
      if (openSetlistId === id) openSetlistId = null;
      if (pickerSetlistId === id) pickerSetlistId = null;
      saveState();
      renderSetlists();
      renderSetlistPills();
      updatePoolInfo();
      toast("삭제했어요");
    } else if (act === "pick") {
      pickFromSetlist(id);
    } else if (act === "toggle") {
      openSetlistId = (openSetlistId === id) ? null : id;
      renderSetlists();
    }
  });

  // 셋리스트 이름 인라인 수정
  $("#setlist-list").addEventListener("input", (e) => {
    const rn = e.target.closest(".sl-rename");
    if (!rn) return;
    const sl = state.setlists.find((x) => x.id === openSetlistId);
    if (!sl) return;
    sl.name = rn.value.slice(0, 30);
    saveState();
    const nameEl = rn.closest(".setlist-item")?.querySelector(".setlist-name");
    if (nameEl) nameEl.textContent = sl.name || "(이름 없음)";
    renderSetlistPills();
  });

  // 뽑기 탭 셋리스트 필터 칩
  function renderSetlistPills() {
    const field = $("#setlist-field");
    const wrap = $("#setlist-pills");
    if (state.setlists.length === 0) {
      field.classList.add("hidden");
      pickerSetlistId = null;
      return;
    }
    field.classList.remove("hidden");
    if (pickerSetlistId && !state.setlists.some((s) => s.id === pickerSetlistId)) pickerSetlistId = null;
    const pills = [`<button class="chip${pickerSetlistId ? "" : " active"}" data-setlist="">전체</button>`]
      .concat(state.setlists.map((sl) =>
        `<button class="chip${pickerSetlistId === sl.id ? " active" : ""}" data-setlist="${sl.id}">${esc(sl.name)}</button>`));
    wrap.innerHTML = pills.join("");
  }

  $("#setlist-pills").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    pickerSetlistId = b.dataset.setlist || null;
    if (pickerSetlistId && pickerSource === "chart") setSource("my");
    $("#setlist-pills").querySelectorAll(".chip").forEach((p) => p.classList.toggle("active", p === b));
    updatePoolInfo();
  });

  // ---------- 내보내기 / 가져오기 ----------
  $("#btn-export").addEventListener("click", () => {
    if (state.mySongs.length === 0) {
      toast("내보낼 노래가 없어요");
      return;
    }
    const blob = new Blob(
      [JSON.stringify({ app: "songbang", version: 2, mySongs: state.mySongs, setlists: state.setlists }, null, 2)],
      { type: "application/json" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "setli-my-songs.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("내 노래 목록을 저장했어요");
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
            keyAdj: normKeyAdj(s.keyAdj),
            hi: String(s.hi || "").slice(0, 20),
            tags: parseTags(Array.isArray(s.tags) ? s.tags.join(",") : s.tags),
            addedAt: s.addedAt || Date.now(),
          });
          added++;
        });

        // 셋리스트 가져오기 (곡 id를 제목·가수 기준으로 다시 연결)
        let slAdded = 0;
        if (Array.isArray(data.setlists) && data.setlists.length) {
          const oldIdToKey = {};
          songs.forEach((s) => { if (s && s.id && s.title && s.artist) oldIdToKey[s.id] = songKey(s.title, s.artist); });
          const keyToId = {};
          state.mySongs.forEach((s) => { keyToId[songKey(s.title, s.artist)] = s.id; });
          const names = new Set(state.setlists.map((x) => x.name));
          data.setlists.forEach((sl) => {
            if (!sl || !sl.name) return;
            const newIds = [...new Set((sl.songIds || []).map((oid) => keyToId[oldIdToKey[oid]]).filter(Boolean))];
            let name = String(sl.name).slice(0, 30);
            if (names.has(name)) name = (name + " (가져옴)").slice(0, 30);
            names.add(name);
            state.setlists.push({ id: uid(), name, songIds: newIds });
            slAdded++;
          });
        }

        saveState();
        renderMySongs();
        renderChart();
        renderSetlists();
        renderSetlistPills();
        updatePoolInfo();
        const parts = [];
        if (added > 0) parts.push(`${added}곡`);
        if (slAdded > 0) parts.push(`셋리스트 ${slAdded}개`);
        toast(parts.length ? parts.join(" · ") + " 가져왔어요" : "새로 가져올 항목이 없어요");
      } catch (err) {
        toast("파일을 읽을 수 없어요");
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  });

  // ---------- 라이브 인기차트 (data/chart.json) ----------
  // GitHub Actions가 매월 TJ미디어 TOP100을 긁어 data/chart.json으로 커밋한다.
  // 있으면 그걸 쓰고, 없거나(첫 배포 전) 오프라인/로컬파일이면 내장 차트로 폴백.
  function normalizeChartSongs(songs) {
    return songs
      .filter((s) => s && s.title && s.artist)
      .map((s, i) => ({
        rank: Number(s.rank) || i + 1,
        title: String(s.title),
        artist: String(s.artist),
        tj: s.tj ? String(s.tj) : "",
        genre: s.genre || "",
        year: s.year || null,
      }))
      .sort((a, b) => a.rank - b.rank);
  }

  function updateChartNote() {
    const note = $("#chart-note");
    if (!note || !chartMeta || !chartMeta.updatedAt) return;
    const d = new Date(chartMeta.updatedAt);
    if (isNaN(d)) return;
    const ymd = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
    note.innerHTML =
      `<b>${esc(chartMeta.source || "TJ미디어")}</b> 기준 · ${ymd} 자동 업데이트. ♥를 누르면 내 노래에 저장돼요.`;
  }

  function loadLiveChart() {
    if (location.protocol === "file:") return; // 로컬 파일 열기에선 fetch 불가 → 내장 차트 사용
    fetch("data/chart.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const cats = {};
        if (data.categories && typeof data.categories === "object") {
          // 신 스키마: 카테고리별. 비어있는 카테고리는 내장 목록 유지
          for (const name of CATS) {
            const live = normalizeChartSongs(data.categories[name] || []);
            cats[name] = live.length ? live : (chartCategories[name] || []);
          }
        } else if (Array.isArray(data.songs) && data.songs.length) {
          // 구 스키마 호환: songs = 가요
          cats["가요"] = normalizeChartSongs(data.songs);
          cats["팝"] = chartCategories["팝"];
          cats["J-POP"] = chartCategories["J-POP"];
        } else {
          return;
        }
        if ((cats["가요"] || []).length < 10) return;
        chartCategories = cats;
        chart = chartCategories[currentCategory] || [];
        chartMeta = { source: data.source, updatedAt: data.updatedAt };
        songIndex = buildSongIndex(); // 라이브 데이터로 자동완성 인덱스 확장
        renderChart();
        updatePoolInfo();
        updateChartNote();
      })
      .catch(() => { /* 실패 시 내장 차트 유지 */ });
  }

  // ---------- 서비스 워커 (오프라인/PWA) ----------
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  // ---------- 초기화 ----------
  songIndex = buildSongIndex();
  buildGenrePills();
  renderMySongs();
  renderChart();
  renderHistory();
  renderSetlists();
  renderSetlistPills();
  // 첫 실행(내 노래 비어있음)이면 기본 소스를 인기차트로 → 바로 뽑기가 된다
  if (state.mySongs.length === 0) setSource("chart");
  else updatePoolInfo();
  loadLiveChart(); // 라이브 차트 있으면 비동기로 교체
})();
