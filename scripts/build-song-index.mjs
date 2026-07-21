#!/usr/bin/env node
/**
 * 자동완성용 노래 DB(data/songs.json)를 TJ미디어에서 대량 수집·누적한다. (경쟁 앱의 "전곡 내장"에 근접)
 *
 * 수집원 (모두 JSON — HTML 스크래핑보다 견고):
 *   1) legacy/api/newSongOfMonth?searchYm=YYYYMM  … 월별 신곡 (과거 N개월 백필)
 *   2) legacy/api/topAndHot100 (TOP·HOT × 가요·팝·J-POP) … 인기·역주행 보강
 * 매 실행마다 기존 data/songs.json 에 **누적**한다(차트/신곡에서 내려간 곡도 유지).
 *
 * ⚠️ 공식 오픈 API가 아니라 TJ 웹사이트 내부 엔드포인트. 개편 시 ENDPOINT·필드 매핑을 손봐야 함.
 *
 * 옵션(환경변수): TJ_MONTHS_BACK=백필할 개월 수(기본 60). 최초 대량 백필 땐 크게(예: 120).
 * 실행:  node scripts/build-song-index.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://www.tjmedia.com";
const OUT = join(ROOT, "data/songs.json");
const MONTHS_BACK = Math.max(1, Math.min(240, parseInt(process.env.TJ_MONTHS_BACK || "60", 10) || 60));
const MAX_SONGS = 60000;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
const keyOf = (t, a) => norm(t) + "|" + norm(a);
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TJ Song 객체에서 제목/가수/번호를 방어적으로 뽑기 (필드명이 버전마다 다를 수 있어 폴백)
function pickSong(it) {
  const title = clean(it.indexTitle ?? it.title ?? it.songName ?? it.SONG_NAME);
  const artist = clean(it.indexSong ?? it.singer ?? it.singerName ?? it.SINGER);
  const tj = clean(it.pro ?? it.no ?? it.songNo ?? it.SONG_NO ?? it.songNumber);
  return { title, artist, tj };
}

async function getJson(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: BASE + "/",
      ...(opts.body ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Origin: BASE } : {}),
    },
    body: opts.body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const items = json?.resultData?.items;
  if (!Array.isArray(items)) throw new Error(`resultCode=${json?.resultCode}`);
  return items;
}

function recentYms(n) {
  const out = [];
  const d = new Date();
  let y = d.getFullYear(), m = d.getMonth() + 1; // 1~12
  for (let i = 0; i < n; i++) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m--; if (m === 0) { m = 12; y--; }
  }
  return out;
}

function loadExisting() {
  try {
    const data = JSON.parse(readFileSync(OUT, "utf8"));
    if (Array.isArray(data.songs)) return data.songs;
  } catch { /* 없음 */ }
  return [];
}

function loadGenreMap() {
  try {
    const src = readFileSync(join(ROOT, "js/chart-data.js"), "utf8");
    const g = new Function(src + "; return { CHART_TOP100, CHART_EXTRA, CHART_POP, CHART_JPOP };")();
    const map = new Map();
    for (const list of [g.CHART_TOP100, g.CHART_EXTRA, g.CHART_POP, g.CHART_JPOP]) {
      for (const s of list || []) map.set(keyOf(s.title, s.artist), { genre: s.genre || "", year: s.year || null });
    }
    return map;
  } catch { return new Map(); }
}

async function main() {
  const genreMap = loadGenreMap();
  const map = new Map();
  for (const s of loadExisting()) {
    if (!s || !s.title || !s.artist) continue;
    map.set(keyOf(s.title, s.artist), {
      title: s.title, artist: s.artist,
      tj: s.tj ? String(s.tj) : "", ky: s.ky ? String(s.ky) : "",
      genre: s.genre || "", year: s.year || null,
    });
  }
  const before = map.size;

  const upsert = (title, artist, tj) => {
    if (!title || !artist) return;
    const k = keyOf(title, artist);
    const ex = genreMap.get(k) || {};
    const cur = map.get(k);
    if (!cur) {
      map.set(k, { title, artist, tj: tj || "", ky: "", genre: ex.genre || "", year: ex.year || null });
    } else if (tj && !cur.tj) cur.tj = tj;
  };

  let fetched = 0;

  // 1) 월별 신곡 백필
  for (const ym of recentYms(MONTHS_BACK)) {
    try {
      const items = await getJson(`${BASE}/legacy/api/newSongOfMonth?searchYm=${ym}`);
      items.forEach((it) => { const s = pickSong(it); upsert(s.title, s.artist, s.tj); });
      fetched += items.length;
      if (items.length) console.log(`  · 신곡 ${ym}: ${items.length}곡`);
    } catch (e) {
      console.warn(`  · 신곡 ${ym}: 실패(${e.message})`);
    }
    await sleep(250); // 예의상 간격
  }

  // 2) TOP·HOT × 카테고리 보강
  for (const chartType of ["TOP", "HOT"]) {
    for (const strType of ["1", "2", "3"]) {
      try {
        const body = new URLSearchParams({ chartType, strType, searchStartDate: "", searchEndDate: "" }).toString();
        const items = await getJson(`${BASE}/legacy/api/topAndHot100`, { method: "POST", body });
        items.forEach((it) => { const s = pickSong(it); upsert(s.title, s.artist, s.tj); });
        fetched += items.length;
      } catch (e) {
        console.warn(`  · ${chartType}/${strType}: 실패(${e.message})`);
      }
      await sleep(250);
    }
  }

  if (fetched < 50 && before === 0) {
    throw new Error(`수집 실패 (fetched=${fetched}) — 엔드포인트/형식 확인 필요`);
  }

  let songs = [...map.values()];
  if (songs.length > MAX_SONGS) songs = songs.slice(0, MAX_SONGS);
  const withTj = songs.filter((s) => s.tj).length;

  const out = {
    source: "TJ미디어 신곡·차트 누적",
    sourceUrl: BASE + "/song/recent_song",
    updatedAt: new Date().toISOString(),
    count: songs.length,
    withTj,
    songs,
  };
  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out) + "\n");
  console.log(`✅ 자동완성 DB ${before} → ${songs.length}곡 (TJ번호 ${withTj}) · ${out.updatedAt}`);
}

main().catch((e) => {
  console.error("❌ TJ 수집 실패:", e.message);
  process.exit(1);
});
