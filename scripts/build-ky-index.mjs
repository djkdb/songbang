#!/usr/bin/env node
/**
 * 금영(KYSing) 곡번호를 data/songs.json 에 누적한다. (TJ 인덱스에 금영 번호 ky 보강 + 금영-only 곡 추가)
 *
 * 방식: kysing.kr 는 곡번호 정확검색만 안정적이라, 곡번호를 배치로 열거(enumerate)하며 누적한다.
 *   GET https://kysing.kr/search/?category=1&keyword={번호}
 *   파싱: .search_chart_list (헤더 행 스킵) → .search_chart_tit .tit(제목), .search_chart_sng(가수)
 *   (출처: 공개 크롤러 Yuyeol/song_crawler, ghkim887/karaoke-search 리서치 — ≥600ms 간격 무차단)
 *
 * ⚠️ 부담이 큰 작업이라 기본 비활성. 환경변수로 켜고, 매 실행 KY_BATCH개씩만 진행해 여러 번에 나눠 누적한다.
 *   CRAWL_KY=1        활성화(필수)
 *   KY_BATCH=1000     한 번에 열거할 번호 수(기본 1000)
 *   KY_END=100000     열거 상한(기본 100000)
 *   진행 커서(kyCursor)는 data/songs.json 에 저장된다.
 *
 * 실행:  CRAWL_KY=1 node scripts/build-ky-index.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data/songs.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DELAY = 650;
const BATCH = Math.max(1, parseInt(process.env.KY_BATCH || "1000", 10) || 1000);
const END = Math.max(1, parseInt(process.env.KY_END || "100000", 10) || 100000);

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
const keyOf = (t, a) => norm(t) + "|" + norm(a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADERS = new Set(["곡명", "가수", "제목", "번호", "작곡", "작사"]);

function decode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// 번호 정확검색 응답에서 제목·가수 추출 (데이터 행만)
function parseSong(html) {
  // .search_chart_list 블록들 중 헤더(첫 블록/라벨) 제외하고 데이터 행 찾기
  const blocks = html.split(/class="[^"]*search_chart_list[^"]*"/i).slice(1);
  for (const block of blocks) {
    const tit = block.match(/class="[^"]*\btit\b[^"]*"[^>]*>([\s\S]*?)<\//i);
    const sng = block.match(/class="[^"]*search_chart_sng[^"]*"[^>]*>([\s\S]*?)<\//i);
    const title = tit ? decode(tit[1]) : "";
    const artist = sng ? decode(sng[1]) : "";
    if (title && artist && !HEADERS.has(title) && !HEADERS.has(artist)) {
      return { title, artist };
    }
  }
  return null;
}

async function fetchKy(no) {
  const res = await fetch(`https://kysing.kr/search/?category=1&keyword=${no}`, {
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9", Referer: "https://kysing.kr/search/" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseSong(await res.text());
}

async function main() {
  if (!process.env.CRAWL_KY) {
    console.log("금영 크롤 비활성 (CRAWL_KY 미설정) — 건너뜀");
    return;
  }
  let data;
  try { data = JSON.parse(readFileSync(OUT, "utf8")); }
  catch { console.log("data/songs.json 없음 — 먼저 TJ 인덱스를 만들어주세요"); return; }
  if (!Array.isArray(data.songs)) { console.log("songs 배열 없음"); return; }

  const byKey = new Map(data.songs.map((s) => [keyOf(s.title, s.artist), s]));
  let cursor = Math.max(101, parseInt(data.kyCursor || "101", 10) || 101);
  if (cursor > END) cursor = 101; // 한 바퀴 돌면 처음부터(신곡·갱신 반영)

  let filled = 0, addedNew = 0, hit = 0;
  const stop = Math.min(cursor + BATCH, END + 1);
  for (let no = cursor; no < stop; no++) {
    try {
      const song = await fetchKy(no);
      if (song) {
        hit++;
        const k = keyOf(song.title, song.artist);
        const ex = byKey.get(k);
        if (ex) {
          if (!ex.ky) { ex.ky = String(no); filled++; }
        } else {
          const item = { title: song.title, artist: song.artist, tj: "", ky: String(no), genre: "", year: null };
          data.songs.push(item);
          byKey.set(k, item);
          addedNew++;
        }
      }
    } catch (e) {
      // 개별 실패는 무시하고 계속
    }
    await sleep(DELAY);
  }

  data.kyCursor = stop > END ? END + 1 : stop;
  data.updatedAt = new Date().toISOString();
  data.count = data.songs.length;
  data.withKy = data.songs.filter((s) => s.ky).length;
  writeFileSync(OUT, JSON.stringify(data) + "\n");
  console.log(`✅ 금영 누적: 번호 ${cursor}~${stop - 1} 프로브 · 유효 ${hit} · ky채움 ${filled} · 신규 ${addedNew} · 다음 커서 ${data.kyCursor}`);
}

main().catch((e) => {
  // 금영 실패는 비치명적: TJ 인덱스는 그대로 유지
  console.error("⚠️ 금영 크롤 실패(무시):", e.message);
  process.exit(0);
});
