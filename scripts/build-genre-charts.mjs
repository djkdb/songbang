#!/usr/bin/env node
/**
 * 장르별 "인기순" TOP100 을 만든다. → data/genre-charts.json
 *
 * TJ는 장르별 랭킹을 공개하지 않으므로, 장르별 인기 순위는 벅스(Bugs) 장르 일간 차트를 소스로 쓰고,
 * 우리 자동완성 DB(data/songs.json, TJ·금영 번호 보유)로 노래방 번호를 매칭한다.
 *   → "장르별 인기순 100곡 + 노래방 번호" 완성.
 *
 * 벅스 장르 차트: GET https://music.bugs.co.kr/genre/chart/{group}/{code}/total/day  (서버 렌더 HTML)
 *   행 순서 = 순위. 제목 <p class="title"><a>…</a>, 가수 <p class="artist"><a>…</a>
 *
 * ⚠️ 장르 코드/HTML은 배포 후(Actions) 실제 응답으로 검증·보정이 필요할 수 있다. 실패한 장르는 건너뛰고,
 *    앱은 genre-charts.json에 없는 장르는 자체 로직으로 폴백하므로 파이프라인은 안 깨진다.
 *
 * 실행:  node scripts/build-genre-charts.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data/genre-charts.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 앱 장르 라벨 → 벅스 장르 차트 경로 [group, code] (도메스틱은 n 접두. OST=etc/nost 확인됨)
const GENRE_BUGS = {
  "발라드": ["ballad", "nballad"],
  "댄스": ["dance", "ndance"],
  "힙합": ["rap", "nrap"],
  "R&B": ["rnbsoul", "nrnbsoul"],
  "락/밴드": ["rock", "nrock"],
  "트로트": ["trot", "ntrot"],
  "포크/인디": ["folk", "nfolk"],
  "OST": ["etc", "nost"],
};

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
const keyOf = (t, a) => norm(t) + "|" + norm(a);
const decode = (s) => String(s || "")
  .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// 노래방 번호 매칭용: songs.json 로드
function loadTjMap() {
  const map = new Map();
  try {
    const data = JSON.parse(readFileSync(join(ROOT, "data/songs.json"), "utf8"));
    for (const s of data.songs || []) {
      map.set(keyOf(s.title, s.artist), { tj: s.tj || "", ky: s.ky || "" });
    }
  } catch { /* 없으면 번호 없이 진행 */ }
  return map;
}

// 벅스 트랙 리스트 파싱: <tr> 블록에서 title/artist 추출 (행 순서 = 순위)
function parseBugs(html) {
  const rows = html.split(/<tr[\s>]/i).slice(1);
  const out = [];
  for (const row of rows) {
    const tm = row.match(/class="title"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const am = row.match(/class="artist"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    if (!tm || !am) continue;
    const title = decode(tm[1]);
    const artist = decode(am[1]);
    if (title && artist) out.push({ title, artist });
  }
  return out;
}

async function fetchGenre(group, code) {
  const url = `https://music.bugs.co.kr/genre/chart/${group}/${code}/total/day`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9", Referer: "https://music.bugs.co.kr/" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseBugs(await res.text());
}

async function main() {
  const tjMap = loadTjMap();
  const genres = {};
  let okCount = 0;

  for (const [label, [group, code]] of Object.entries(GENRE_BUGS)) {
    try {
      const rows = await fetchGenre(group, code);
      if (rows.length < 5) throw new Error(`파싱 결과 ${rows.length}곡`);
      const seen = new Set();
      const songs = [];
      rows.forEach((r) => {
        const k = keyOf(r.title, r.artist);
        if (seen.has(k)) return;
        seen.add(k);
        const num = tjMap.get(k) || {};
        songs.push({ rank: songs.length + 1, title: r.title, artist: r.artist, tj: num.tj || "", ky: num.ky || "", genre: label });
      });
      genres[label] = songs.slice(0, 100);
      okCount++;
      const withTj = genres[label].filter((s) => s.tj).length;
      console.log(`  · ${label}: ${genres[label].length}곡 (TJ매칭 ${withTj})`);
    } catch (e) {
      console.warn(`  · ${label}: 실패(${e.message}) — 건너뜀`);
    }
    await sleep(500);
  }

  if (okCount === 0) throw new Error("모든 장르 수집 실패 — 벅스 경로/HTML 확인 필요");

  const out = {
    source: "벅스 장르 일간차트 (TJ 번호 매칭)",
    sourceUrl: "https://music.bugs.co.kr/genre",
    updatedAt: new Date().toISOString(),
    genres,
  };
  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out) + "\n");
  console.log(`✅ 장르 인기차트 ${okCount}개 장르 저장 · ${out.updatedAt}`);
}

main().catch((e) => {
  console.error("⚠️ 장르 차트 수집 실패(무시):", e.message);
  process.exit(0); // 비치명적: 앱은 자체 로직으로 폴백
});
