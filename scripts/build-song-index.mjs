#!/usr/bin/env node
/**
 * 자동완성용 노래 DB(data/songs.json)를 TJ미디어에서 모아 누적한다.
 *
 * TOP100 + HOT100(신곡·인기) × 가요·팝·J-POP = 최대 600곡/실행.
 * 매월 실행하며 기존 data/songs.json 에 **누적**한다(차트에서 내려간 곡도 유지) →
 * 시간이 지날수록 TJ 곡번호가 달린 자동완성 DB가 커진다.
 *
 * ⚠️ 공식 오픈 API가 아니라 TJ 웹사이트 내부 엔드포인트를 사용한다. 사이트 개편 시
 *    ENDPOINT·필드 매핑(indexTitle/indexSong/pro)을 손봐야 한다.
 *
 * 실행:  node scripts/build-song-index.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = "https://www.tjmedia.com/legacy/api/topAndHot100";
const SOURCE_URL = "https://www.tjmedia.com/chart/top100";
const OUT = join(ROOT, "data/songs.json");
const MAX_SONGS = 5000; // 안전 상한

// TOP/HOT × 카테고리(1=가요, 2=팝, 3=J-POP)
const SETS = [];
for (const chartType of ["TOP", "HOT"]) {
  for (const strType of ["1", "2", "3"]) SETS.push({ chartType, strType });
}

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
const keyOf = (t, a) => norm(t) + "|" + norm(a);
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

async function fetchSet(chartType, strType) {
  const body = new URLSearchParams({ chartType, strType, searchStartDate: "", searchEndDate: "" });
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://www.tjmedia.com",
      Referer: SOURCE_URL,
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const items = json?.resultData?.items;
  if (!Array.isArray(items)) throw new Error(`resultCode=${json?.resultCode}`);
  return items.map((it) => ({
    title: clean(it.indexTitle),
    artist: clean(it.indexSong),
    tj: clean(it.pro),
  })).filter((s) => s.title && s.artist);
}

// 내장 큐레이션에서 장르·연도 룩업
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

function loadExisting() {
  try {
    const data = JSON.parse(readFileSync(OUT, "utf8"));
    if (Array.isArray(data.songs)) return data.songs;
  } catch { /* 없으면 빈 상태 */ }
  return [];
}

async function main() {
  const genreMap = loadGenreMap();

  // 누적 기반: 기존 목록을 map 으로
  const map = new Map();
  for (const s of loadExisting()) {
    if (!s || !s.title || !s.artist) continue;
    map.set(keyOf(s.title, s.artist), {
      title: s.title, artist: s.artist,
      tj: s.tj ? String(s.tj) : "",
      genre: s.genre || "", year: s.year || null,
    });
  }
  const before = map.size;

  let fetched = 0;
  for (const set of SETS) {
    try {
      const songs = await fetchSet(set.chartType, set.strType);
      fetched += songs.length;
      for (const s of songs) {
        const k = keyOf(s.title, s.artist);
        const ex = genreMap.get(k) || {};
        const cur = map.get(k);
        if (!cur) {
          map.set(k, { title: s.title, artist: s.artist, tj: s.tj || "", genre: ex.genre || "", year: ex.year || null });
        } else {
          if (!cur.tj && s.tj) cur.tj = s.tj; // TJ 번호 보강
          if (!cur.genre && ex.genre) cur.genre = ex.genre;
          if (!cur.year && ex.year) cur.year = ex.year;
        }
      }
      console.log(`  · ${set.chartType}/${set.strType}: ${songs.length}곡`);
    } catch (e) {
      console.warn(`  · ${set.chartType}/${set.strType}: 실패(${e.message})`);
    }
  }

  if (fetched < 50 && before === 0) {
    throw new Error(`수집 실패 (fetched=${fetched}) — 응답 형식 확인 필요`);
  }

  let songs = [...map.values()];
  if (songs.length > MAX_SONGS) songs = songs.slice(0, MAX_SONGS);

  const out = {
    source: "TJ미디어 TOP·HOT100 (가요·팝·J-POP) 누적",
    sourceUrl: SOURCE_URL,
    updatedAt: new Date().toISOString(),
    count: songs.length,
    songs,
  };
  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`✅ 자동완성 DB ${before} → ${songs.length}곡 (신규 ${songs.length - before}) · ${out.updatedAt}`);
}

main().catch((e) => {
  console.error("❌ 자동완성 DB 빌드 실패:", e.message);
  process.exit(1);
});
