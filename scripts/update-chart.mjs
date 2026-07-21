#!/usr/bin/env node
/**
 * TJ미디어 노래방 TOP100(가요) 인기차트를 받아 data/chart.json 으로 저장한다.
 *
 * ⚠️ 공식 오픈 API가 아니라 TJ 웹사이트(https://www.tjmedia.com/chart/top100)가
 *    내부적으로 호출하는 엔드포인트를 사용한다. 사이트가 개편되면 엔드포인트/필드명이
 *    바뀔 수 있으므로 그때는 이 파일의 ENDPOINT·필드 매핑을 손봐야 한다.
 *
 * 응답 형태: { resultCode, resultData: { items: [ { rank, pro, indexTitle, indexSong, com, ... } ] } }
 *   - rank        : 순위
 *   - pro         : TJ 곡번호(반주 번호)
 *   - indexTitle  : 곡 제목
 *   - indexSong   : 가수
 *   - com         : 작곡가
 *
 * 실행:  node scripts/update-chart.mjs
 * 옵션:  TJ_STR_TYPE 환경변수로 카테고리 변경 (1=가요[기본], 2=팝, 3=J-POP)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = "https://www.tjmedia.com/legacy/api/topAndHot100";
const SOURCE_URL = "https://www.tjmedia.com/chart/top100";
const STR_TYPE = process.env.TJ_STR_TYPE || "1"; // 1=가요
const MIN_SONGS = 50; // 이보다 적게 파싱되면 실패로 간주(잘못된 데이터 커밋 방지)

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
const keyOf = (t, a) => norm(t) + "|" + norm(a);
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

async function fetchTopChart() {
  const body = new URLSearchParams({
    chartType: "TOP",
    strType: STR_TYPE,
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
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`예상치 못한 응답 (resultCode=${json?.resultCode}, items=${items?.length})`);
  }
  return items;
}

// 내장 큐레이션 차트(js/chart-data.js)에서 장르·연도 룩업표를 만든다.
// TJ API는 장르/연도를 주지 않으므로, 이미 아는 곡은 장르 필터가 계속 동작하도록 보강.
function loadGenreMap() {
  try {
    const src = readFileSync(join(ROOT, "js/chart-data.js"), "utf8");
    const { CHART_TOP100, CHART_EXTRA } = new Function(
      src + "; return { CHART_TOP100, CHART_EXTRA };"
    )();
    const map = new Map();
    for (const s of [...(CHART_TOP100 || []), ...(CHART_EXTRA || [])]) {
      map.set(keyOf(s.title, s.artist), { genre: s.genre || "", year: s.year || null });
    }
    return map;
  } catch (e) {
    console.warn("⚠️ 장르 룩업 생성 실패(무시하고 진행):", e.message);
    return new Map();
  }
}

async function main() {
  const items = await fetchTopChart();
  const genreMap = loadGenreMap();
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
    songs.push({ rank, title, artist, tj, genre: extra.genre || "", year: extra.year || null });
  }

  songs.sort((a, b) => a.rank - b.rank);
  const top = songs.slice(0, 100);
  if (top.length < MIN_SONGS) {
    throw new Error(`파싱된 곡이 너무 적음 (${top.length}곡) — 응답 형식 변경 여부 확인 필요`);
  }

  const out = {
    source: "TJ미디어 노래방 TOP100 (가요)",
    sourceUrl: SOURCE_URL,
    strType: STR_TYPE,
    updatedAt: new Date().toISOString(),
    count: top.length,
    songs: top,
  };

  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(join(ROOT, "data/chart.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`✅ 인기차트 ${top.length}곡 저장 완료 · ${out.updatedAt}`);
}

main().catch((e) => {
  console.error("❌ 차트 업데이트 실패:", e.message);
  process.exit(1);
});
