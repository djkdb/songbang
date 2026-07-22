#!/usr/bin/env node
/**
 * TJ미디어 노래방 TOP100을 카테고리별(가요 / 팝 / J-POP)로 받아 data/chart.json 으로 저장.
 *
 * ⚠️ 공식 오픈 API가 아니라 TJ 웹사이트(https://www.tjmedia.com/chart/top100)가
 *    내부적으로 호출하는 엔드포인트를 사용한다. 사이트 개편 시 엔드포인트/필드/카테고리 코드가
 *    바뀔 수 있으므로 그때는 ENDPOINT·CATEGORIES·필드 매핑을 손봐야 한다.
 *
 * 요청: POST /legacy/api/topAndHot100  (chartType=TOP, strType=<카테고리>, 날짜 비움=현재 차트)
 *   strType 1=가요, 2=팝, 3=J-POP
 * 응답: { resultCode, resultData: { items: [ { rank, pro, indexTitle, indexSong, com } ] } }
 *   rank=순위, pro=TJ 곡번호, indexTitle=제목, indexSong=가수
 *
 * 실행:  node scripts/update-chart.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = "https://www.tjmedia.com/legacy/api/topAndHot100";
const SOURCE_URL = "https://www.tjmedia.com/chart/top100";
const MIN_MAIN = 50; // 가요가 이보다 적게 파싱되면 실패로 간주

const CATEGORIES = [
  { name: "가요", strType: "1" },
  { name: "팝", strType: "2" },
  { name: "J-POP", strType: "3" },
];

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
const keyOf = (t, a) => norm(t) + "|" + norm(a);
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

async function fetchCategory(strType) {
  const body = new URLSearchParams({
    chartType: "TOP",
    strType,
    searchStartDate: "",
    searchEndDate: "",
  });
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
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  const items = json?.resultData?.items;
  if (!Array.isArray(items)) {
    throw new Error(`예상치 못한 응답 (resultCode=${json?.resultCode})`);
  }
  return items;
}

// 내장 큐레이션에서 장르·연도 룩업 (TJ API는 장르를 주지 않으므로 아는 곡은 보강)
function loadGenreMap() {
  try {
    const src = readFileSync(join(ROOT, "js/chart-data.js"), "utf8");
    const g = new Function(
      src + "; return { CHART_TOP100, CHART_EXTRA, CHART_POP, CHART_JPOP };"
    )();
    const map = new Map();
    for (const list of [g.CHART_TOP100, g.CHART_EXTRA, g.CHART_POP, g.CHART_JPOP]) {
      for (const s of list || []) {
        map.set(keyOf(s.title, s.artist), { genre: s.genre || "", year: s.year || null });
      }
    }
    return map;
  } catch (e) {
    console.warn("⚠️ 장르 룩업 생성 실패(무시):", e.message);
    return new Map();
  }
}

// 아티스트 기반 장르 분류기 (js/genre-map.js 공용)
function loadClassify() {
  try {
    const src = readFileSync(join(ROOT, "js/genre-map.js"), "utf8");
    return new Function(src + "; return classifyGenre;")();
  } catch {
    return (t, a, e) => e || "";
  }
}

function parseItems(items, genreMap) {
  const seen = new Set();
  const songs = [];
  for (const it of items) {
    const title = clean(it.indexTitle);
    const artist = clean(it.indexSong);
    const rank = parseInt(it.rank, 10);
    const tj = clean(it.pro);
    if (!title || !artist || !Number.isFinite(rank)) continue;
    const k = keyOf(title, artist);
    if (seen.has(k)) continue;
    seen.add(k);
    const extra = genreMap.get(k) || {};
    songs.push({ rank, title, artist, tj, genre: extra.genre || classify(title, artist, ""), year: extra.year || null });
  }
  songs.sort((a, b) => a.rank - b.rank);
  return songs.slice(0, 100);
}

const classify = loadClassify();

async function main() {
  const genreMap = loadGenreMap();
  const categories = {};

  for (const cat of CATEGORIES) {
    try {
      const items = await fetchCategory(cat.strType);
      const songs = parseItems(items, genreMap);
      categories[cat.name] = songs;
      console.log(`  · ${cat.name}: ${songs.length}곡`);
    } catch (e) {
      console.warn(`  · ${cat.name}: 실패(${e.message}) — 건너뜀`);
      categories[cat.name] = [];
    }
  }

  if ((categories["가요"]?.length || 0) < MIN_MAIN) {
    throw new Error(`가요 차트 파싱 부족 (${categories["가요"]?.length || 0}곡) — 응답 형식 확인 필요`);
  }

  const out = {
    source: "TJ미디어 노래방 TOP100",
    sourceUrl: SOURCE_URL,
    updatedAt: new Date().toISOString(),
    categories,
  };

  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(join(ROOT, "data/chart.json"), JSON.stringify(out, null, 2) + "\n");
  const total = Object.values(categories).reduce((n, a) => n + a.length, 0);
  console.log(`✅ 인기차트 저장 완료 · 총 ${total}곡 · ${out.updatedAt}`);
}

main().catch((e) => {
  console.error("❌ 차트 업데이트 실패:", e.message);
  process.exit(1);
});
