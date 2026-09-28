/* =========================================================================
   旅行サイト（1泊2日）  ―  表示とふるまい
   ★このファイルは公開される＝解錠しなくても読める。
     旅行先・地点名・日付が分かる語をコメントにも書かないこと（暗号化スキーム §6）。
     具体的な中身は build/plain/trip-data.js 側にある。
   ========================================================================= */

/* ---------- 定数 ---------- */
const TYPE_LABELS = { spot: "スポット", restaurant: "レストラン", cafe: "カフェ" };
const TYPE_ICONS  = { spot: "💎", restaurant: "🍽", cafe: "☕" };
const CAT_LABELS  = { confirmed: "確定", backup: "予備", warning: "要確認" };

/* ---------- データ ---------- */
/* 旅行データは暗号化された本体（enc/m.bin）に入っている。
   平文の trip-data.js は build/plain 側にしかなく、公開されない。
   ★ここから下のコードは、start() が呼ばれるまで DATA に触らないこと。 */
let DATA = null;
/* 画面の文言。固有名詞を含むので index.html ではなく暗号化された本体に置く（§6） */
let COPY = {};

/* ---------- ユーティリティ ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// **囲むと太字** だけ使える軽量記法。先にエスケープしてから変換するので、
// 生の < > を打たれても壊れない／XSSにもならない。esc() を通す表示はすべてこれを使う。
const mdBold = (s) => esc(s).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
/* ===== 暗号化された画像 =====
   画像は enc/b/*.bin にあり、復号できたものから <img src> に入れる。
   ★imageSrc は「同期」で答える（復号済みなら Blob URL、まだなら ""）。
     これが無いと、絞り込みや並び替えで再描画するたびに画像が消えて点滅する（§5-2）。 */
let imageSrc = (p) => p;          // 既定は素通し（テストや平文プレビュー用）
let requestImage = () => {};      // 復号の依頼先。解錠後に installImageResolver() が入れ替える
/* <img> を作る。src は復号済みのときだけ付け、まだなら data-enc だけ置く */
function encImg(path, attrs) {
  const s = imageSrc(path);
  return `<img${attrs || ""} data-enc="${esc(path)}"${s ? ` src="${esc(s)}"` : ""} loading="lazy">`;
}
/* 描画のたびに、まだ src の無い画像を「見えたら復号する」列に登録する */
let imgObserver = null;
/* DOM が変わったら、まだ src の無い暗号化画像を拾い直す。
   ★描画の入口ごとに hydrateImages() を書いて回ると、新しい描画を足したときに
     「そこだけ画像が出ない」形で静かに壊れる。変化を見て拾えば書き忘れが起きない。 */
let hydrateScheduled = false;
function scheduleHydrate() {
  if (hydrateScheduled) return;
  hydrateScheduled = true;
  const run = () => {
    hydrateScheduled = false;
    // ★ページが閉じられた後に走ることがある（テストの window.close() など）。
    //   document が無い状態で触ると落ちるので、ここで降りる。
    if (typeof document === "undefined" || !document.body) return;
    hydrateImages();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run); else setTimeout(run, 0);
}
function watchForImages() {
  if (typeof MutationObserver !== "function") return;
  new MutationObserver(scheduleHydrate).observe(document.body, { childList: true, subtree: true });
}
function hydrateImages(root) {
  const list = (root || document).querySelectorAll("img[data-enc]:not([src])");
  if (!list.length) return;
  if (typeof IntersectionObserver !== "function") { list.forEach(el => requestImage(el.dataset.enc, el)); return; }
  if (!imgObserver) {
    imgObserver = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        imgObserver.unobserve(en.target);
        requestImage(en.target.dataset.enc, en.target);
      });
    }, { rootMargin: "400px" });
  }
  list.forEach(el => imgObserver.observe(el));
}

const mapsUrl = (q) => "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
// place_id があれば検索結果ではなく「その地点そのもの」を開く（同名店の取り違えを防ぐ）
const placeMapsUrl = (p) => mapsUrl(p.maps || p.name) +
  (p.gmapsPlaceId ? "&query_place_id=" + encodeURIComponent(p.gmapsPlaceId) : "");
// 食べログURLは links から引く（DATAに二重で持たせない＝食い違いが起きない）
const tabelogUrl = (p) => ((p.links || []).find(l => /食べログ|tabelog/i.test(l.label)) || {}).url || null;

/* 全場所をフラットに（type 付き） */
function allPlaces() {
  return [
    ...DATA.spots.map(p => ({ ...p, type: "spot" })),
    ...DATA.restaurants.map(p => ({ ...p, type: "restaurant" })),
    ...DATA.cafes.map(p => ({ ...p, type: "cafe" }))
  ];
}
const placeId = (type, name) => `${type}:${name}`;
function getPlaceById(id) {
  const i = id.indexOf(":");
  const type = id.slice(0, i), name = id.slice(i + 1);
  return allPlaces().find(p => p.type === type && p.name === name) || null;
}
// 名前から placeId を逆引き（スケジュール項目とカードの紐付け用。名前は一意）
function placeIdByName(name) {
  const p = allPlaces().find(x => x.name === name);
  return p ? placeId(p.type, p.name) : null;
}
/* 2地点の直線距離（m）。coords は Places API の location をそのまま入れてあるので、
   「駅から歩けるか」のような判断を **データから計算できる**。
   ★エリアの割り当てをこれで検査する。手で付けたキーが実際の距離とズレても
     画面には何も出ないので、テストで拾う（0-2・追補L-1b）。 */
function distanceM(a, b) {
  if (!a || !b) return null;
  const R = 6371000, rad = d => d * Math.PI / 180;
  const p1 = rad(a[0]), p2 = rad(b[0]);
  const dp = rad(b[0] - a[0]), dl = rad(b[1] - a[1]);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/* 徒歩圏の中心からの距離（m）。中心が DATA に無い旅行では null を返す */
function metersFromWalkCenter(p) {
  const sta = getPlaceById(WALK_CENTER);
  return (sta && p && p.coords) ? distanceM(sta.coords, p.coords) : null;
}

/* =========================================================================
   確定/未確定ステート（全タブ共有・localStorage）
   スケジュール・カード・マップが同じ状態を参照し、どのタブで変えても全タブに反映する。
   初期値の書き換えで既存の編集を上書きしない。変更は画面から共有する。
   ========================================================================= */
const STATUS_KEY = "ise-trip-status";
const STATUS_VERSION = 1;   // 保存形式のバージョン（初期値の変更でリセットしない）
// 全員に配る初期状態。空なら DATA の category から生成（confirmed→確定 / それ以外→未確定）。
const STATUS_DEFAULT = {};
function baseStatusMap() {
  const o = {};
  allPlaces().forEach(p => { o[placeId(p.type, p.name)] = p.category === "confirmed" ? "confirmed" : "tentative"; });
  return { ...o, ...STATUS_DEFAULT };
}
function loadStatusMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(STATUS_KEY));
    if (raw && raw.map && typeof raw.map === "object" && !Array.isArray(raw.map)) return { ...baseStatusMap(), ...raw.map };
  } catch (e) {}
  return baseStatusMap();
}
let statusMap = {};        // start() で読み込む
function saveStatusMap() { localStorage.setItem(STATUS_KEY, JSON.stringify({ v: STATUS_VERSION, map: statusMap })); fbPush("status", statusToArray()); }
function getStatus(id) { return statusMap[id] === "confirmed" ? "confirmed" : "tentative"; }
function setStatus(id, s) { if (!requireSharedEditing()) return; statusMap[id] = (s === "confirmed" ? "confirmed" : "tentative"); saveStatusMap(); rerenderStatus(); }
function toggleStatus(id) { setStatus(id, getStatus(id) === "confirmed" ? "tentative" : "confirmed"); }
const STATUS_LABEL = { confirmed: "確定", tentative: "未確定" };

/* =========================================================================
   行きたい度（★5段階）とメモ ── 2人で共有する
   ★確定/未確定（statusMap）とまったく同じ作法で持つ。地点idをキーにした map を
     localStorage に置き、fbPush で同期する。
   初期値・VERSIONの更新で既存の共有データは消さない。各項目の初期化と送信は独立して行う。
   ========================================================================= */
const WANT_KEY = "ise-trip-want";
const WANT_VERSION = 1;
const NOTE_KEY = "ise-trip-note";
const NOTE_VERSION = 1;
const WANT_MAX = 5;

function loadKeyedMap(key, version) {
  try {
    const raw = JSON.parse(localStorage.getItem(key));
    if (raw && raw.map && typeof raw.map === "object" && !Array.isArray(raw.map)) return { ...raw.map };
  } catch (err) {}
  return {};
}
let wantMap = {};          // start() で読み込む
let noteMap = {};          // start() で読み込む

// Firebase へは status と同じ「配列」の形で出す（RTDB がオブジェクトのキー順を保証しないため）
function wantToArray() { return Object.keys(wantMap).map(id => ({ id, n: getWant(id) })).filter(x => x.n > 0); }
function noteToArray() { return Object.keys(noteMap).map(id => ({ id, t: noteMap[id] })).filter(x => x.t); }

function getWant(id) { const n = parseInt(wantMap[id], 10); return (n >= 1 && n <= WANT_MAX) ? n : 0; }
function saveWant() { localStorage.setItem(WANT_KEY, JSON.stringify({ v: WANT_VERSION, map: wantMap })); fbPush("want", wantToArray()); }
function setWant(id, n) {
  if (!requireSharedEditing()) return;
  const v = Math.max(0, Math.min(WANT_MAX, parseInt(n, 10) || 0));
  if (v === 0) delete wantMap[id]; else wantMap[id] = v;
  saveWant();
  refreshWantRows();
  // ピンに★を出しているときは地図も追随させる（pinlabel列）。地図をまだ開いていなければ何もしない
  if (typeof map !== "undefined" && map) refreshMarkers();
  // 「行きたい度順」で並べているタブだけは並び替え直す（それ以外は順番を動かさない＝押した場所が飛ばない）
  Object.keys(CARD_TABS).forEach(k => { if (cardView[k].sort === "want") renderCardTab(k); });
}
function getNote(id) { return noteMap[id] || ""; }
function saveNote(defer = false) { localStorage.setItem(NOTE_KEY, JSON.stringify({ v: NOTE_VERSION, map: noteMap })); fbPush("note", noteToArray(), defer); }
/* メモは打つたびに保存すると同期が煩いので少し待つ。★再描画はしない
   （入力中に innerHTML を作り直すと、IMEの変換とカーソル位置が飛ぶ） */
let noteTimer = null;
function setNoteDebounced(id, text) {
  if (!requireSharedEditing()) return;
  if (text) noteMap[id] = text; else delete noteMap[id];
  saveNote(true);  // 入力は即座に端末へ保存し、他端末からの受信で消えないようにする。
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { void flushSync(); }, 500);
}

/* ★の行だけを描き直す。カード全体を作り直さないので、開いているメモ欄が閉じない */
function wantStarsHtml(id) {
  const cur = getWant(id);
  const stars = Array.from({ length: WANT_MAX }, (_, i) => {
    const n = i + 1;
    return `<button class="want-star${n <= cur ? " on" : ""}" ${sharedEditAttrs()} data-want-set="${esc(id)}|${n}"
      aria-label="行きたい度を${n}にする" title="行きたい度 ${n}">${n <= cur ? "★" : "☆"}</button>`;
  }).join("");
  return `<span class="want-label">行きたい度</span>${stars}` +
    (cur ? `<button class="want-clear" ${sharedEditAttrs()} data-want-set="${esc(id)}|0" title="評価を消す">×</button>` : "");
}
function refreshWantRows() {
  $$("[data-want-row]").forEach(el => { el.innerHTML = wantStarsHtml(el.dataset.wantRow); });
  // 一覧表の★列も同じ値を見ているので一緒に直す（カードだけ変わって表が古いままにならないように）
  $$("[data-want-cell]").forEach(el => { el.innerHTML = wantStarsShort(el.dataset.wantCell); });
}
/* 同期で届いた★とメモを画面へ。★入力中のメモ欄だけは書き換えない（打っている字が消える） */
function refreshNotes() {
  const active = document.activeElement;
  $$("textarea[data-note]").forEach(t => {
    if (t === active) return;
    const v = getNote(t.dataset.note);
    if (t.value !== v) t.value = v;
  });
}
// status に依存する全ビューを再描画（カード・マップのピン・スケジュール）
function rerenderStatus() {
  renderAllCards();
  if (typeof map !== "undefined" && map) { refreshMarkers(); applyFilters(); }
  if ($("#sched-list")) renderScheduleEditor();
}
/* ===== カードの絞り込み・並び替え（スポット／レストラン／カフェ共通） =====
   絞り込みは「列」を単位にする。列どうしは AND、列の中のチップは OR。
   例) 種類＝屋内・展示 × 犬＝抱っこ → 抱っこで入れる屋内施設だけが残る。
   ★状態は cardView（メモリ）だけに持つ。localStorage にも Firebase にも保存しない
     ＝見る人ごとの一時的な操作であって、同行者の画面まで絞り込まれると事故になる（追補H-9）。 */

// 表示用の genre は店ごとに細かいので、絞り込みはこの粗い区分（genreKey）で行う
const GENRE_GROUPS = [];   // 中身は start() が暗号化された本体から入れる
// スポットの種類（spotKey）。1地点1区分の排他。
const SPOT_GROUPS = [];   // 中身は start() が暗号化された本体から入れる
// エリア（areaKey）。スポットでも店でも同じ語彙を使い回す。
// ★「種類」とは別の列にするのが要点。離れた地域をいくつか回る旅程では、
//   1つの列に混ぜると「あるエリアのある種類だけ」のような掛け合わせが出せなくなる。
//   例: エリア × 種類 → 第一候補が満席のとき、当日でも動ける近場の代替だけが残る。
// ★並びは移動の順。地図と頭の中の順番を合わせる。
// ★車を返したあとに行ける範囲が変わる日は、エリアを「駅から歩けるか」で2つに割ってある。
//   そのあと行けるのは徒歩圏だけになる——その線引きがそのままフィルタになる。
//   境界は WALK_CENTER の地点から 1km。**割り当ての正しさは coords から計算して tools/test_cardtools.js が検査する**
//   （手で付けた areaKey と実際の距離がズレたら落ちる。0-2 静かに壊れるものを作らない）。
const AREA_GROUPS = [];   // 中身は start() が暗号化された本体から入れる
/* 「徒歩圏かどうか」でエリアを割るときの境界。この旅行では中心の駅まわりを
   toba（駅から1km以内）と tobafar（車で移動）に分けるのに使う。
   ★識別子は旅行に依存しない名前にする。テーマは値とラベルだけで表す（追補F-27）。
   ★中心の座標は DATA から引く（同じ事実を2か所に持たない。0-1）。
     この仕組みが要らない旅行では、AREA_GROUPS を距離で割らなければよいだけで、
     ここを消す必要はない（tools/test_days.js の検査は WALK_CENTER が
     DATA に無ければ丸ごと省略される）。 */
const WALK_LIMIT_M = 1000;
let WALK_CENTER = "";   // start() が入れる（地点名なので暗号化側に置く）
// 列の定義。CARD_TABS の filters から参照する
const FILTER_GROUPS = {
  genre: { label: "ジャンル", field: "genreKey", groups: GENRE_GROUPS },
  spot:  { label: "種類",     field: "spotKey",  groups: SPOT_GROUPS },
  area:  { label: "エリア", field: "areaKey",  groups: AREA_GROUPS },
};
const CARD_SORTS = [
  ["default", "おすすめ順"],
  ["want",    "行きたい度の高い順（★）"],
  ["total",   "合計点数の高い順（食べログ＋Google）"],
  ["tabelog", "食べログ点数の高い順"],
  ["google",  "Google点数の高い順"],
];
// スポットには食べログ点数が無いので、店とは別の選択肢にする
const SPOT_SORTS = [
  ["default", "おすすめ順"],
  ["want",    "行きたい度の高い順（★）"],
  ["google",  "Google点数の高い順"],
  ["reviews", "口コミの多い順"],
];
// タブを増やすならここに1行足すだけ。filters は FILTER_GROUPS のキーの配列
const CARD_TABS = {
  spots: {
    target: "#cards-spots", tools: "#tools-spots", table: "#table-spots", type: "spot",
    label: "スポット",
    filters: ["spot", "area"], sorts: SPOT_SORTS, unit: "か所",
    empty: "条件に合う場所がありません。「すべて表示」で戻せます。",
    items: () => DATA.spots,
  },
  restaurants: {
    target: "#cards-restaurants", tools: "#tools-restaurants", table: "#table-restaurants", type: "restaurant",
    label: "レストラン",
    filters: ["genre", "area"], sorts: CARD_SORTS, unit: "店",
    empty: "条件に合う店がありません。「すべて表示」で戻せます。",
    items: () => DATA.restaurants,
  },
  cafes: {
    target: "#cards-cafes", tools: "#tools-cafes", table: "#table-cafes", type: "cafe",
    label: "カフェ",
    filters: ["genre", "area"], sorts: CARD_SORTS, unit: "店",
    empty: "条件に合う店がありません。「すべて表示」で戻せます。",
    items: () => DATA.cafes,
  },
};

/* ===== マップのフィルタ列 =====
   ★値もラベルも、すべてここから作る。index.html には1つも書かない。
     犬のラベルは AREA_GROUPS、日付は TRIP_DAYS が唯一の出どころなので、
     旅行を差し替えるときに index.html を触る必要がない（0-1・追補K-5）。 */
// 「状態」列。CAT_LABELS（確定/予備/要確認）はカードのバッジ用で語彙が違うので使わない
const STATUS_GROUPS = [["confirmed", "確定"], ["tentative", "未確定"]];
// off: true = 初期状態でチェックを入れない（「ルート内のみ」だけ）
const MAP_FILTER_COLUMNS = [
  /* ★日帰り（TRIP_DAYS が1件）のときは列ごと出さない。
     チップが1つだけの列は操作しても何も変わらず、押せるのに効かないUIになる。
     renderMapFilters() は chips が空の列を丸ごと落とし、currentFilters() は
     列が無ければ全日選択とみなすので、ここを空にするだけで筋が通る。
     複数日の旅行では TRIP_DAYS に行を足すだけで復活する。 */
  { group: "day",    label: "日",
    chips: () => TRIP_DAYS.length > 1
      ? TRIP_DAYS.map(d => [d.key, d.label.replace(/（.*?）/, "")]) : [] },
  { group: "type",   label: "種類",
    chips: () => Object.values(CARD_TABS).map(t => [t.type, `${TYPE_ICONS[t.type]} ${t.label}`]) },
  { group: "area",   label: "エリア",
    chips: () => groupsPresentIn(allPlaces(), "area").map(([k, l]) => [k, l]) },
  { group: "status", label: "状態",   chips: () => STATUS_GROUPS },
  /* 「ルート内」＝スケジュールの予定に紐づいている地点。ラベルは実態に合わせる。
     ★2チップにしてあるのは「まだ入れていない地点」を探せるようにするため
       （地図を見ながら予定を組むときに、いちばん見たいのがこれ）。
       他の列と同じく、0個チェックも全部チェックも「素通し」。 */
  { group: "route",  label: "予定", off: true,
    chips: () => [["route-only", "🗓 予定に入っている"], ["route-none", "🆕 まだ入っていない"]] },
  /* ピンに重ねる情報（点数・行きたい度）。★これは絞り込みではなく「表示の重ね着」。
     currentFilters() はこの列を読まないので、チェックしてもピンは消えないしルートも変わらない
     （検査は tools/test_days.js §8d）。初期オフ＝既定では地図が文字で埋まらない。
     ★チェック状態は DOM のチェックボックスだけに持つ。localStorage にも Firebase にも
       保存しない——見る人ごとの表示状態で、同行者の画面まで変わると事故になる（追補H-9）。
       マップの他の列と同じ持ち方なので、そのための仕掛けは何も要らない。 */
  { group: "pinlabel", label: "ピンに表示", off: true,
    chips: () => [["name", "🏷 地点名"], ["google", "⭐ Google点数"], ["tabelog", "🍴 食べログ点数"], ["want", "★ 行きたい度"]] },
];
// sets[列ID] が未設定 = 未初期化（初回に全選択にする）
// open: 一覧表の開閉。★localStorage にも Firebase にも保存しない（見る人ごとの表示状態。追補H-9）
//       ただし renderCardTab() は絞り込み・確定トグル・Firebase受信のたびに走るので、
//       ここに控えておかないとチップを押すたびに表が勝手に閉じる。
const cardView = {
  spots:       { sets: {}, sort: "default", open: false },
  restaurants: { sets: {}, sort: "default", open: false },
  cafes:       { sets: {}, sort: "default", open: false },
};

const numOr = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
// 合計は「片方しか無い店」も比較できるよう、欠けている側を0として足す（＝下に沈む）
/* 並び替えのキー。★want は地点idが要るので、呼ぶ側からタブの type をもらう
   （viewedItems が渡す p は DATA の生オブジェクトで type を持たない） */
function cardScore(p, kind, type) {
  if (kind === "want") { const n = getWant(placeId(type, p.name)); return n > 0 ? n : null; }
  const t = numOr(p.ratings && p.ratings.tabelog);
  const g = numOr(p.ratings && p.ratings.google);
  if (kind === "tabelog") return t;
  if (kind === "google")  return g;
  if (kind === "reviews") return numOr(p.ratings && p.ratings.googleReviews);
  if (kind === "total")   return (t == null && g == null) ? null : (t || 0) + (g || 0);
  return null;
}
/* その地点が属する区分。キーの付け忘れは "other" になり、どの区分にも含まれないので
   静かに一覧から消える（追補D-2c）。tools/test_cardtools.js の「キー欠落の検出」で拾う。 */
function groupKeyOf(p, gid) { return p[FILTER_GROUPS[gid].field] || "other"; }

function viewedItems(key) {
  const v = cardView[key], t = CARD_TABS[key], all = t.items();
  // 列どうしは AND、列の中は OR。未初期化の列は素通しする
  const list = all.filter(p => t.filters.every(gid => {
    const set = v.sets[gid];
    return !set || set.has(groupKeyOf(p, gid));
  }));
  if (v.sort === "default") return list;
  // 元の並びを保った安定ソート。点数が無い店は末尾へ
  return list.map((p, i) => ({ p, i })).sort((a, b) => {
    const sa = cardScore(a.p, v.sort, t.type), sb = cardScore(b.p, v.sort, t.type);
    if (sa == null && sb == null) return a.i - b.i;
    if (sa == null) return 1;
    if (sb == null) return -1;
    return (sb - sa) || (a.i - b.i);
  }).map(x => x.p);
}

/* 渡した地点の中に実在する区分だけを [キー, ラベル, 件数] で返す（0件の区分はチップを出さない）。
   ★カードは1タブぶん、マップは allPlaces()（全タブ）を渡す。絞り込みの語彙を二重に持たないため、
     どちらもこの1本を通す。 */
function groupsPresentIn(items, gid) {
  return FILTER_GROUPS[gid].groups
    .map(([k, label]) => [k, label, items.filter(p => groupKeyOf(p, gid) === k).length])
    .filter(x => x[2] > 0);
}
function presentGroups(key, gid) { return groupsPresentIn(CARD_TABS[key].items(), gid); }
/* 全列を全選択に戻す（初期化と「すべて表示」で共用） */
function resetCardFilters(key) {
  const v = cardView[key];
  CARD_TABS[key].filters.forEach(gid => { v.sets[gid] = new Set(presentGroups(key, gid).map(x => x[0])); });
}

function renderCardTools(key) {
  const t = CARD_TABS[key];
  const el = $(t.tools); if (!el) return;
  const all = t.items();
  const v = cardView[key];

  // 列ごとにチップを作る。data-fgroup でどの列のチップかを持たせる（値の重複に依存しない）
  // ★チップは必ず .chip-row で包む。2列グリッドの右カラムに収まるので、
  //   何行に折り返してもラベルの下に回り込まない（ゾーンの境目が見えなくなる原因だった）
  const rows = t.filters.map(gid => {
    const present = presentGroups(key, gid);
    if (!v.sets[gid]) v.sets[gid] = new Set(present.map(x => x[0]));
    const set = v.sets[gid];
    const chips = present.map(([k, label, n]) =>
      `<label class="chip"><input type="checkbox" data-fgroup="${gid}" value="${k}" ${set.has(k) ? "checked" : ""}> ${label}<span class="chip-n">${n}</span></label>`).join("");
    return `<div class="filter-group" data-fgroup="${gid}">
      <span class="filter-label">${esc(FILTER_GROUPS[gid].label)}</span>
      <div class="chip-row">${chips}</div>
    </div>`;
  }).join("");

  const opts = t.sorts.map(([k, l]) => `<option value="${k}"${v.sort === k ? " selected" : ""}>${esc(l)}</option>`).join("");
  const shown = viewedItems(key).length;
  // 「すべて表示」と件数は全ゾーンにかかる操作なので、ゾーンの外＝見出し行に置く
  el.innerHTML = `
    <div class="tools-head">
      <span class="tools-title">絞り込み</span>
      <span class="muted card-tool-count">${shown} / ${all.length}${t.unit}</span>
      <button class="btn-ghost card-tool-all">すべて表示</button>
    </div>` + rows + `
    <div class="filter-group">
      <span class="filter-label">並び替え</span>
      <div class="chip-row">
        <select class="card-tool-sort" aria-label="並び替え">${opts}</select>
      </div>
    </div>`;

  $$(t.tools + " input[type=checkbox]").forEach(i => i.addEventListener("change", e => {
    const gid = e.currentTarget.dataset.fgroup;
    const set = cardView[key].sets[gid], val = e.currentTarget.value;
    e.currentTarget.checked ? set.add(val) : set.delete(val);
    renderCardTab(key);
  }));
  // 「すべて表示」は絞り込みと並び替えの両方を初期化する（片方だけ戻ると迷子になる）
  $(t.tools + " .card-tool-all").addEventListener("click", () => {
    resetCardFilters(key);
    cardView[key].sort = "default";
    renderCardTab(key);
  });
  $(t.tools + " .card-tool-sort").addEventListener("change", e => {
    cardView[key].sort = e.currentTarget.value;
    renderCardTab(key);
  });
}

/* ===== 一覧表（各タブのカードの上に置く折りたたみ式の索引） =====
   ★行は viewedItems() をそのまま描く。絞り込み条件を二重に実装しないので、
     地点を足せば行も増え、チップを押せば表も追随する。 */
// 表の点数欄。狭いので口コミ件数は出さない。数値は p.ratings から引く（書き写さない）
/* 一覧表の★欄。押せるのはカード側だけにして、表は見るだけにする（行タップはカードへの移動） */
function wantStarsShort(id) {
  const n = getWant(id);
  return n ? `<span class="ct-star">${"★".repeat(n)}</span>` : `<span class="muted">—</span>`;
}
function tableScore(p) {
  const r = p.ratings || {}, out = [];
  if (r.tabelog) out.push(`<span class="ct-tabelog">🍴${esc(r.tabelog)}</span>`);
  if (r.google)  out.push(`<span class="ct-google">⭐${esc(r.google)}</span>`);
  return out.length ? out.join(" ") : `<span class="muted">—</span>`;
}
/* 行 → その地点のカードへ移動。
   地点idは "spot:五老ヶ岳公園・五老スカイタワー" のように : と日本語を含むので、CSSセレクタではなく
   data 属性の突き合わせで引く（エスケープ事故を避ける）。 */
function gotoPlaceCard(key, id) {
  const card = $$(CARD_TABS[key].target + " .card").find(c => c.dataset.place === id);
  if (!card) return;   // 表とカードは同じ viewedItems から作るので通常ここには来ない
  if (browseViews[key]?.open) scrollBrowseCard(key, id);
  else card.scrollIntoView({ behavior: "smooth", block: "start" });
  // 連続でタップしてもハイライトが再生されるよう、一度外してリフローを挟む
  card.classList.remove("just-jumped");
  void card.offsetWidth;
  card.classList.add("just-jumped");
}
function renderCardTable(key) {
  const t = CARD_TABS[key];
  const box = $(t.table); if (!box) return;
  const list = viewedItems(key), v = cardView[key];
  // ★viewedItems() が返すのは DATA の生オブジェクトで type を持たない
  //   （type は renderCards() が {...p, type} で足している）。
  //   ここで p.type を使うと data-goto が "undefined:五老ヶ岳公園・五老スカイタワー" になり、
  //   飛び先が静かに切れる。タブ定義の t.type を使うこと。
  const rows = list.map(p => {
    const id = placeId(t.type, p.name);
    return `<tr class="ct-row" data-goto="${esc(id)}" tabindex="0" role="button" title="${esc(p.name)}の詳細へ移動">
      <td class="ct-name">${TYPE_ICONS[t.type]} ${esc(p.name)}</td>
      <td class="ct-area">${areaChip(p)}</td>
      <td class="ct-want" data-want-cell="${esc(id)}">${wantStarsShort(id)}</td>
      <td class="ct-score">${tableScore(p)}</td>
    </tr>`;
  }).join("");
  box.innerHTML = `<details class="ct-details"${v.open ? " open" : ""}>
    <summary class="ct-summary">一覧で見る<span class="ct-n">${list.length}${esc(t.unit)}</span></summary>
    <div class="ct-wrap">
      <table class="ct">
        <thead><tr><th>名前</th><th>エリア</th><th>★</th><th>点数</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="muted">${esc(t.empty)}</td></tr>`}</tbody>
      </table>
    </div>
  </details>`;

  // 開閉を控える（再描画で閉じてしまわないように）
  $(t.table + " .ct-details").addEventListener("toggle", e => { cardView[key].open = e.currentTarget.open; });
  // 行をタップ／Enter でカードへ移動
  $$(t.table + " .ct-row").forEach(tr => {
    const go = () => gotoPlaceCard(key, tr.dataset.goto);
    tr.addEventListener("click", go);
    tr.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  });
}

function renderCardTab(key) {
  // 同期・確定切替でも入力中のカードは再利用する。メモのDOM維持はrenderPlaceCardsに集約。
  renderCardTools(key);
  renderCardTable(key);
  const t = CARD_TABS[key], list = viewedItems(key);
  const box = $(t.target); if (!box) return;
  renderPlaceCards(box, list.map(p => ({ ...p, type: t.type })), t.empty);
  if (activeBrowseKey() === key && map) applyFilters();
}

/* ★カード再描画の唯一の入口。個別に renderCards() を呼ぶとツールバーを通らず、
   器はあるのに中身が空になる（追補F-11でいちばん時間を溶かした落とし穴）。 */
function renderAllCards() {
  $$("[data-place-count]").forEach(el => { el.textContent = String((DATA[el.dataset.placeCount] || []).length); });
  Object.keys(CARD_TABS).forEach(renderCardTab);
  renderMapCards();
}

/* =========================================================================
   カードレンダリング
   ========================================================================= */
function renderImageBlock(p) {
  const imgs = p.images || [];
  if (!imgs.length) return `<div class="card-imgwrap"><div class="card-noimg">${TYPE_ICONS[p.type] || "🖼"}</div>${catRibbon(p)}</div>`;
  const data = esc(JSON.stringify(imgs));
  const main = `<button class="card-img-btn" data-images='${data}' data-index="0" aria-label="拡大">
      ${encImg(imgs[0], ` class="card-img" alt="${esc(p.name)}"`)}</button>`;
  let thumbs = "";
  if (imgs.length > 1) {
    thumbs = `<div class="card-thumbs">` + imgs.slice(1, 4).map((src, k) =>
      `<button class="thumb-btn" data-images='${data}' data-index="${k + 1}" aria-label="拡大">${encImg(src, ' class="thumb" alt=""')}</button>`
    ).join("") + `</div>`;
  }
  return `<div class="card-imgwrap">${main}${catRibbon(p)}</div>${thumbs}`;
}
function catRibbon(p) {
  const id = placeId(p.type, p.name);
  const st = getStatus(id);
  return `<button type="button" class="cat-ribbon status-${st}" ${sharedEditAttrs()} data-status-toggle="${esc(id)}" title="タップで確定／未確定を切替">${STATUS_LABEL[st]}</button>`;
}
function ratingChips(p) {
  if (!p.ratings) return "";
  const r = p.ratings, chips = [];
  const rev = (n) => n ? `（${esc(n)}件）` : "";
  // 点数チップはタップで出典へ飛ぶ。食べログは links の食べログURL、Googleは place_id 付きマップURL。
  // URLが無い地点は <span> のまま（リンク切れを作らない）。
  const chip = (cls, label, url) => url
    ? `<a class="rating-chip ${cls} is-link" href="${esc(url)}" target="_blank" rel="noopener">${label}</a>`
    : `<span class="rating-chip ${cls}">${label}</span>`;
  // 飲食店は食べログ・Googleの両点数を件数つきで併記（§8-2）。google は Places API で取得。
  if (r.tabelog) chips.push(chip("tabelog", `🍴 食べログ ${esc(r.tabelog)}${rev(r.tabelogReviews || r.reviews)}`, tabelogUrl(p)));
  if (r.google)  chips.push(chip("google",  `⭐ Google ${esc(r.google)}${rev(r.googleReviews)}`, placeMapsUrl(p)));
  return chips.length ? `<div class="ratings">${chips.join("")}</div>` : "";
}
function linkPills(p) {
  const pills = [`<a class="pill maps" href="${placeMapsUrl(p)}" target="_blank" rel="noopener">📍 Googleマップ</a>`];
  (p.links || []).forEach(l => {
    const cls = /食べログ|tabelog/i.test(l.label) ? "pill tabelog" : "pill";
    const icon = /食べログ/.test(l.label) ? "🍴" : "🔗";
    pills.push(`<a class="${cls}" href="${esc(l.url)}" target="_blank" rel="noopener">${icon} ${esc(l.label)}</a>`);
  });
  // その地点に紐づくチケットがあれば、チケットタブへのピルを出す（紐づけは DATA.tickets 側が持つ）
  ticketsFor(placeId(p.type, p.name)).forEach(t =>
    pills.push(`<button class="pill ticket" data-goto-ticket="${esc(t.id)}">🎫 ${esc(t.title)}</button>`));
  pills.push(`<button class="pill add-sched" ${sharedEditAttrs()} data-add-sched="${esc(placeId(p.type, p.name))}">＋ スケジュールに追加</button>`);
  return `<div class="card-links">${pills.join("")}</div>`;
}
/* メモ欄の開閉は「見る人ごとの一時的な表示状態」なので保存も同期もしない（追補H-9）。
   ただし再描画のたびに閉じると入力が続けられないので、メモリには控えておく。 */
const cardNoteOpen = {};
function renderCard(p) {
  const pid = placeId(p.type, p.name);
  const badges = (p.badges || []).map(b => `<span class="badge ${esc(b.cls)}">${esc(b.text)}</span>`).join("");
  const meta = (p.meta || []).map(m => `<li><b>${esc(m[0])}</b><span>${mdBold(m[1])}</span></li>`).join("");
  return `<article class="card" data-place="${esc(pid)}">
    ${renderImageBlock(p)}
    <div class="card-body">
      <h3 class="card-title">${esc(p.name)}</h3>
      <div class="card-sub">
        ${p.genre ? `<span class="genre-chip">${esc(p.genre)}</span>` : ""}
        <span class="card-area">${esc(p.area)}</span>
      </div>
      ${badges ? `<div class="badges">${badges}</div>` : ""}
      ${ratingChips(p)}
      <div class="want-row" data-want-row="${esc(pid)}">${wantStarsHtml(pid)}</div>
      <p class="card-desc">${mdBold(p.desc)}</p>
      ${meta ? `<ul class="card-meta">${meta}</ul>` : ""}
      ${p.notes ? `<div class="card-notes">${p.notes}</div>` : ""}
      <details class="note-box"${cardNoteOpen[pid] ? " open" : ""}>
        <summary>📝 メモ${getNote(pid) ? `<span class="note-dot" title="メモがあります">●</span>` : ""}</summary>
        <textarea class="note-input" ${sharedEditAttrs()} ${canEditShared() ? "" : "readonly"} data-note="${esc(pid)}"
          placeholder="ここに書いたメモは2人で共有されます（例: 予約した／席の希望／苦手なもの）">${esc(getNote(pid))}</textarea>
      </details>
      ${linkPills(p)}
      <button class="btn-ghost browse-locate" data-browse-locate="${esc(pid)}">地図で確認</button>
    </div>
  </article>`;
}
function renderCards(targetId, items, type) {
  renderPlaceCards($(targetId), items.map(p => ({ ...p, type })));
}

// 同じ地点のDOMを再利用する。別タブの同名カードへフォーカスを移さず、IME変換も維持する。
function renderPlaceCards(box, items, empty = "条件に合う地点がありません。") {
  if (!box) return;
  const active = document.activeElement, focused = box.contains(active);
  const selection = focused && active.matches("textarea") ? [active.selectionStart, active.selectionEnd] : null;
  const scroller = box.closest(".browse-cards"), scroll = scroller?.scrollTop;
  const existing = new Map($$(".card", box).map(c => [c.dataset.place, c]));
  let cursor = box.firstElementChild;
  items.forEach(p => {
    const id = placeId(p.type, p.name), old = existing.get(id);
    let card = old;
    if (!card) {
      const template = document.createElement("template");
      template.innerHTML = renderCard(p); card = template.content.firstElementChild;
    } else {
      const ribbon = $(".cat-ribbon", card), status = getStatus(id);
      ribbon.className = `cat-ribbon status-${status}`; ribbon.textContent = STATUS_LABEL[status];
      const stars = $(".want-row", card), html = wantStarsHtml(id);
      if (stars.innerHTML !== html) stars.innerHTML = html;
      const note = $("textarea[data-note]", card);
      if (note !== active && note.value !== getNote(id)) note.value = getNote(id);
      $(".note-box summary", card).innerHTML = `📝 メモ${getNote(id) ? '<span class="note-dot" title="メモがあります">●</span>' : ""}`;
    }
    if (card !== cursor) box.insertBefore(card, cursor);
    cursor = card.nextElementSibling; existing.delete(id);
  });
  existing.forEach(card => card.remove());
  $$(":scope > p", box).forEach(p => p.remove());
  if (!items.length) box.innerHTML = `<p class="muted">${esc(empty)}</p>`;
  if (focused && active.isConnected && document.activeElement !== active) {
    active.focus({ preventScroll: true });
    if (selection) active.setSelectionRange(...selection);
  }
  if (scroller) scroller.scrollTop = scroll;
}

/* ===== 地図とカードの比較。表示条件は既存の各タブだけが持つ ===== */
const BROWSE_LAYOUT_KEY = "ise-trip-browse-layout";
const browseViews = Object.fromEntries(["spots", "restaurants", "cafes", "map"].map(key =>
  [key, { open: false, selected: null, hover: null, focused: null, scroll: 0 }]));
let browsePrefs = loadBrowseLayout(), browseController = null;
let mapContext = "shared";
const mapViews = {};
function activeBrowseKey() {
  const key = $("#tabs .tab.active")?.dataset.tab;
  return browseViews[key]?.open ? key : null;
}
function browsePlaces(key) {
  return key === "map" ? filteredMapPlaces() : viewedItems(key).map(p => ({ ...p, type: CARD_TABS[key].type }));
}
function renderMapCards() {
  if (!browseViews.map.open) return;
  renderPlaceCards($("#cards-map"), filteredMapPlaces());
  reconcileBrowseSelection("map");
}
function loadBrowseLayout() {
  const out = {};
  try {
    const raw = JSON.parse(localStorage.getItem(BROWSE_LAYOUT_KEY));
    if (raw?.v !== 1) return out;
    for (const key of ["spots", "restaurants", "cafes", "map"]) {
      const r = raw.ratios?.[key], sum = Array.isArray(r) && r.reduce((a, b) => a + b, 0);
      if (r?.length === 2 && r.every(x => Number.isFinite(x) && x > 0) && Number.isFinite(sum)) out[key] = r.map(x => x / sum);
    }
  } catch (e) {}
  return out;
}
function saveBrowseWidths(c) {
  const sum = c.widths.reduce((a, b) => a + b, 0);
  browsePrefs[c.key] = c.widths.map(x => x / sum);
  try { localStorage.setItem(BROWSE_LAYOUT_KEY, JSON.stringify({ v: 1, ratios: browsePrefs })); } catch (e) {}
}
function applyBrowseWidths(c, widths) {
  c.widths = widths;
  c.root.style.gridTemplateColumns = `${widths[0]}px 16px ${widths[1]}px`;
  c.handle.setAttribute("aria-valuemin", "280");
  c.handle.setAttribute("aria-valuemax", String(Math.floor(widths[0] + widths[1] - 280)));
  c.handle.setAttribute("aria-valuenow", String(Math.round(widths[0])));
  c.handle.setAttribute("aria-valuetext", `${Math.round(widths[0])}ピクセル`);
}
function endBrowseResize(commit = false) {
  const c = browseController, d = c?.drag; if (!d) return;
  c.drag = null;
  d.events.abort();
  if (d.handle.hasPointerCapture?.(d.id)) d.handle.releasePointerCapture(d.id);
  document.body.classList.remove("browse-resizing");
  if (commit) saveBrowseWidths(c); else applyBrowseWidths(c, d.widths);
}
function startBrowseResize(e) {
  const c = browseController;
  if (!c || c.phone || e.button !== 0 || e.isPrimary === false) return;
  endBrowseResize(); endPinDrag(); cancelMapPinch();
  e.preventDefault(); e.stopPropagation();
  const d = { handle: e.currentTarget, id: e.pointerId, x: e.clientX, widths: c.widths.slice(), events: new AbortController() };
  const opts = { signal: d.events.signal };
  const move = e => {
    if (e.pointerId !== d.id) return;
    e.preventDefault(); applyBrowseWidths(c, moveSchedBoundary(d.widths, [280, 280], 0, e.clientX - d.x));
  };
  c.drag = d;
  window.addEventListener("pointermove", move, { ...opts, passive: false });
  window.addEventListener("pointerup", e => { if (e.pointerId === d.id) { move(e); endBrowseResize(true); } }, opts);
  const cancel = () => endBrowseResize();
  window.addEventListener("pointercancel", cancel, opts);
  window.addEventListener("blur", cancel, opts);
  window.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); cancel(); } }, opts);
  d.handle.addEventListener("lostpointercapture", cancel, opts);
  d.handle.setPointerCapture?.(d.id);
  document.body.classList.add("browse-resizing");
}
function resizeBrowseByKey(e) {
  const c = browseController, delta = { ArrowLeft: -16, ArrowRight: 16, Home: -Infinity, End: Infinity }[e.key];
  if (!c || c.phone || delta === undefined) return;
  e.preventDefault(); e.stopPropagation(); endBrowseResize(); cancelMapPinch();
  applyBrowseWidths(c, moveSchedBoundary(c.widths, [280, 280], 0, delta)); saveBrowseWidths(c);
}
function refreshBrowseLayout() {
  const c = browseController; if (!c) return;
  const width = c.root.getBoundingClientRect().width;
  const phone = window.innerWidth < 760 || (width > 0 && width < 576);
  if (phone !== c.phone || width !== c.available) endBrowseResize();
  const returningToColumns = c.phone === true && !phone;
  if (c.phone === false && phone) browseViews[c.key].scroll = c.scroller.scrollTop;
  c.phone = phone; c.available = width;
  const tabsHeight = $("#tabs")?.getBoundingClientRect().height || 52;
  c.root.style.setProperty("--browse-tabs-height", `${tabsHeight}px`);
  c.root.style.setProperty("--browse-height", `${Math.max(360, Math.min(760, window.innerHeight - tabsHeight - 32))}px`);
  c.root.dataset.layout = phone ? "phone" : "columns";
  c.root.classList.toggle("no-sticky", window.innerHeight < 520 || !!document.activeElement?.matches("textarea, input:not([type=checkbox]):not([type=radio]), [contenteditable=true]"));
  c.handle.hidden = phone;
  $(`#browse-reset-${c.key}`).hidden = phone;
  if (phone) c.root.style.removeProperty("grid-template-columns");
  else if (width > 0 && !c.drag) applyBrowseWidths(c, fitSchedWidths(width - 16, browsePrefs[c.key] || [.6, .4], [280, 280]));
  if (returningToColumns) c.scroller.scrollTop = browseViews[c.key].scroll;
  queueMapResize();
}
function syncBrowseLayout() {
  const key = activeBrowseKey();
  if (browseController?.key === key) { refreshBrowseLayout(); return; }
  if (browseController) {
    endBrowseResize();
    if (browseViews[browseController.key].open && $(`#panel-${browseController.key}.active`)) {
      browseViews[browseController.key].scroll = browseController.scroller.scrollTop;
    }
    browseController.observer?.disconnect();
    browseController = null;
  }
  if (!key) return;
  const root = $(`#browse-${key}`);
  if (!root) return;
  const scroller = $(".browse-cards", root);
  browseController = { key, root, scroller, handle: $(".browse-splitter", root), widths: [], phone: null, available: null };
  if (typeof ResizeObserver === "function") {
    browseController.observer = new ResizeObserver(refreshBrowseLayout);
    browseController.observer.observe(root);
    browseController.observer.observe($("#tabs"));
  }
  refreshBrowseLayout(); scroller.scrollTop = browseViews[key].scroll;
}
function rememberBrowseScroll() {
  if (browseController && !browseController.phone) browseViews[browseController.key].scroll = browseController.scroller.scrollTop;
}
function toggleBrowse(key) {
  rememberBrowseScroll(); endBrowseResize();
  const v = browseViews[key]; v.open = !v.open;
  v.hover = null; v.focused = null;
  if (!v.open) { focusPin(null); map?.closePopup(); }
  const root = $(`#browse-${key}`);
  root.classList.toggle("is-open", v.open);
  $(".browse-map-pane", root).hidden = key !== "map" && !v.open;
  $(".browse-cards", root).hidden = key === "map" && !v.open;
  $(".browse-map-actions", root).hidden = !v.open;
  $(".browse-splitter", root).hidden = !v.open;
  $(`#browse-reset-${key}`).hidden = !v.open;
  const toggle = $(`#browse-toggle-${key}`);
  toggle.textContent = key === "map" ? (v.open ? "カードを閉じる" : "カードを表示") : (v.open ? "地図を閉じる" : "地図を開く");
  toggle.setAttribute("aria-expanded", String(v.open));
  if (key === "map" && v.open) renderMapCards();
  syncMapDock(); syncBrowseLayout();
  if (v.open && !map) $(".browse-map-message", root).textContent = "地図を読み込めません。ページを再読み込みしてください。";
}
function setupBrowse() {
  for (const key of Object.keys(browseViews)) {
    const isMap = key === "map", anchor = isMap ? $("#map-dock-home") : $(CARD_TABS[key].target);
    const controls = document.createElement("div"); controls.className = "browse-controls";
    controls.innerHTML = `<button class="btn-ghost" id="browse-toggle-${key}" aria-expanded="false" aria-controls="browse-${key}">${isMap ? "カードを表示" : "地図を開く"}</button><button class="btn-ghost" id="browse-reset-${key}" hidden>列幅を標準に戻す</button>`;
    const root = document.createElement("div"); root.id = `browse-${key}`; root.className = "browse-layout";
    root.innerHTML = `<div class="browse-map-pane"${isMap ? "" : " hidden"}>
      <div class="browse-map-actions" hidden><button class="btn-ghost browse-fit">表示中の地点を収める</button><button class="btn-ghost browse-close">${isMap ? "カードを閉じる" : "地図を閉じる"}</button></div>
      <div class="browse-map-message muted" role="status"></div><div class="browse-map-slot" id="browse-slot-${key}"></div></div>
      <div class="browse-splitter" role="separator" tabindex="0" aria-orientation="vertical" aria-label="地図の列幅" aria-controls="browse-slot-${key}" hidden></div>
      <div class="browse-cards" id="browse-list-${key}" role="region" aria-label="${isMap ? "地図の地点" : CARD_TABS[key].label}のカード一覧"${isMap ? " hidden" : ""}></div>`;
    anchor.before(controls, root);
    if (isMap) {
      const filters = document.createElement("div"); filters.id = "browse-map-filter-slot"; controls.before(filters);
      $(".browse-map-slot", root).appendChild(anchor);
      $(".browse-cards", root).innerHTML = '<div class="cards" id="cards-map"></div>';
    } else $(".browse-cards", root).appendChild(anchor);
    $(`#browse-toggle-${key}`).addEventListener("click", () => toggleBrowse(key));
    $(".browse-close", root).addEventListener("click", () => { toggleBrowse(key); $(`#browse-toggle-${key}`).focus({ preventScroll: true }); });
    $(".browse-fit", root).addEventListener("click", fitBrowsePlaces);
    $(`#browse-reset-${key}`).addEventListener("click", () => {
      endBrowseResize(); delete browsePrefs[key];
      try { localStorage.setItem(BROWSE_LAYOUT_KEY, JSON.stringify({ v: 1, ratios: browsePrefs })); } catch (e) {}
      refreshBrowseLayout();
    });
    $(".browse-splitter", root).addEventListener("pointerdown", startBrowseResize);
    $(".browse-splitter", root).addEventListener("keydown", resizeBrowseByKey);
    const list = $(".browse-cards", root);
    list.addEventListener("pointerover", e => {
      if (activeBrowseKey() !== key || e.pointerType === "touch") return;
      browseViews[key].hover = e.target.closest(".card")?.dataset.place || null; updateBrowseFocus();
    });
    list.addEventListener("pointerleave", () => { browseViews[key].hover = null; updateBrowseFocus(); });
    list.addEventListener("focusin", e => {
      browseViews[key].focused = e.target.closest(".card")?.dataset.place || null; updateBrowseFocus();
    });
    list.addEventListener("focusout", e => {
      browseViews[key].focused = list.contains(e.relatedTarget) ? e.relatedTarget.closest(".card")?.dataset.place : null; updateBrowseFocus();
    });
    list.addEventListener("click", e => {
      if (activeBrowseKey() !== key) return;
      const card = e.target.closest(".card"); if (!card) return;
      const locate = e.target.closest("[data-browse-locate]");
      if (!locate && (e.target.closest("button, a, input, textarea, select, summary, details, [contenteditable]") || String(window.getSelection?.() || ""))) return;
      selectBrowsePlace(key, card.dataset.place, false);
    });
  }
  window.addEventListener("resize", refreshBrowseLayout);
  document.addEventListener("focusin", refreshBrowseLayout);
  document.addEventListener("focusout", () => requestAnimationFrame(refreshBrowseLayout));
  document.addEventListener("visibilitychange", () => { if (document.hidden) endBrowseResize(); });
}
function reconcileBrowseSelection(key) {
  const v = browseViews[key], ids = new Set(browsePlaces(key).map(p => placeId(p.type, p.name)));
  if (v.selected && !ids.has(v.selected)) { v.selected = null; if (activeBrowseKey() === key) map?.closePopup(); }
  for (const field of ["hover", "focused"]) if (!ids.has(v[field])) v[field] = null;
  if (activeBrowseKey() === key) updateBrowseFocus();
}
function updateBrowseFocus() {
  const key = activeBrowseKey(); if (!key) return;
  const v = browseViews[key]; focusPin(v.hover || v.focused || v.selected);
  $$(`#browse-list-${key} .card`).forEach(card => card.classList.toggle("is-map-selected", card.dataset.place === v.selected));
}
function scrollBrowseCard(key, id) {
  const list = $(`#browse-list-${key}`), card = $$(".card", list).find(c => c.dataset.place === id);
  if (!card) return;
  const smooth = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  if (browseController?.key === key && !browseController.phone) {
    const top = card.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTo?.({ top: Math.max(0, top - 4), behavior: smooth });
  } else {
    const root = $(`#browse-${key}`), pane = $(".browse-map-pane", root);
    const offset = root.classList.contains("no-sticky") ? 12 : pane.getBoundingClientRect().height + ($("#tabs")?.getBoundingClientRect().height || 52) + 12;
    window.scrollTo({ top: window.scrollY + card.getBoundingClientRect().top - offset, behavior: smooth });
  }
}
function selectBrowsePlace(key, id, fromPin) {
  const m = markers[id]; if (!m || !markerLayer.hasLayer(m)) return;
  const v = browseViews[key]; v.selected = id; v.hover = null; v.focused = null; updateBrowseFocus();
  if (fromPin) scrollBrowseCard(key, id);
  else {
    cancelMapPinch();
    const point = map.latLngToContainerPoint(m.getLatLng()), size = map.getSize();
    if (point.x < 50 || point.x > size.x - 50 || point.y < 60 || point.y > size.y - 50) map.panTo(m.getLatLng(), { animate: false });
    m.openPopup();
  }
}
function fitBrowsePlaces() {
  const key = activeBrowseKey(); if (!map || !key) return;
  const points = browsePlaces(key).map(p => p.coords);
  if (!points.length) return;
  cancelMapPinch(); map.closePopup();
  map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 15, animate: false });
}

/* =========================================================================
   スケジュール / ルート / 持ち物 / 注意
   ========================================================================= */
/* =========================================================================
   スケジュールの「読む」表示（②形式）

   ★本命プラン（schedule）と予備プラン（plans[].items）は同じ形の行を持つので、
     描画はこの1本だけ。二重に実装しない（0-1）。
     行の形 = { day, time, end, text, status, ref }
   ========================================================================= */

/* 行を日ごとにまとめる（TRIP_DAYS の順。day を持たない行は初日に寄せる） */
function rowsByDay(rows) {
  const m = new Map();
  rows.forEach(it => {
    const d = normalizeDay(it.day);
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(it);
  });
  return DAY_KEYS.filter(d => m.has(d)).map(d => ({ day: d, rows: m.get(d) }));
}

/* 1行ぶんの「読む」表示。★表示専用。入力欄もトグルも出さない（誤タップ対策）。 */
function scheduleRowReadHtml(it) {
  // 確定状態は ref があれば全タブ共有のものを引く（プラン内の文字列ではなく“いまの本物”）
  const st = it.ref ? getStatus(it.ref) : (it.status === "confirmed" ? "confirmed" : "tentative");
  const time = it.time || "—";
  const when = it.end ? `${esc(time)}<span class="tl-end">〜${esc(it.end)}</span>` : esc(time);
  /* ★紐づいている地点は名前を出す。本文からは読み取れないことが多いため
     （例:「伊根 到着・駐車」→ 伊根浦公園駐車場 / 「三宮を出発」→ 三宮（合流・送迎））。
     この ref がマップのピン順を決めているので、見えないと確認できない。
     リンクは地点チップだけにする（本文にも張ると1行にリンクが2つになる）。 */
  /* 地点チップは行き先が2つある。押し分けられるよう1つのピルを区切って並べる。
     ・地点名 → その地点のカード（写真・営業時間・点数・犬の条件）
     ・🗺    → Googleマップのその場所のページ（ナビはユーザーがそこで開始する）
     URLは placeMapsUrl() を使い回す（カードの「📍 Googleマップ」やマップのピンと同じもの）。 */
  const p = it.ref ? getPlaceById(it.ref) : null;
  const place = p
    ? `<span class="tl-links">
        <a class="tl-place" href="#" data-goto-ref="${esc(it.ref)}"
           title="${esc(p.name)}のカードを見る">${TYPE_ICONS[p.type] || "📍"} ${esc(p.name)}</a>
        <a class="tl-maps" href="${placeMapsUrl(p)}" target="_blank" rel="noopener"
           title="Googleマップで開く" aria-label="${esc(p.name)}をGoogleマップで開く">🗺</a>
      </span>`
    : "";
  /* その行に紐づくチケット（日と地点が両方一致したときだけ）。
     ★.tl-links の中に入れないこと。tools/test_days.js が .tl-place と .tl-maps の数を
       地点チップの数と突き合わせており、同じ器に別のリンクを足すと検査が壊れる（追補L-5）。 */
  const tickets = ticketsForRow(it).map(t =>
    `<a class="tl-ticket" href="#" data-goto-ticket="${esc(t.id)}"
        title="${esc(t.title)}を見る">🎫</a>`).join("");
  return `<li>
      <span class="tl-time">${when}</span>
      <span class="tl-body">${esc(it.text || "")}<span class="st-chip ${st}">${st === "confirmed" ? "確定" : "未確定"}</span>${tickets}${place}</span>
    </li>`;
}

/* 行の集まりを日ごとのカードで描く。opts.editable=true なら日ごとに「編集」ボタンを出す。 */
function scheduleCardsHtml(rows, opts = {}) {
  const groups = rowsByDay(rows);
  if (!groups.length) return `<p class="muted">予定がありません。</p>`;
  const today = todayKey();
  return groups.map(g => {
    const edit = opts.editable
      ? `<button class="plan-edit" ${sharedEditAttrs()} data-edit-day="${esc(g.day)}">編集</button>` : "";
    /* ★「今日」は本命プランにだけ出す。予備プラン（過去の控え）に出すと
         どれが今日の予定なのか分からなくなる。旅行期間外は today がどの日にも
         一致しないので、何も起きない＝次の旅行にそのまま引き継げる。 */
    const isToday = opts.editable && g.day === today;
    return `<div class="plan-card featured${isToday ? " is-today" : ""}" data-day="${esc(g.day)}">
      <div class="plan-head"><h3>${esc(dayLabel(g.day))}</h3>
        ${isToday ? `<span class="tag today">今日</span>` : ""}
        <span class="tag top">${g.rows.length}件</span>${edit}</div>
      ${daySub(g.day) ? `<p class="plan-route">${esc(daySub(g.day))}</p>` : ""}
      <ol class="timeline">${g.rows.map(scheduleRowReadHtml).join("")}</ol>
    </div>`;
  }).join("");
}

/* ---- 本命プラン（= schedule そのもの） ---- */
function renderMasterPlan() {
  const box = $("#master-plan"); if (!box) return;
  /* ★編集モード中は出さない。理由は2つある。
     ・編集セクションの入力ハンドラは saveSchedule() しか呼ばない（カーソルとIME変換を
       飛ばさないため、入力のたびに再描画しない）。出したままだと本命の表示だけが取り残され、
       他端末は applyRemote で更新されるのに「編集している本人だけが古い表示を見る」ことになる
     ・隠せば、編集の操作を足すたびに renderMasterPlan() を呼ぶことを覚えておかずに済む（0-3）
     見る人ごとの表示状態なので、同行者の画面は隠れない（追補H-9）。
     隠すことで「編集を終える」がタブの先頭に来るので、編集モードの出口も分かりやすくなる。 */
  if (schedEditing) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <div class="plan-section-head">
      <h3 class="sched-subhead">本命プラン</h3>
      <span class="muted">全員で共有している旅程です。変更は同行者にもすぐ反映されます</span>
    </div>
    <div class="plan-list">${scheduleCardsHtml(schedule, { editable: true })}</div>
    <div class="plan-list-tools">
      <button class="btn-ghost" id="plan-edit-all" ${sharedEditAttrs()}>全体を編集</button>
      <button class="btn-ghost" id="plan-backup" ${sharedEditAttrs()}>予備プランへ書き出す</button>
    </div>`;
  $$("#master-plan .plan-edit").forEach(b =>
    b.addEventListener("click", () => openSchedEditor(b.dataset.editDay)));
  $("#plan-edit-all").addEventListener("click", () => openSchedEditor("all"));
  $("#plan-backup").addEventListener("click", exportScheduleAsBackup);
  // 地点チップ（.tl-place）のクリックは init() の委任で拾う。本命プランと予備プランの
  // 両方が同じ行の描画関数を使うので、描くたびに配線しない

  /* 旅行中は今日のカードまで自動で送る。★初回だけ（上の todayScrolled の理由）。
     scrollIntoView は jsdom に無いのでガードする。 */
  if (!todayScrolled && DAY_KEYS.includes(todayKey())) {
    todayScrolled = true;
    const el = $("#master-plan .plan-card.is-today");
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "start" });
  }
}

/* 予定行の ref から、その地点のカードタブへ移動して光らせる */
function gotoRefCard(ref) {
  const type = String(ref).split(":")[0];
  const tabOf = { spot: "spots", restaurant: "restaurants", cafe: "cafes" }[type];
  if (!tabOf) return;
  const tab = $$("#tabs .tab").find(t => t.dataset.tab === tabOf);
  if (tab) tab.click();
  setTimeout(() => gotoPlaceCard(tabOf, ref), 60);
}

/* ===== チケット・予約 =====
   ★紐づけは DATA.tickets の refs（地点）と days（日）だけが持つ。
     地点カードとスケジュール行はそれを引くだけなので、
     チケットを1件足せば関係する場所すべてに自動で出る（同じ事実を2か所に持たない。0-1）。 */
function allTickets() { return DATA.tickets || []; }
function getTicketById(id) { return allTickets().find(t => t.id === id) || null; }
/* その地点に紐づくチケット */
function ticketsFor(pid) { return allTickets().filter(t => (t.refs || []).includes(pid)); }
/* その予定行に紐づくチケット。★日と地点の両方が一致した行にだけ出す。
   refs だけで判定すると、同じ駅を指す行すべてに往路券と復路券が並んでしまう。 */
function ticketsForRow(it) {
  if (!it || !it.ref) return [];
  return allTickets().filter(t =>
    (t.refs || []).includes(it.ref) && (t.days || []).includes(normalizeDay(it.day)));
}
function gotoTicket(id) {
  const tab = $$("#tabs .tab").find(t => t.dataset.tab === "tickets");
  if (tab) tab.click();
  setTimeout(() => {
    const el = $$("#tickets-content .ticket-card").find(c => c.dataset.ticket === id);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "start", behavior: "smooth" });
    if (el) { el.classList.add("just-jumped"); setTimeout(() => el.classList.remove("just-jumped"), 1200); }
  }, 60);
}

/* ---- 予備プラン（本命から書き出した控え。ユーザー間で同期する） ---- */
function renderBackupPlans() {
  const box = $("#backup-plans"); if (!box) return;
  const rank = k => { const i = planView.order.indexOf(k); return i < 0 ? Infinity : i; };
  const list = plans.slice().map((p, i) => ({ p, i }))
    .sort((a, b) => (rank("u:" + a.p.id) - rank("u:" + b.p.id)) || (a.i - b.i)).map(x => x.p);
  const cards = list.map(p => `
    <details class="backup-plan" data-id="${p.id}">
      <summary><span class="bp-title">${esc(p.title)}</span>
        <span class="tag alt">${(p.items || []).length}件</span></summary>
      <div class="plan-actions">
        <button class="bp-restore" ${sharedEditAttrs()} data-id="${p.id}">本命へ上書き</button>
        <button class="bp-copy" data-id="${p.id}">コピー</button>
        <button class="bp-del" ${sharedEditAttrs()} data-id="${p.id}" aria-label="この予備プランを削除">削除</button>
      </div>
      <div class="plan-list">${scheduleCardsHtml(p.items || [])}</div>
    </details>`).join("");
  box.innerHTML = `
    <div class="plan-section-head">
      <h3 class="sched-subhead">予備プラン</h3>
      <span class="muted">本命プランの控え。同行者にも共有されます</span>
    </div>
    ${cards || '<p class="muted">まだありません。本命プランの「予備プランへ書き出す」で控えを残せます。</p>'}`;
  $$("#backup-plans .bp-restore").forEach(b => b.addEventListener("click", () => restoreBackupPlan(+b.dataset.id)));
  $$("#backup-plans .bp-copy").forEach(b => b.addEventListener("click", () => copyBackupPlan(+b.dataset.id, b)));
  $$("#backup-plans .bp-del").forEach(b => b.addEventListener("click", () => deleteBackupPlan(+b.dataset.id)));
}

/* 現在の本命プランを予備プランへ複製する。
   ★日で絞るのは「編集セクションを開いてその日を見ているとき」だけ。
     schedDayView は編集を閉じても最後の日が残るので、これを条件にすると
     全体を控えたつもりが1日ぶんだけ書き出される（静かに間違う）。 */
function exportScheduleAsBackup() {
  if (!requireSharedEditing()) return;
  const scope = (schedEditing && schedEditing !== "all") ? schedEditing : null;
  const src = scope ? schedule.filter(it => normalizeDay(it.day) === scope) : schedule;
  if (!src.length) { window.alert("本命プランが空です。先に予定を入れてください。"); return; }
  const def = scope ? `${dayLabel(scope)} の控え` : `本命の控え ${plans.length + 1}`;
  const title = (window.prompt("予備プランの名前を入力してください:", def) || "").trim();
  if (!title) return;
  const id = plans.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;
  // ★行をそのまま複製する（ref・day・end を落とさない。落とすと上書き時に連動が壊れる）
  plans.push({ id, title, items: JSON.parse(JSON.stringify(src)) });
  savePlans();
  renderBackupPlans();
  window.alert(`「${title}」を予備プランに残しました。`);
}

/* 予備プランで本命プランを置き換える（★破壊的。同行者の画面にも即反映される） */
function restoreBackupPlan(id) {
  if (!requireSharedEditing()) return;
  const p = plans.find(x => x.id === id); if (!p) return;
  if (!window.confirm(
      `「${p.title}」で本命プランを置き換えます。\n\n`
    + `現在の本命プラン（${schedule.length}件）は失われます。\n`
    + `同行者の画面にもすぐ反映されます。よろしいですか？`)) return;
  schedule = JSON.parse(JSON.stringify(p.items || []));
  saveSchedule();
  syncRouteFromSchedule();
  rerenderAll();
  window.alert(`本命プランを「${p.title}」に置き換えました。`);
}

function deleteBackupPlan(id) {
  if (!requireSharedEditing()) return;
  const p = plans.find(x => x.id === id); if (!p) return;
  if (!window.confirm(`予備プラン「${p.title}」を削除しますか？（同行者の画面からも消えます）`)) return;
  plans = plans.filter(x => x.id !== id);
  planView.order = planView.order.filter(k => k !== "u:" + id);
  savePlanView();
  savePlans();
  renderBackupPlans();
}

/* 予備プランをテキストでコピー（LINE等に貼れる形式） */
function copyBackupPlan(id, btn) {
  const p = plans.find(x => x.id === id); if (!p) return;
  const text = `【${p.title}】\n` + rowsByDay(p.items || []).map(g =>
    `■ ${dayLabel(g.day)}\n` + g.rows.map(it => {
      const st = it.ref ? getStatus(it.ref) : (it.status === "confirmed" ? "confirmed" : "tentative");
      return `${it.time || "—"}${it.end ? "〜" + it.end : ""}  ${it.text || ""}（${st === "confirmed" ? "確定" : "未確定"}）`;
    }).join("\n")).join("\n\n");
  const done = () => { if (btn) { const o = btn.textContent; btn.textContent = "コピー済"; setTimeout(() => { btn.textContent = o; }, 1200); } };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => window.prompt("コピーしてください:", text));
  else window.prompt("コピーしてください:", text);
}

/* 当日の調整方針（DATA.branches） */
function renderSchedule() {
  renderMasterPlan();
  renderSchedEditorSection();
  renderBackupPlans();
  const box = $("#schedule-content"); if (!box) return;
  box.innerHTML = `<div class="branch-grid">${DATA.branches.map(b =>
    `<div class="branch ${esc(b.cls)}"><h4>${esc(b.title)}</h4><p>${mdBold(b.text)}</p></div>`).join("")}</div>`;
}

/* ---- 予備プラン（共有）と表示状態（この端末に保存） ---- */
const PLANS_KEY = "ise-trip-plans";
const PLANS_VERSION = 1;   // 保存形式のバージョン（初期値の変更でリセットしない）
const PLANVIEW_KEY = "ise-trip-planview";
/* この旅行に最初から用意しておく予備プラン（主目的の施設を変える2案＋2日目の調整版）。
   ★「本命の控え」ではなく「当日どちらを採るか決めるための実行可能な別案」なので、
     コードから配る。DATA.plans のような別形式では持たない——行の形が本命と同じでないと
     ref・day・end が落ち、「本命へ上書き」でマップ連動と確定同期が壊れる（チェックリストF）。
   ★「本命へ上書き」はスケジュール全体を置き換えるので、各プランは**両日ぶん**を持つ。
     1日目だけの差し替えのつもりで書くと、2日目が消える。
   ★地点名ではなく ref（"種別:名前"）を直接持つ。実在しない ref は
     tools/test_days.js の「予備プランの ref がすべて実在する」で落ちる。 */
const PLANS_DEFAULT = [];   // 中身は start() が暗号化された本体から入れる

function loadPlans() {
  // コードの初期値を更新しても、保存済みの予備プランを維持する。
  try { const s = JSON.parse(localStorage.getItem(PLANS_KEY)); if (s && Array.isArray(s.items)) return s.items; } catch (e) {}
  // ★初回はコードの既定を配る（[] にすると当日の切替先が無くなる）
  return JSON.parse(JSON.stringify(PLANS_DEFAULT));
}
function savePlans() { localStorage.setItem(PLANS_KEY, JSON.stringify({ v: PLANS_VERSION, items: plans })); fbPush("plans", plans); }
/* 予備プランの並び順だけ端末に持つ（見る人ごとの表示状態。同期しない。追補H-9） */
function loadPlanView() {
  try { const s = JSON.parse(localStorage.getItem(PLANVIEW_KEY)); if (s && typeof s === "object") return { order: Array.isArray(s.order) ? s.order : [] }; } catch (e) {}
  return { order: [] };
}
function savePlanView() { localStorage.setItem(PLANVIEW_KEY, JSON.stringify(planView)); }
let plans = [];            // start() で読み込む
let planView = loadPlanView();

/* ---- 編集できるスケジュール（ドラッグ並び替え・時刻入力・確定切替・localStorage保存） ----
   ★共有の初期表示（A仕様）: 下の SCHED_DEFAULT が「全員に配られる初期スケジュール」。
     並びを確定したら「共有用に書き出す」ボタンの出力を SCHED_DEFAULT に貼り替え、
     必ず SCHED_VERSION を +1 して commit すること。
     → 各端末は保存済みバージョンが古いと自動で新しい初期表示に更新される。

   ★4泊5日対応（この旅行で追加）: 各行が day（YYYY-MM-DD）を持つ。
     schedule は全日ぶんを1本の配列で保持し、
       ・「全体」サブタブ … 日付見出し行を挟んで全件を表示
       ・日別サブタブ    … その日の行だけを表示
     と描き分ける。データが1本なので、どちらで編集しても即座に他方へ反映される。
     全体タブで行を別の日の見出しの下へドラッグすると、その行の day が入れ替わる。 */
const SCHED_KEY = "ise-trip-schedule";
const SCHED_VERSION = 2;   // 保存形式のバージョン（初期値の変更でリセットしない）

/* この旅行の日付。key は day の値、label はサブタブと見出しの表記。
   ★日帰りでも配列は残す。TRIP_DAYS.length === 1 のときは <body> に day-single が付き、
     日サブタブとマップの「日」フィルタが CSS で隠れる（DOM と配線はそのまま残るので、
     次に複数日の旅行が来たらここに行を足すだけで復活する。追補K・T）。 */
const TRIP_DAYS = [];   // 中身は start() が暗号化された本体から入れる
const DAY_KEYS = [];   // TRIP_DAYS と同じく start() が入れる（配列は作り直さない）
let FIRST_DAY = "";
function tripDateRange() {
  const fmt = iso => iso.slice(5).split("-").map(Number).join("/");
  const first = TRIP_DAYS[0].key, last = TRIP_DAYS[TRIP_DAYS.length - 1].key;
  return first === last ? fmt(first) : `${fmt(first)}〜${fmt(last)}`;
}
function dayLabel(key) { const d = TRIP_DAYS.find(x => x.key === key); return d ? d.label : key; }
function daySub(key) { const d = TRIP_DAYS.find(x => x.key === key); return d ? d.sub : ""; }
/* 不正・未設定の day は初日に寄せる（古い保存データや手編集への保険） */
function normalizeDay(d) { return DAY_KEYS.includes(d) ? d : FIRST_DAY; }

/* 端末のローカル日付を "YYYY-MM-DD" で返す（TRIP_DAYS の key と同じ形）。
   ★toISOString() を使わないこと。UTCに変換されるため、日本時間の 0:00〜8:59 は
     前日の日付になり、朝いちばんに開くと「今日」が昨日の予定を指す。 */
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/* 今日のカードへ自動スクロールしたか。★保存しない（見る人ごとの状態）。
   rerenderAll() は同期を受け取るたびに走るので、初回だけにしないと
   同行者が編集するたびに読んでいる場所が飛ぶ。 */
let todayScrolled = false;

// ref: 地点カードの placeId（"種別:名前"）。付けるとカード/マップと確定状態・並び順が連動する。
// ★既定は資料の仮タイムスケジュール。主目的を別施設にするときは
//   スケジュールタブ下部の予備プランの「本命へ上書き」を押す（追補M）。
// ★1日目の出発駅には ref を付け、2日目の復路（同じ駅に着く）には付けない。
//   同じ地点を同じ日に2回 ref すると経由地が増えるだけで、ナビの順序は変わらないため。
// ★Googleマップの経由地は9件が上限。ref を付けるのは「車で実際に立ち寄る地点」だけにする
//   （徒歩で寄るだけの地点には付けない）。
const SCHED_DEFAULT = [];   // 中身は start() が暗号化された本体から入れる
let schedule = [];         // start() で読み込む
function loadSchedule() {
  try {
    const raw = JSON.parse(localStorage.getItem(SCHED_KEY));
    // 初期値やバージョンが変わっても、保存済みの編集を優先する。
    if (raw && Array.isArray(raw.items)) {
      return raw.items.map(x => ({ ...x, day: normalizeDay(x.day) }));
    }
  } catch (e) {}
  return SCHED_DEFAULT.map(x => ({ ...x }));
}
function saveSchedule() { localStorage.setItem(SCHED_KEY, JSON.stringify({ v: SCHED_VERSION, items: schedule })); fbPush("schedule", schedule); }

/* 表示中のサブタブ。"all" = 全体、それ以外は TRIP_DAYS の key。
   ★端末ごとの一時的な表示状態なので localStorage にも Firebase にも保存しない
     （同行者の画面まで勝手に切り替わると事故になる。絞り込みと同じ方針） */
let schedDayView = "all";

/* 編集モード。null = 編集していない（＝編集セクションを描かない）。
   ★「隠す」ではなく「描かない」。display:none にしても SortableJS は生きたままで、
     スマホのスクロール中の誤タップで予定が入れ替わる事故が実際に起きていた。
     端末ごとの状態なので保存しない（追補H-9）。 */
let schedEditing = null;

/* 編集モードで地図を開いているか。★既定は閉じている。
   スマホでは編集画面がごちゃつくと予定そのものが読めなくなるので、
   地図は「見たい人が開くもの」にしてある。開いた地図は借り物で、
   置き場所は syncMapDock() が決める（この変数は「開きたいか」だけを持つ）。
   ★schedDayView と同じく端末ローカル。保存も同期もしない（追補H-9）。 */
let schedMapOpen = false;

// 列幅だけを旅行・ブラウザごとに保存する。旅程の保存・Firebase同期とは独立。
const SCHED_LAYOUT_KEY = "ise-trip-editor-layout";
const SCHED_LAYOUTS = {
  three: { panes: ["map", "schedule", "candidates"], min: [280, 260, 180], ratio: [1.35, 1.15, .75] },
  mapSchedule: { panes: ["map", "schedule"], min: [280, 260], ratio: [1, 1] },
  scheduleCandidates: { panes: ["schedule", "candidates"], min: [260, 180], ratio: [1.5, 1] }
};
const SCHED_SPLITTER_WIDTH = 16;
let schedLayoutPrefs = loadSchedLayout();
let schedCandidatesOpen = false, schedMapLarge = false;
let schedLayoutController = null;

function loadSchedLayout() {
  const result = {};
  try {
    const raw = JSON.parse(localStorage.getItem(SCHED_LAYOUT_KEY));
    if (raw?.v !== 1) return result;
    for (const [mode, spec] of Object.entries(SCHED_LAYOUTS)) {
      const values = raw.ratios?.[mode];
      if (Array.isArray(values) && values.length === spec.min.length &&
          values.every(x => Number.isFinite(x) && x > 0) && Number.isFinite(values.reduce((a, b) => a + b, 0))) {
        const sum = values.reduce((a, b) => a + b, 0);
        result[mode] = values.map(x => x / sum);
      }
    }
  } catch (e) { /* 保存領域が使えなくても、その場での調整はできる */ }
  return result;
}
function saveSchedLayout() {
  try { localStorage.setItem(SCHED_LAYOUT_KEY, JSON.stringify({ v: 1, ratios: schedLayoutPrefs })); } catch (e) {}
}
// 最小幅に達した列を固定し、残った幅を残りの比率で配る。保存値は変更しない。
function fitSchedWidths(total, ratio, min) {
  const widths = min.map(() => 0), pending = new Set(min.map((_, i) => i));
  let remaining = total;
  while (pending.size) {
    const sum = [...pending].reduce((s, i) => s + ratio[i], 0);
    const fixed = [...pending].filter(i => remaining * ratio[i] / sum < min[i]);
    if (!fixed.length) {
      pending.forEach(i => { widths[i] = remaining * ratio[i] / sum; });
      break;
    }
    fixed.forEach(i => { widths[i] = min[i]; remaining -= min[i]; pending.delete(i); });
  }
  return widths;
}
function moveSchedBoundary(widths, min, index, delta) {
  const next = widths.slice(), pair = widths[index] + widths[index + 1];
  next[index] = Math.max(min[index], Math.min(pair - min[index + 1], widths[index] + delta));
  next[index + 1] = pair - next[index];
  return next;
}
function schedViewportMode() {
  if (window.innerWidth < 760) return "phone";
  return schedMapOpen ? (window.innerWidth >= 1180 ? "three" : "mapSchedule") : "scheduleCandidates";
}
function applySchedWidths(c, widths) {
  c.widths = widths;
  c.grid.style.gridTemplateColumns = widths.map(x => `${x}px`).join(` ${SCHED_SPLITTER_WIDTH}px `);
  const spec = SCHED_LAYOUTS[c.mode];
  $$(".sched-splitter", c.grid).forEach(handle => {
    const index = spec.panes.indexOf(handle.dataset.pane);
    const visible = index >= 0 && index < widths.length - 1;
    handle.hidden = !visible;
    if (!visible) return;
    const pair = widths[index] + widths[index + 1];
    handle.setAttribute("aria-valuemin", Math.round(spec.min[index]));
    handle.setAttribute("aria-valuemax", Math.floor(pair - spec.min[index + 1]));
    handle.setAttribute("aria-valuenow", Math.round(widths[index]));
    handle.setAttribute("aria-valuetext", `${Math.round(widths[index])}ピクセル`);
  });
}
function refreshSchedLayout() {
  const c = schedLayoutController; if (!c) return;
  let mode = schedViewportMode();
  const available = c.grid.getBoundingClientRect().width;
  // 拡大表示等で実際の編集領域が足りない場合も横スクロールを作らない。
  const fits = key => available >= SCHED_LAYOUTS[key].min.reduce((a, b) => a + b, 0) +
    SCHED_SPLITTER_WIDTH * (SCHED_LAYOUTS[key].min.length - 1);
  if (available > 0) {
    if (mode === "three" && !fits(mode)) mode = "mapSchedule";
    if (mode !== "phone" && !fits(mode)) mode = "phone";
  }
  if (c.mode !== mode || c.available !== available) endSchedResize(false);
  c.mode = mode; c.available = available;
  c.root.dataset.layout = mode;
  const phone = mode === "phone";
  $("#sched-layout-reset").hidden = phone;
  $("#sched-layout-help").hidden = phone;
  $("#sched-candidates-toggle").hidden = !phone;
  $("#sched-candidates-body").hidden = phone && !schedCandidatesOpen;
  $("#sched-candidates-toggle").setAttribute("aria-expanded", String(schedCandidatesOpen));
  $("#sched-candidates-toggle").textContent = schedCandidatesOpen ? "候補を閉じる" : "候補を開く";
  $("#sched-map-size").hidden = !phone || !schedMapOpen;
  $("#sched-map-size").textContent = schedMapLarge ? "標準サイズ" : "地図を大きく";
  $("#sched-map-size").setAttribute("aria-pressed", String(schedMapLarge));
  c.root.classList.toggle("map-large", schedMapLarge);
  if (phone) {
    c.grid.style.removeProperty("grid-template-columns");
    $$(".sched-splitter", c.grid).forEach(el => { el.hidden = true; });
    c.widths = [];
  } else if (available > 0) {
    const spec = SCHED_LAYOUTS[mode];
    const total = available - SCHED_SPLITTER_WIDTH * (spec.min.length - 1);
    if (!c.drag) applySchedWidths(c, fitSchedWidths(total, schedLayoutPrefs[mode] || spec.ratio, spec.min));
  }
}
function commitSchedWidths(c) {
  const sum = c.widths.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return;
  schedLayoutPrefs[c.mode] = c.widths.map(x => x / sum);
  saveSchedLayout();
}
function endSchedResize(commit = false) {
  const c = schedLayoutController, drag = c?.drag; if (!drag) return;
  c.drag = null;
  window.removeEventListener("pointermove", drag.move);
  window.removeEventListener("pointerup", drag.up);
  window.removeEventListener("pointercancel", drag.cancel);
  window.removeEventListener("blur", drag.cancel);
  window.removeEventListener("keydown", drag.key);
  drag.handle.removeEventListener("lostpointercapture", drag.cancel);
  if (drag.handle.hasPointerCapture?.(drag.id)) drag.handle.releasePointerCapture(drag.id);
  document.body.classList.remove("sched-resizing");
  if (commit) commitSchedWidths(c);
  else applySchedWidths(c, drag.widths);
}
function startSchedResize(event) {
  const c = schedLayoutController;
  if (!c || c.mode === "phone" || event.button !== 0 || event.isPrimary === false || !canEditShared()) return;
  const handle = event.currentTarget, spec = SCHED_LAYOUTS[c.mode];
  const index = spec.panes.indexOf(handle.dataset.pane);
  if (index < 0 || index >= c.widths.length - 1) return;
  endSchedResize(false);
  endPinDrag();
  cancelMapPinch();
  event.preventDefault(); event.stopPropagation();
  const drag = { handle, id: event.pointerId, x: event.clientX, widths: c.widths.slice() };
  drag.move = e => {
    if (e.pointerId !== drag.id) return;
    e.preventDefault();
    applySchedWidths(c, moveSchedBoundary(drag.widths, spec.min, index, e.clientX - drag.x));
  };
  drag.up = e => { if (e.pointerId === drag.id) { drag.move(e); endSchedResize(true); } };
  drag.cancel = e => { if (e.pointerId === undefined || e.pointerId === drag.id) endSchedResize(false); };
  drag.key = e => { if (e.key === "Escape") { e.preventDefault(); endSchedResize(false); } };
  c.drag = drag;
  document.body.classList.add("sched-resizing");
  window.addEventListener("pointermove", drag.move, { passive: false });
  window.addEventListener("pointerup", drag.up);
  window.addEventListener("pointercancel", drag.cancel);
  window.addEventListener("blur", drag.cancel);
  window.addEventListener("keydown", drag.key);
  handle.addEventListener("lostpointercapture", drag.cancel);
  handle.setPointerCapture?.(drag.id);
}
function resizeSchedByKey(event) {
  const c = schedLayoutController;
  if (!c || c.mode === "phone" || !canEditShared()) return;
  const delta = { ArrowLeft: -16, ArrowRight: 16, Home: -Infinity, End: Infinity }[event.key];
  if (delta === undefined) return;
  event.preventDefault(); event.stopPropagation();
  endSchedResize(false);
  const spec = SCHED_LAYOUTS[c.mode], index = spec.panes.indexOf(event.currentTarget.dataset.pane);
  if (index < 0 || index >= c.widths.length - 1) return;
  applySchedWidths(c, moveSchedBoundary(c.widths, spec.min, index, delta));
  commitSchedWidths(c);
}
function disposeSchedLayout() {
  const c = schedLayoutController; if (!c) return;
  endSchedResize(false);
  c.observer?.disconnect();
  window.removeEventListener("resize", c.resize);
  cancelAnimationFrame(c.raf);
  schedLayoutController = null;
}
function setupSchedLayout() {
  const root = $(".sched-editor"), grid = $(".sched-cols"); if (!root || !grid) return;
  const c = { root, grid, mode: "phone", widths: [], raf: 0, drag: null, mapWidth: 0, mapHeight: 0 };
  schedLayoutController = c;
  c.resize = () => {
    if (c.raf) return;
    c.raf = requestAnimationFrame(() => {
      c.raf = 0;
      refreshSchedLayout();
      queueMapResize();
    });
  };
  if (typeof ResizeObserver === "function") {
    c.observer = new ResizeObserver(c.resize);
    c.observer.observe(grid);
  }
  window.addEventListener("resize", c.resize);
  $$(".sched-splitter", grid).forEach(handle => {
    handle.addEventListener("pointerdown", startSchedResize);
    handle.addEventListener("keydown", resizeSchedByKey);
  });
  $("#sched-layout-reset").addEventListener("click", () => {
    endSchedResize(false);
    delete schedLayoutPrefs[c.mode]; saveSchedLayout(); refreshSchedLayout();
  });
  $("#sched-candidates-toggle").addEventListener("click", () => {
    schedCandidatesOpen = !schedCandidatesOpen; refreshSchedLayout();
  });
  $("#sched-map-size").addEventListener("click", () => {
    schedMapLarge = !schedMapLarge; refreshSchedLayout(); c.resize();
  });
  refreshSchedLayout(); c.resize();
}

// 候補名から予定行を作る。地点カードに一致すれば ref を付け、確定状態を引き継ぐ。
// day は「いま見ているサブタブの日」。全体タブから足したときは初日に入る。
function schedItemFromName(name, day) {
  const ref = placeIdByName(name) || undefined;
  return { day: normalizeDay(day || (schedDayView === "all" ? FIRST_DAY : schedDayView)),
           time: "", text: name, status: ref ? getStatus(ref) : "tentative", ref };
}
// スケジュールの地点項目（ref）の並び順を、マップのルートに反映する（片方向連動）
// ★全日ぶんをまとめて1本のルートにする。日ごとの絞り込みはマップの「日」フィルタで行う。
/* スケジュールの並び順から作るルート（副作用なし）。★routeIds の唯一の作り手。 */
function routeFromSchedule() {
  const seen = new Set(), out = [];
  schedule.forEach(it => {
    if (it.ref && getPlaceById(it.ref) && !seen.has(it.ref)) { seen.add(it.ref); out.push(it.ref); }
  });
  return out;
}
/* スケジュールを編集したあとに呼ぶ。保存はしない（導出値なので） */
function syncRouteFromSchedule() {
  routeIds = routeFromSchedule();
  if ($("#route-list")) renderRouteEditor();
  if (typeof map !== "undefined" && map) { refreshMarkers(); drawRouteLine(); applyFilters(); }
}
/* 地点id → その地点が入っている日の集合（マップの「日」フィルタ用） */
function daysOfPlace(id) {
  const s = new Set();
  schedule.forEach(it => { if (it.ref === id) s.add(normalizeDay(it.day)); });
  return s;
}

/* 現在の並びを SCHED_DEFAULT 用のコード片として書き出す（A仕様の更新を簡単に） */
function exportSchedule() {
  // ① スケジュール（day/ref付き。status は連動項目なら共通ステートの現状を出力）
  const lines = schedule.map(it => {
    const st = it.ref ? getStatus(it.ref) : (it.status || "tentative");
    const parts = [`day: ${JSON.stringify(normalizeDay(it.day))}`, `time: ${JSON.stringify(it.time || "")}`,
                   `text: ${JSON.stringify(it.text || "")}`, `status: ${JSON.stringify(st)}`];
    if (it.end !== undefined && it.end !== null) parts.push(`end: ${JSON.stringify(it.end)}`);
    if (it.ref) parts.push(`ref: ${JSON.stringify(it.ref)}`);
    return `  { ${parts.join(", ")} }`;
  }).join(",\n");
  const schedOut = `const SCHED_DEFAULT = [\n${lines}\n];`;
  // ② 確定/未確定の状態（カード・マップ・スケジュールで変更した分を全員へ）
  const statusLines = Object.keys(statusMap).sort().map(id =>
    `  ${JSON.stringify(id)}: ${JSON.stringify(getStatus(id))}`
  ).join(",\n");
  const statusOut = `const STATUS_DEFAULT = {\n${statusLines}\n};`;
  const out =
    `/* ① app.js の SCHED_DEFAULT に貼り替え、SCHED_VERSION を +1 */\n${schedOut}\n\n` +
    `/* ② app.js の STATUS_DEFAULT に貼り替え、STATUS_VERSION を +1 */\n${statusOut}`;
  if (navigator.clipboard) navigator.clipboard.writeText(out).catch(() => {});
  window.prompt("下記を app.js に貼り替え、SCHED_VERSION と STATUS_VERSION をそれぞれ +1 して commit すると、並び順・確定状態が全員に反映されます（クリップボードにもコピー済み）:", out);
}

/* 1行ぶんのHTML。i は schedule 配列の実インデックス（日別表示でも実インデックスを渡す） */
function schedRowHtml(it, i) {
  // 効果的な確定状態: refがあれば共通ステート、なければ項目ローカルの status
  const st = it.ref ? getStatus(it.ref) : (it.status === "confirmed" ? "confirmed" : "tentative");
  const linked = it.ref ? ` <span class="sched-linked" title="地点カード・マップと連動">📍</span>` : "";
  // 終了時間はオプション。未設定なら「＋終了」ボタン、設定済みなら「〜 終了時刻 ×」
  const endUi = (it.end === undefined || it.end === null)
    ? `<button class="sched-addend" data-i="${i}" title="終了時間を追加">＋終了</button>`
    : `<span class="sched-tilde">〜</span><input class="sched-endtime" type="time" value="${esc(it.end)}" data-i="${i}" aria-label="終了時刻"><button class="sched-rmend" data-i="${i}" title="終了時間を消す">×</button>`;
  // ★時刻と終了UIは .sched-when でひとまとめにする。
  //   「＋終了」1個の行と「〜 終了時刻 ×」3個の行で幅が変わると、
  //   そのぶん右の「予定」の左端が行ごとにズレて縦に読みにくくなるため。
  return `
      <li class="sched-item ${st}" data-i="${i}" data-day="${esc(normalizeDay(it.day))}">
        <span class="sched-handle" aria-label="ドラッグして並び替え" title="ドラッグで並び替え">≡</span>
        <span class="sched-when">
          <input class="sched-time" type="time" value="${esc(it.time || "")}" data-i="${i}" aria-label="開始時刻">${endUi}
        </span>
        <span class="sched-ctrl">${linked}
          <button class="sched-status st-chip ${st}" data-i="${i}" title="確定／未確定を切替${it.ref ? "（カード・マップと連動）" : ""}">${STATUS_LABEL[st]}</button>
          <button class="sched-rm" data-i="${i}" aria-label="この行を削除">✕</button>
        </span>
        <input class="sched-text" type="text" value="${esc(it.text || "")}" data-i="${i}" placeholder="予定を入力" aria-label="予定">
        <select class="sched-ref" data-i="${i}" aria-label="紐づける地点">${placeOptionsHtml("📍 地点なし", it.ref || "")}</select>
      </li>`;
}

/* ===== 編集セクションの組み立て・撤去 =====
   ★編集モードでないときは DOM ごと作らない。隠すだけでは SortableJS が生き残り、
     スマホのスクロール中の誤タップで予定が入れ替わる（実際に頻発していた）。 */
function openSchedEditor(day) {
  if (!requireSharedEditing()) return;
  schedEditing = day || "all";
  schedDayView = schedEditing;
  renderMasterPlan();          // 編集中の日を示すため描き直す
  renderSchedEditorSection();
  const host = $("#sched-editor-host");
  if (host && host.scrollIntoView) host.scrollIntoView({ behavior: "smooth", block: "start" });
}
function closeSchedEditor() {
  schedEditing = null;
  schedDayView = "all";        // 次に開いたとき前回の日が残らないようにする
  renderSchedEditorSection();  // ここで DOM ごと消える＝Sortable も一緒に捨てられる
  renderMasterPlan();
  renderBackupPlans();
}
function renderSchedEditorSection() {
  const host = $("#sched-editor-host"); if (!host) return;
  disposeSchedLayout();
  /* ★innerHTML を書く前に、借りている地図を必ず家へ返す。
     下の2つの分岐はどちらも host.innerHTML を書き換えるので、分岐より前に置くこと。
     ここを飛ばすと Leaflet のコンテナごと捨てられ、地図が二度と戻らない。
     tools/test_days.js「16. 地図の間借り」がこの順序をソースでも固定している。 */
  if (host.contains($("#map-dock"))) undockMap();
  if (!schedEditing) {
    // ★空にすると、Sortable が握っていた要素ごと GC される。フラグも戻す
    host.innerHTML = "";
    schedSortInit = false;
    return;
  }
  host.innerHTML = `
    <div data-shared-edit class="sched-editor is-editing${schedMapOpen ? " with-map" : ""}">
      <div class="sched-edit-head">
        <h3 class="sched-subhead">編集中${schedEditing === "all" ? "（全体）" : `（${esc(dayLabel(schedEditing))}）`}</h3>
        <button class="btn-primary sched-done">編集を終える</button>
      </div>
      <p class="sched-hint muted">変更は<strong>入力した時点でこの端末に保存</strong>され、接続中は同行者にも反映されます（保存ボタンはありません）。「編集を終える」で読みやすい表示に戻ります。</p>
      <div class="sched-legend">
        <span class="st-chip confirmed">確定</span><span>タップで未確定に切り替わります</span>
        <span class="st-chip tentative">未確定</span><span>地点に紐づく行（📍）はカード・マップとも連動します</span>
      </div>
      <div class="sched-day-tabs" id="sched-day-tabs" aria-label="日の切替"></div>
      <!-- ★地図は既定でたたんである。開いたときだけ #map-dock が #sched-map-slot へ引っ越す。
           スロットは .sched-cols の直下＝タイムスケジュールと横に並ぶ位置に置く。
           ・#sched-candidates の中には入れない（renderSchedCandidates() の innerHTML で地図ごと消える）
           ・広い画面で予定一覧の真横に来るので、ドラッグの距離が短く、両方が同時に見える -->
      <div class="sched-map-bar">
        <button class="btn-ghost sched-map-toggle" id="sched-map-toggle" aria-expanded="${schedMapOpen ? "true" : "false"}" aria-controls="sched-map-slot">${schedMapOpen ? "🗺 地図を閉じる" : "🗺 地図で選ぶ"}</button>
        <button class="btn-ghost" id="sched-map-size" aria-controls="map" hidden>地図を大きく</button>
        <span class="muted sched-map-hint">${schedMapOpen ? "ピンをつまんで予定へドラッグ（パソコン）。<strong>行と行の間に落とすと新しい予定が入り、行の真ん中に落とすとその予定にその地点が紐づきます</strong>。スマホではピンをタップして「＋ スケジュールに追加」。" : "地図で位置関係を見ながら予定に足せます"}</span>
      </div>
      <div class="sched-layout-bar">
        <span id="sched-layout-help" class="muted sched-hint">列の境界を左右にドラッグして幅を調整できます（このブラウザに保存）。</span>
        <button class="btn-ghost" id="sched-layout-reset">列幅を標準に戻す</button>
      </div>
      <div class="sched-cols${schedMapOpen ? " with-map" : ""}">
        <div id="sched-map-slot" aria-label="地図"${schedMapOpen ? "" : " hidden"}></div>
        <div class="sched-splitter" data-pane="map" role="separator" tabindex="0" aria-orientation="vertical" aria-label="地図の列幅" aria-controls="sched-map-slot" title="左右にドラッグ、または左右キーで地図の幅を調整" hidden></div>
        <div class="sched-col" id="sched-timeline-col">
          <h4 class="sched-col-h">タイムスケジュール <span class="muted">ドラッグ並び替え・時刻入力・確定切替</span></h4>
          <ol class="sched-list" id="sched-list"></ol>
          <div class="sched-toolbar">
            <select id="sched-add-place" class="sched-select"><option value="">＋ 候補から追加…</option></select>
            <button class="btn-ghost" id="sched-add-row">＋ 空の行</button>
            <button class="btn-ghost" id="sched-reset">おすすめ順に戻す</button>
            <button class="btn-ghost" id="sched-clear">空にする</button>
            <button class="btn-ghost" id="sched-export">開発者向け：初期表示を書き出す</button>
          </div>
          <p class="sched-hint muted">行はドラッグで並べ替えられます。<strong>「おすすめ順に戻す」で本命プランの初期状態に戻せます。</strong>時刻・本文の変更は入力した時点で同行者にも反映されます（保存ボタンはありません）。</p>
        </div>
        <div class="sched-splitter" data-pane="schedule" role="separator" tabindex="0" aria-orientation="vertical" aria-label="タイムスケジュールの列幅" aria-controls="sched-timeline-col" title="左右にドラッグ、または左右キーでタイムスケジュールの幅を調整" hidden></div>
        <div class="sched-col" id="sched-candidates-col">
          <div class="sched-candidates-head">
            <h4 class="sched-col-h">候補リスト <span class="muted" id="sched-candidates-count"></span></h4>
            <button class="btn-ghost" id="sched-candidates-toggle" aria-expanded="false" aria-controls="sched-candidates-body" hidden>候補を開く</button>
          </div>
          <div id="sched-candidates-body">
          <p class="sched-hint muted">⊕で予定に追加できます。パソコンではドラッグも使えます。</p>
          <div class="sched-cand-tabs" id="sched-cand-tabs">
            <button class="sched-cand-tab active" data-filter="all">すべて</button>
            <button class="sched-cand-tab" data-filter="spots">🌿 スポット</button>
            <button class="sched-cand-tab" data-filter="restaurants">🍽 レストラン</button>
            <button class="sched-cand-tab" data-filter="cafes">☕ カフェ</button>
          </div>
          <ul class="sched-cand-list" id="sched-candidates"></ul>
          </div>
        </div>
      </div>
      <div class="sched-edit-foot">
        <button class="btn-primary sched-done">編集を終える</button>
      </div>
    </div>`;
  // 中身を作ってから配線する（毎回作り直すので addEventListener の重複は起きない）
  renderSchedDayTabs();
  renderScheduleEditor();
  renderSchedCandidates();
  setupSchedCandTabs();
  setupSchedMapToggle();
  setupSchedLayout();
  populateSchedAddSelect();
  schedSortInit = false;       // 新しい DOM に対して張り直す
  setupScheduleSortable();
  wireSchedToolbar();
  // 編集セクションは縦に長いので、出口は先頭と末尾の2か所に置く
  $$(".sched-done").forEach(b => b.addEventListener("click", closeSchedEditor));
  /* 行にポインタを乗せると、その地点のピンが目立つ（地図を開いているときの道しるべ）。
     ★行は data-i しか持たない。ref を data 属性に写すと同じ事実が2か所になるので、
       schedule から引く（0-1）。 */
  const list = $("#sched-list");
  if (list) {
    list.addEventListener("pointerover", e => {
      const row = e.target && e.target.closest && e.target.closest(".sched-item");
      const it = row ? schedule[+row.dataset.i] : null;
      focusPin(it && it.ref);
    });
    list.addEventListener("pointerleave", () => focusPin(null));
  }
  // ★最後に地図の置き場所を決め直す。開いていれば、いま作ったスロットへ入れ直す
  syncMapDock();
}

/* 開閉では入力欄や候補リストを作り直さない。地図の置き場所は syncMapDock() が決める。 */
function setupSchedMapToggle() {
  const btn = $("#sched-map-toggle"); if (!btn) return;
  btn.addEventListener("click", () => {
    endSchedResize(false);
    schedMapOpen = !schedMapOpen;
    $(".sched-editor").classList.toggle("with-map", schedMapOpen);
    $(".sched-cols").classList.toggle("with-map", schedMapOpen);
    $("#sched-map-slot").hidden = !schedMapOpen;
    btn.setAttribute("aria-expanded", String(schedMapOpen));
    btn.textContent = schedMapOpen ? "🗺 地図を閉じる" : "🗺 地図で選ぶ";
    $(".sched-map-hint").textContent = schedMapOpen
      ? "パソコンではピンを予定へドラッグ。行の間で新規追加、行の中央で地点を紐づけます。スマホではピンをタップして「＋ スケジュールに追加」。"
      : "地図で位置関係を見ながら予定に足せます";
    refreshSchedLayout();
    syncMapDock();
    schedLayoutController?.resize();
    if (schedMapOpen) {
      const slot = $("#sched-map-slot");
      if (slot && slot.scrollIntoView) slot.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
}

/* 編集セクションのツールバー。★日別タブを開いているときはその日だけに効く（追補K-4） */
function wireSchedToolbar() {
  $("#sched-add-row").addEventListener("click", () => {
    const day = schedDayView === "all" ? FIRST_DAY : schedDayView;
    insertSchedItem({ day, time: "", text: "", status: "tentative" });
  });
  $("#sched-reset").addEventListener("click", () => {
    if (schedDayView === "all") {
      schedule = SCHED_DEFAULT.map(x => ({ ...x }));
    } else {
      const others = schedule.filter(it => normalizeDay(it.day) !== schedDayView);
      const restored = SCHED_DEFAULT.filter(x => x.day === schedDayView).map(x => ({ ...x }));
      // 元の日付順を保つため、日付キーで並べ直す
      schedule = others.concat(restored).sort((a, b) => DAY_KEYS.indexOf(normalizeDay(a.day)) - DAY_KEYS.indexOf(normalizeDay(b.day)));
    }
    saveSchedule(); syncRouteFromSchedule(); renderScheduleEditor(); renderMasterPlan();
  });
  $("#sched-clear").addEventListener("click", () => {
    const what = schedDayView === "all" ? "すべての予定" : `${dayLabel(schedDayView)}の予定`;
    if (!confirm(`${what}を消しますか？（同行者の端末にも反映されます）`)) return;
    schedule = schedDayView === "all" ? [] : schedule.filter(it => normalizeDay(it.day) !== schedDayView);
    saveSchedule(); syncRouteFromSchedule(); renderScheduleEditor(); renderMasterPlan();
  });
  /* ★開発者向け。押すと SCHED_DEFAULT に貼るコードが prompt で出る。
     同行者には意味が分からないので、読むモードには置かず編集セクションの中だけに出す。 */
  $("#sched-export").addEventListener("click", exportSchedule);
}

function renderScheduleEditor() {
  const list = $("#sched-list");
  if (!list) return;
  const viewing = schedDayView;                       // "all" or 日付キー
  // 実インデックスを保ったまま、表示対象だけを抜き出す
  const rows = schedule.map((it, i) => ({ it, i }))
                       .filter(r => viewing === "all" || normalizeDay(r.it.day) === viewing);

  if (!rows.length) {
    const where = viewing === "all" ? "" : `${dayLabel(viewing)}の`;
    list.innerHTML = `<li class="sched-empty">${where}予定がありません。「＋ 空の行」や「候補から追加」で作成できます。</li>`;
  } else if (viewing === "all") {
    // 全体表示: 日付見出し行を挟む。見出しは .sched-item ではないのでドラッグ対象にならない
    let html = "", cur = null;
    rows.forEach(({ it, i }) => {
      const d = normalizeDay(it.day);
      if (d !== cur) {
        cur = d;
        html += `<li class="sched-day-head" data-day="${esc(d)}">
          <span class="sched-day-rule"></span>
          <span class="sched-day-name">${esc(dayLabel(d))}</span>
          <span class="sched-day-sub">${esc(daySub(d))}</span>
          <span class="sched-day-rule"></span>
        </li>`;
      }
      html += schedRowHtml(it, i);
    });
    list.innerHTML = html;
  } else {
    list.innerHTML = rows.map(({ it, i }) => schedRowHtml(it, i)).join("");
  }

  // 入力・操作イベント（textはinputで都度保存、フォーカス維持のため再描画しない）
  $$("#sched-list .sched-time").forEach(el => el.addEventListener("change", e => { schedule[+e.currentTarget.dataset.i].time = e.currentTarget.value; saveSchedule(); }));
  $$("#sched-list .sched-endtime").forEach(el => el.addEventListener("change", e => { schedule[+e.currentTarget.dataset.i].end = e.currentTarget.value; saveSchedule(); }));
  $$("#sched-list .sched-addend").forEach(el => el.addEventListener("click", e => { schedule[+e.currentTarget.dataset.i].end = ""; saveSchedule(); renderScheduleEditor(); }));
  $$("#sched-list .sched-rmend").forEach(el => el.addEventListener("click", e => { delete schedule[+e.currentTarget.dataset.i].end; saveSchedule(); renderScheduleEditor(); }));
  $$("#sched-list .sched-text").forEach(el => el.addEventListener("input", e => { schedule[+e.currentTarget.dataset.i].text = e.currentTarget.value; saveSchedule(); }));
  $$("#sched-list .sched-status").forEach(el => el.addEventListener("click", e => {
    const it = schedule[+e.currentTarget.dataset.i];
    if (it.ref) { toggleStatus(it.ref); }   // 連動: 共通ステート更新 → rerenderStatus が全タブ再描画
    else { it.status = it.status === "confirmed" ? "tentative" : "confirmed"; saveSchedule(); renderScheduleEditor(); }
  }));
  $$("#sched-list .sched-rm").forEach(el => el.addEventListener("click", e => {
    schedule.splice(+e.currentTarget.dataset.i, 1); saveSchedule(); syncRouteFromSchedule(); renderScheduleEditor();
  }));
  // 地点の紐づけ。★ここを変えるとマップのピン順（ルート）と確定状態の出どころが変わる
  $$("#sched-list .sched-ref").forEach(el => el.addEventListener("change", e => {
    setSchedRef(+e.currentTarget.dataset.i, e.currentTarget.value);
  }));
  updateSchedDayCounts();
}

/* 日別サブタブ（全体／8/8…8/12）。件数バッジ付き */
function renderSchedDayTabs() {
  const bar = $("#sched-day-tabs"); if (!bar) return;
  const btn = (key, label, sub) =>
    `<button class="sched-day-tab${schedDayView === key ? " active" : ""}" data-day="${esc(key)}"${sub ? ` title="${esc(sub)}"` : ""}>${esc(label)}<span class="chip-n" data-count="${esc(key)}"></span></button>`;
  bar.innerHTML = btn("all", "全体") + TRIP_DAYS.map(d => btn(d.key, d.label, d.sub)).join("");
  $$(".sched-day-tab", bar).forEach(t => t.addEventListener("click", () => {
    schedDayView = t.dataset.day;
    renderSchedDayTabs();
    renderScheduleEditor();
  }));
  updateSchedDayCounts();
}
function updateSchedDayCounts() {
  $$("#sched-day-tabs .chip-n").forEach(el => {
    const k = el.dataset.count;
    el.textContent = k === "all" ? schedule.length : schedule.filter(it => normalizeDay(it.day) === k).length;
  });
}

/* ===== 地点プルダウンの中身 =====
   ★グループ分けには カードの絞り込みと同じ SPOT_GROUPS / GENRE_GROUPS を使う。
     語彙を2か所に持たない（0-1）ので、区分を直せば絞り込みと選択の両方に効く。
     種類（スポット/レストラン/カフェ）の3つだけで分けるとスポットが25件の一かたまりになり、
     スマホのピッカーで探せない。区分で分けると最大6件になる。 */
function placeOptionGroups() {
  const out = [];
  const push = (label, xs) => { if (xs.length) out.push([label, xs]); };
  SPOT_GROUPS.forEach(([k, label]) =>
    push(label, DATA.spots.filter(p => (p.spotKey || "other") === k).map(p => ({ p, type: "spot" }))));
  const eats = [...DATA.restaurants.map(p => ({ p, type: "restaurant" })),
                ...DATA.cafes.map(p => ({ p, type: "cafe" }))];
  GENRE_GROUPS.forEach(([k, label]) =>
    push(label, eats.filter(x => (x.p.genreKey || "other") === k)));
  // ★区分キーが付いていない地点を必ず拾う。落とすとその地点だけ紐づけられなくなり、
  //   しかもエラーが出ない（このプロジェクトで繰り返し起きた「静かに消える」型）。
  const listed = new Set(out.flatMap(([, xs]) => xs.map(x => placeId(x.type, x.p.name))));
  push("― 区分なし（キーの付け忘れ）―",
       allPlaces().filter(p => !listed.has(placeId(p.type, p.name))).map(p => ({ p, type: p.type })));
  return out;
}
/* <select> の中身（先頭の空項目＋optgroup 群）。値は地点id。
   ★行の紐づけプルダウンと「＋ 候補から追加…」の両方がこれを使う
     （同じ画面で並びが違うと迷うため）。 */
function placeOptionsHtml(blankLabel, selectedRef) {
  const opts = placeOptionGroups().map(([label, xs]) =>
    `<optgroup label="${esc(label)}">` + xs.map(({ p, type }) => {
      const id = placeId(type, p.name);
      return `<option value="${esc(id)}"${id === selectedRef ? " selected" : ""}>${esc(p.name)}</option>`;
    }).join("") + `</optgroup>`).join("");
  // ★消えた地点を指している ref を「地点なし」に見せると、他を触った拍子に紐づけが消える。
  //   選択済みの警告項目として残し、気づけるようにする。
  const missing = (selectedRef && !getPlaceById(selectedRef))
    ? `<option value="${esc(selectedRef)}" selected>⚠️ 見つからない地点（${esc(selectedRef)}）</option>` : "";
  return `<option value=""${selectedRef ? "" : " selected"}>${esc(blankLabel)}</option>${missing}${opts}`;
}

function populateSchedAddSelect() {
  const sel = $("#sched-add-place"); if (!sel) return;
  sel.innerHTML = placeOptionsHtml("＋ 候補から追加…", "");
  sel.addEventListener("change", () => {
    if (!sel.value) return;
    const p = getPlaceById(sel.value);
    if (p) insertSchedItem(schedItemFromName(p.name));
    sel.value = "";
  });
}

/* 予定行と地点の紐づけを変える唯一の関数。ref が空なら解除。
   ★各行のプルダウンの change と、マップのピンを行の真ん中へ落としたときが
     どちらもここを通る。2か所で書くと、片方だけ直して静かにズレる（0-1）。
   ★ここを変えるとマップのピン順（ルート）と確定状態の出どころが変わる。 */
function setSchedRef(i, ref) {
  if (!requireSharedEditing()) return;
  const it = schedule[i]; if (!it) return;
  if (ref) {
    // 紐づけると確定状態は共有ステート（getStatus）に従うようになる。表示が切り替わるのは正しい
    it.ref = ref;
    // 「＋ 空の行」で作った行は本文が空。空のときだけ地点名を入れる。
    // 本文がすでにあるときは触らない（「伊根 到着・駐車」の文面を勝手に変えない）
    if (!it.text) it.text = (getPlaceById(ref) || {}).name || "";
  } else {
    // 解除するときは、いまの見た目の状態を行に写しておく（勝手に未確定へ落ちないように）
    it.status = it.ref ? getStatus(it.ref) : (it.status === "confirmed" ? "confirmed" : "tentative");
    delete it.ref;
  }
  // 再描画してよい（テキスト入力と違い、カーソルもIME変換も飛ばない操作からしか呼ばれない）
  saveSchedule(); syncRouteFromSchedule(); renderScheduleEditor();
}

/* 落とした場所から「どの日の、schedule の何番目に入れるか」を決める。
   beforeNode ＝ 新しい行がその手前に入る #sched-list の子要素（null なら末尾）。

   ★候補リストからのドラッグ（SortableJS の onAdd）と、地図のピンからのドラッグが
     この1本を共有する。規則を2か所に書くと、片方だけ直して静かにズレる（0-1）。
   ★位置の測定（elementFromPoint など）は呼ぶ側の仕事にしてある。
     ここは DOM ノードを渡せば答えが決まる純粋な計算なので、テストで直接検査できる。 */
function schedDropSlot(beforeNode) {
  const list = $("#sched-list");
  const kids = list ? Array.prototype.slice.call(list.children) : [];
  const found = beforeNode ? kids.indexOf(beforeNode) : -1;
  const pos = found >= 0 ? found : kids.length;   // 見つからなければ末尾に落ちたとみなす
  // 落とした位置より上にある日付見出しが、その行の所属日になる
  let day = schedDayView === "all" ? FIRST_DAY : schedDayView;
  if (schedDayView === "all") {
    for (let k = pos - 1; k >= 0; k--) {
      if (kids[k].classList.contains("sched-day-head")) { day = normalizeDay(kids[k].dataset.day); break; }
    }
  }
  // 直前の予定行の実インデックスの次に挿す
  let at = -1;
  for (let k = pos - 1; k >= 0; k--) {
    if (kids[k].classList.contains("sched-item")) { at = +kids[k].dataset.i + 1; break; }
  }
  if (pos === 0 || at < 0) at = schedule.findIndex(it => normalizeDay(it.day) === day);
  return { day, at: at >= 0 ? at : undefined };
}

/* 予定行を「いま見ている日」の末尾に挿す。全体タブならその日のブロックの末尾へ入る */
function insertSchedItem(item, at) {
  if (!requireSharedEditing()) return;
  if (typeof at === "number" && at >= 0) {
    schedule.splice(at, 0, item);
  } else {
    // その日の最後の行の直後に入れる（日をまたいで混ざらないようにする）
    let last = -1;
    schedule.forEach((it, i) => { if (normalizeDay(it.day) === item.day) last = i; });
    if (last >= 0) schedule.splice(last + 1, 0, item);
    else schedule.push(item);
  }
  saveSchedule(); syncRouteFromSchedule(); renderScheduleEditor();
}

/* 右側の候補リスト（スポット/レストラン/カフェ）を描画。ドラッグまたは⊕で左へ追加。
   filter: "all" | "spots" | "restaurants" | "cafes" */
function renderSchedCandidates(filter = "all") {
  const el = $("#sched-candidates"); if (!el) return;
  const groups = [["spots", "🌿 スポット", "spot"], ["restaurants", "🍽 レストラン", "restaurant"], ["cafes", "☕ カフェ", "cafe"]];
  const shown = filter === "all" ? groups : groups.filter(g => g[0] === filter);
  const withHead = filter === "all";  // 「すべて」のときだけ見出しを挟む
  el.innerHTML = shown.map(([key, label, emoji]) => {
    const head = withHead ? `<li class="sched-cand-head">${label}</li>` : "";
    const items = DATA[key].map(p =>
      `<li class="sched-cand-item" data-name="${esc(p.name)}">
        <span class="type-emoji">${TYPE_ICONS[emoji]}</span>
        <span class="nm">${esc(p.name)}</span>
        <button class="cand-add" data-name="${esc(p.name)}" aria-label="${esc(p.name)}を予定に追加">⊕</button>
      </li>`).join("");
    return head + items;
  }).join("");
  const count = $("#sched-candidates-count");
  if (count) count.textContent = `（${shown.reduce((sum, [key]) => sum + DATA[key].length, 0)}件）`;
  $$("#sched-candidates .cand-add").forEach(b => b.addEventListener("click", () => {
    insertSchedItem(schedItemFromName(b.dataset.name));
  }));
}

/* 候補リストのサブタブ（すべて／スポット／レストラン／カフェ）切替 */
function setupSchedCandTabs() {
  const bar = $("#sched-cand-tabs"); if (!bar) return;
  $$(".sched-cand-tab", bar).forEach(t => t.addEventListener("click", () => {
    $$(".sched-cand-tab", bar).forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    renderSchedCandidates(t.dataset.filter);
  }));
}

/* 並び替え後、DOMの順番どおりに schedule を組み直す。
   全体表示では日付見出し行を境に day を振り直すので、
   別の日の見出しの下へドラッグするとその行の所属日が切り替わる。 */
function rebuildScheduleFromDom() {
  if (!requireSharedEditing()) return;
  const kids = Array.prototype.slice.call($("#sched-list").children);
  if (schedDayView === "all") {
    let cur = FIRST_DAY;
    const next = [];
    kids.forEach(li => {
      if (li.classList.contains("sched-day-head")) { cur = normalizeDay(li.dataset.day); return; }
      if (!li.classList.contains("sched-item")) return;
      const it = schedule[+li.dataset.i];
      if (it) next.push({ ...it, day: cur });
    });
    schedule = next;
  } else {
    // 日別表示: この日の行だけを並べ替え、他の日の行は元の位置のまま据え置く
    const order = kids.filter(li => li.classList.contains("sched-item")).map(li => +li.dataset.i);
    const reordered = order.map(i => ({ ...schedule[i], day: schedDayView }));
    const slots = [];
    schedule.forEach((it, i) => { if (normalizeDay(it.day) === schedDayView) slots.push(i); });
    const next = schedule.slice();
    slots.forEach((slot, n) => { next[slot] = reordered[n]; });
    schedule = next;
  }
}

let schedSortInit = false;
function setupScheduleSortable() {
  if (schedSortInit || typeof Sortable === "undefined" || !$("#sched-list")) return;
  schedSortInit = true;
  // タイムスケジュール: 内部並び替え＋候補からの受け入れ
  Sortable.create($("#sched-list"), {
    group: { name: "sched-shared", pull: false, put: true },
    animation: 150, handle: ".sched-handle", draggable: ".sched-item",
    ghostClass: "sortable-ghost", chosenClass: "sortable-chosen",
    onAdd: (evt) => {
      // 候補リストから落ちてきた要素を予定に変換。
      // 落とし場所の解釈は schedDropSlot() が持つ（地図のピンからの投入と同じ規則）
      const name = evt.item.dataset.name;
      const slot = schedDropSlot(evt.item);   // evt.item は既にその位置へ挿し込まれている
      evt.item.remove();
      if (name != null) insertSchedItem(schedItemFromName(name, slot.day), slot.at);
    },
    onUpdate: () => {
      rebuildScheduleFromDom();
      saveSchedule(); syncRouteFromSchedule(); renderScheduleEditor();
    }
  });
  // 候補リスト: クローンを引き出すだけ
  Sortable.create($("#sched-candidates"), {
    group: { name: "sched-shared", pull: "clone", put: false },
    sort: false, animation: 150, draggable: ".sched-cand-item"
  });
}

function renderRoutes() {
  $("#routes-content").innerHTML = DATA.legs.map(l =>
    `<div class="leg">
      <div class="leg-route"><b>${esc(l.from)}</b><span class="leg-arrow">→</span><b>${esc(l.to)}</b></div>
      <div class="leg-time">${esc(l.time)}</div>
      ${l.note ? `<div class="leg-note">${mdBold(l.note)}</div>` : ""}
    </div>`).join("");
}

/* ===== チケット・予約タブ =====
   公開データは予約概要のみ。添付表示の関数は再利用用に保持するが、原本を公開しない。
   ・画像 … 既存のライトボックスに .card-img-btn + data-images で相乗りする（新しい配線は要らない）
   ・.eml … 原本を配信し、開いたときにブラウザ側でデコードして表示する。
            テキストに展開したコピーをリポジトリに置かずに済む（同じ内容を2か所に持たない）
   ========================================================================= */
/* .eml の本文を取り出す。この3通は single-part / text/plain; charset=UTF-8 / base64 で、
   改行は \n のみ。ヘッダと本文は最初の空行で分かれる。
   ★catch の引数は err にすること。tools/test_site.js が天気の失敗処理を
     ソース走査で検査しており、同じ形の catch を増やすと誤爆する（追補F-37）。 */
function emlBodyText(raw) {
  try {
    const m = String(raw).match(/\r?\n\r?\n/);
    if (!m) return String(raw);
    const b64 = String(raw).slice(m.index + m[0].length).replace(/\s+/g, "");
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch (err) {
    return "";
  }
}
/* <details> を開いたときにだけ取りにいく。★init では読まない
   （誰も開かない添付を毎回落とさないため。jsdom には fetch が無いのでガードする） */
function loadEmlInto(box, path) {
  if (!box || box.dataset.loaded) return;
  box.dataset.loaded = "1";
  if (typeof fetch !== "function") { box.textContent = "（この環境では表示できません）"; return; }
  fetch(path)
    .then(r => r.text())
    .then(t => { box.textContent = emlBodyText(t) || "（本文を取り出せませんでした。原本をダウンロードしてください）"; })
    .catch(() => { box.textContent = "（読み込めませんでした。原本をダウンロードしてください）"; });
}

function ticketFileHtml(f) {
  if (f.type === "image") {
    return `<div class="ticket-file">
      <button class="ticket-shot card-img-btn" data-images='${esc(JSON.stringify([f.path]))}' data-index="0"
              aria-label="${esc(f.label)}を拡大">${encImg(f.path, ` alt="${esc(f.label)}"`)}</button>
      <div class="ticket-file-links">
        <span class="ticket-file-label">${esc(f.label)}</span>
        <a class="pill" href="${esc(f.path)}" target="_blank" rel="noopener">🔍 原寸で開く</a>
      </div>
    </div>`;
  }
  // .eml（予約メールの原本）
  return `<details class="eml">
    <summary>📧 ${esc(f.label)}を読む</summary>
    <pre class="eml-body" data-eml="${esc(f.path)}">読み込み中…</pre>
    <a class="pill" href="${esc(f.path)}" download>⬇ 原本（.eml）をダウンロード</a>
  </details>`;
}

function renderTickets() {
  const box = $("#tickets-content"); if (!box) return;
  box.innerHTML = allTickets().map(t => {
    const meta = (t.meta || []).map(m => `<li><b>${esc(m[0])}</b><span>${mdBold(m[1])}</span></li>`).join("");
    const links = (t.links || []).map(l =>
      `<a class="pill" href="${esc(l.url)}" target="_blank" rel="noopener">🔗 ${esc(l.label)}</a>`).join("");
    const places = (t.refs || []).map(r => {
      const p = getPlaceById(r);
      return p ? `<a class="pill" href="#" data-goto-ref="${esc(r)}">${TYPE_ICONS[p.type]} ${esc(p.name)}</a>` : "";
    }).join("");
    return `<article class="ticket-card" data-ticket="${esc(t.id)}">
      <div class="ticket-head">
        <span class="ticket-icon">${esc(t.icon || "🎫")}</span>
        <h3 class="ticket-title">${esc(t.title)}</h3>
        ${t.when ? `<span class="ticket-when">${esc(t.when)}</span>` : ""}
      </div>
      ${t.summary ? `<p class="ticket-summary">${mdBold(t.summary)}</p>` : ""}
      ${meta ? `<ul class="card-meta">${meta}</ul>` : ""}
      ${t.note ? `<div class="card-notes">${mdBold(t.note)}</div>` : ""}
      <div class="ticket-files">${(t.files || []).map(ticketFileHtml).join("")}</div>
      <div class="card-links">${places}${links}</div>
    </article>`;
  }).join("");
  // 添付メールは開いたときに取りにいく
  $$("#tickets-content .eml").forEach(d => d.addEventListener("toggle", e => {
    if (e.currentTarget.open) {
      const pre = e.currentTarget.querySelector(".eml-body");
      loadEmlInto(pre, pre.dataset.eml);
    }
  }));
}
function renderPacking() {
  const KEY = "ise-trip-packing";
  const saved = readSyncStore(KEY);
  $("#packing-content").innerHTML = DATA.packing.map(g =>
    `<div class="pack-group"><h3>${esc(g.group)}</h3><ul class="pack-list">${
      g.items.map(it => {
        const id = g.group + "::" + it;
        return `<li><label><input type="checkbox" data-pack="${esc(id)}" ${saved[id] ? "checked" : ""}><span>${esc(it)}</span></label></li>`;
      }).join("")
    }</ul></div>`).join("");
  $$("#packing-content input[data-pack]").forEach(cb => {
    cb.addEventListener("change", () => {
      saved[cb.dataset.pack] = cb.checked;
      localStorage.setItem(KEY, JSON.stringify(saved));
    });
  });
}
/* ===== 注意・要確認（ブラウザから編集できる。誤タップ防止に編集モード制） ===== */
const INFO_KEY = "ise-trip-info";
const INFO_VERSION = 2;   // 保存形式のバージョン（初期値の変更でリセットしない）
let INFO_DEFAULT = [];   // start() が入れる
let infoItems = [];        // start() で読み込む
// 編集モードは保存しない：読み込み直後は必ず閲覧モード＝誤タップで書き換わらない
let infoEditing = false;
let infoSortable = null;

function loadInfo() {
  try {
    const raw = JSON.parse(localStorage.getItem(INFO_KEY));
    if (raw && Array.isArray(raw.items)) return raw.items;
  } catch (e) {}
  return INFO_DEFAULT.map(x => ({ ...x }));
}
function saveInfo() {
  localStorage.setItem(INFO_KEY, JSON.stringify({ v: INFO_VERSION, items: infoItems }));
  fbPush("info", infoItems);
}
// 注意タブの本文も同じ軽量記法（定義は mdBold）。
const infoText = mdBold;

/* =========================================================================
   特集（読み物）
   ★記事は ref で地点を指すだけ。写真・営業時間・点数・リンクは DATA から引くので、
     地点を直したときに特集だけ古いまま残ることがない。
   ========================================================================= */
// 空行で段落を分ける（本文は **囲む** の軽量記法のみ。生HTMLは書かない）
function featureText(s) {
  return String(s || "").split(/\n{2,}/).map(t => `<p>${mdBold(t)}</p>`).join("");
}
// エリアのチップ。ラベルは絞り込みと同じ AREA_GROUPS を使い回す
function areaChip(p) {
  const g = AREA_GROUPS.find(([k]) => k === p.areaKey);
  return g ? `<span class="feature-chip area-${esc(p.areaKey)}">${esc(g[1])}</span>` : "";
}
// 特集タブのおすすめカードに出す meta の行（地点カードの meta から引くラベル）。
// ★ここに書いたラベルと、地点の meta の見出しは**同じ文字列**にすること（前方一致ではない）。
// この旅行では「営業 / 料金 / 所要」が判断に直結する。無いラベルは黙って飛ばされる。
const FEATURE_PICK_META = ["営業", "料金", "所要"];
/* 特集は複数本置ける。target が描き込み先、blocks がその記事の中身。
   ★1タブ1記事。タブボタンとパネルは index.html 側に置く（setupTabs は #panel-<name> で汎用に動く）。
     記事を増やすならここに1行足して index.html にタブとパネルを足すだけでよい。 */
const FEATURE_TABS = [
  { target: "#feature-content",  blocks: () => DATA.feature  },   // ラッコ観覧
  { target: "#feature2-content", blocks: () => DATA.feature2 },   // 特集2
];
// meta から指定ラベルの行を引く（営業時間や料金を記事側に書き写さないため）
function metaOf(p, label) {
  const row = (p.meta || []).find(m => m[0] === label);
  return row ? row[1] : "";
}
function renderFeaturePick(it) {
  const p = getPlaceById(it.ref);
  if (!p) return "";   // ★ref切れは何も描かずエラーも出ない。tools/test_days.js が検出する
  const imgs = p.images || [];
  const img = imgs.length
    ? `<button class="feature-pick-img card-img-btn" data-images='${esc(JSON.stringify(imgs))}' data-index="0" aria-label="${esc(p.name)}の写真を拡大">
         ${encImg(imgs[0], ` alt="${esc(p.name)}"`)}</button>`
    : "";
  // ★記事に営業時間や料金を書き写さず、地点カードの meta から引く（同じ事実を2か所に書かない）。
  //   旅行ごとに見せたい行が違うなら、FEATURE_PICK_META のラベルだけを変える。
  const rows = FEATURE_PICK_META.map(label => [label, metaOf(p, label)]).filter(([, v]) => v);
  return `<article class="feature-pick">
    ${img}
    <div class="feature-pick-body">
      <div class="feature-pick-head">
        ${it.tag ? `<span class="feature-pick-tag">${esc(it.tag)}</span>` : ""}
        ${areaChip(p)}
      </div>
      <h4 class="feature-pick-name">${TYPE_ICONS[p.type]} ${esc(p.name)}</h4>
      <p class="feature-pick-why">${mdBold(it.why)}</p>
      ${rows.length ? `<ul class="feature-pick-meta">
        ${rows.map(([k, v]) => `<li><b>${esc(k)}</b><span>${mdBold(v)}</span></li>`).join("")}
      </ul>` : ""}
      ${ratingChips(p)}
      ${linkPills(p)}
    </div>
  </article>`;
}
/* meta の1行を表のセルに詰める。散文なので先頭の **強調** だけを抜き、
   無ければ全文を使う。落とした部分は title 属性で読めるようにする。
   ★短縮するだけで、事実の出どころは meta のまま（記事側に書き写さない。0-1） */
function metaHead(p, label) {
  const full = metaOf(p, label);
  if (!full) return { short: "—", full: "" };
  const m = full.match(/\*\*([^*\n]+)\*\*/);
  return { short: m ? m[1] : full, full };
}
/* 比較表。既存の一覧表と同じ .ct-wrap > table.ct を使い回す（スマホでは横スクロール） */
function renderFeatureTable(b) {
  const cols = b.cols || [];
  const rows = (b.items || []).map(it => {
    const p = getPlaceById(it.ref);
    if (!p) return "";   // ★ref切れは何も描かない。tools/test_days.js が検出する
    const cells = cols.map(c => {
      const { short, full } = metaHead(p, c);
      return `<td${full ? ` title="${esc(full.replace(/\*\*/g, ""))}"` : ""}>${mdBold(short)}</td>`;
    }).join("");
    return `<tr class="ct-row" data-goto-ref="${esc(it.ref)}" tabindex="0" role="button"
      title="${esc(p.name)}のカードを見る">
      <td class="ct-name">${TYPE_ICONS[p.type]} ${esc(p.name)}${
        it.tag ? `<span class="ct-tag">${esc(it.tag)}</span>` : ""}</td>${cells}</tr>`;
  }).join("");
  return `<div class="ct-wrap"><table class="ct">
    <thead><tr><th>施設</th>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

/* 記事1ブロックぶんのHTML。★どのコンテナに入るかを知らない＝2本目の記事でもそのまま使える */
function featureBlockHtml(b) {
  const head = `<h3 class="feature-section-h">${esc(b.title)}</h3>` +
    (b.lead ? `<div class="feature-section-lead">${featureText(b.lead)}</div>` : "");
  if (b.kind === "picks") {
    return `<section class="feature-section${b.tone === "top" ? " top" : ""}">${head}
      <div class="feature-picks">${(b.items || []).map(renderFeaturePick).join("")}</div>
    </section>`;
  }
  if (b.kind === "list") {
    return `<section class="feature-section">${head}
      <dl class="feature-list">${(b.items || []).map(i =>
        `<dt>${esc(i.label)}</dt><dd>${mdBold(i.text)}</dd>`).join("")}</dl>
    </section>`;
  }
  if (b.kind === "table") {
    return `<section class="feature-section">${head}${renderFeatureTable(b)}</section>`;
  }
  if (b.kind === "sources") {
    return `<section class="feature-section">${head}
      <ul class="feature-sources">${(b.items || []).map(i =>
        `<li><a href="${esc(i.url)}" target="_blank" rel="noopener">🔗 ${esc(i.label)}</a></li>`).join("")}</ul>
    </section>`;
  }
  // kind: "note"
  return `<div class="info-card feature-note${b.warn ? " warn" : ""}">
    <h3>${esc(b.title)}</h3>${featureText(b.text)}</div>`;
}

function renderFeature() {
  FEATURE_TABS.forEach(t => {
    const box = $(t.target); if (!box) return;
    box.innerHTML = (t.blocks() || []).map(featureBlockHtml).join("");
  });
}

function renderInfo() {
  const box = $("#info-content"); if (!box) return;
  const panel = $("#panel-info");
  if (panel) panel.classList.toggle("editing", infoEditing);
  const btn = $("#info-edit-toggle");
  if (btn) {
    btn.textContent = infoEditing ? "✓ 編集を終える" : "✏️ 編集する";
    btn.classList.toggle("on", infoEditing);
  }

  if (!infoEditing) {
    box.innerHTML = infoItems.length
      ? infoItems.map(i =>
          `<div class="info-card ${i.warn ? "warn" : ""}"><h3>${esc(i.title)}</h3><p>${infoText(i.text)}</p></div>`).join("")
      : `<p class="muted">項目がありません。「✏️ 編集する」→「＋ 項目を追加」で作成できます。</p>`;
    if (infoSortable) { infoSortable.destroy(); infoSortable = null; }
    return;
  }

  box.innerHTML = infoItems.map((it, i) => `
    <div data-shared-edit class="info-card edit ${it.warn ? "warn" : ""}" data-i="${i}">
      <div class="info-edit-head">
        <span class="info-handle" title="ドラッグで並び替え" aria-label="ドラッグして並び替え">≡</span>
        <input class="info-title" type="text" data-i="${i}" value="${esc(it.title || "")}" placeholder="見出し" aria-label="見出し">
        <button class="info-warn ${it.warn ? "on" : ""}" data-i="${i}" title="重要マーク（左の線が赤くなります）">${it.warn ? "⚠️ 重要" : "重要にする"}</button>
        <button class="info-del" data-i="${i}" aria-label="この項目を削除" title="削除">✕</button>
      </div>
      <textarea class="info-text" data-i="${i}" rows="4" placeholder="内容を入力（**で囲むと太字）" aria-label="内容">${esc(it.text || "")}</textarea>
    </div>`).join("")
    || `<p class="muted">項目がありません。「＋ 項目を追加」で作成できます。</p>`;

  // 入力中は再描画しない（カーソル位置とIME変換が飛ぶため）
  $$("#info-content .info-title").forEach(el => el.addEventListener("input", e => {
    infoItems[+e.currentTarget.dataset.i].title = e.currentTarget.value; saveInfo();
  }));
  $$("#info-content .info-text").forEach(el => el.addEventListener("input", e => {
    infoItems[+e.currentTarget.dataset.i].text = e.currentTarget.value; saveInfo();
  }));
  $$("#info-content .info-warn").forEach(el => el.addEventListener("click", e => {
    const it = infoItems[+e.currentTarget.dataset.i]; it.warn = !it.warn; saveInfo(); renderInfo();
  }));
  $$("#info-content .info-del").forEach(el => el.addEventListener("click", e => {
    const i = +e.currentTarget.dataset.i;
    if (!confirm(`「${infoItems[i].title || "（無題）"}」を削除しますか？`)) return;
    infoItems.splice(i, 1); saveInfo(); renderInfo();
  }));
  setupInfoSortable();
}

function setupInfoSortable() {
  if (typeof Sortable === "undefined" || !$("#info-content")) return;
  if (infoSortable) infoSortable.destroy();
  infoSortable = Sortable.create($("#info-content"), {
    animation: 150, handle: ".info-handle", draggable: ".info-card",
    ghostClass: "sortable-ghost", chosenClass: "sortable-chosen",
    onEnd: () => {
      infoItems = $$("#info-content .info-card").map(el => infoItems[+el.dataset.i]);
      saveInfo(); renderInfo();
    }
  });
}

/* 現在の注意項目を INFO_DEFAULT 用のコード片として書き出す */
function exportInfo() {
  const lines = infoItems.map(it =>
    `  {\n    warn: ${it.warn ? "true" : "false"},\n    title: ${JSON.stringify(it.title || "")},\n    text: ${JSON.stringify(it.text || "")}\n  }`
  ).join(",\n");
  const out = `/* app.js の DATA.info に貼り替え、INFO_VERSION を +1 */\ninfo: [\n${lines}\n],`;
  if (navigator.clipboard) navigator.clipboard.writeText(out).catch(() => {});
  window.prompt("下記を app.js の DATA.info に貼り替え、INFO_VERSION を +1 して commit すると、全員の初期表示が更新されます（クリップボードにもコピー済み）:", out);
}

/* =========================================================================
   ライトボックス
   ========================================================================= */
const lb = { images: [], index: 0 };
function openLightbox(images, index) {
  lb.images = images; lb.index = index;
  $("#lightbox").classList.remove("hidden");
  $("#lightbox").setAttribute("aria-hidden", "false");
  updateLightbox();
}
function updateLightbox() {
  const lbPath = lb.images[lb.index];
  const lbImg = $("#lb-img");
  const ready = imageSrc(lbPath);
  lbImg.src = ready || "";
  lbImg.classList.toggle("is-loading", !ready);
  if (!ready) {
    const want = lbPath;
    requestImage(lbPath, null, url => {
      // 待っている間に別の写真へ送られていたら、届いた結果は捨てる
      if (!url || lb.images[lb.index] !== want) return;
      lbImg.src = url; lbImg.classList.remove("is-loading");
    });
  }
  $("#lb-counter").textContent = `${lb.index + 1} / ${lb.images.length}`;
  const multi = lb.images.length > 1;
  $("#lb-prev").style.display = multi ? "" : "none";
  $("#lb-next").style.display = multi ? "" : "none";
}
function closeLightbox() {
  $("#lightbox").classList.add("hidden");
  $("#lightbox").setAttribute("aria-hidden", "true");
}
function lbNext() { lb.index = (lb.index + 1) % lb.images.length; updateLightbox(); }
function lbPrev() { lb.index = (lb.index - 1 + lb.images.length) % lb.images.length; updateLightbox(); }
function setupLightbox() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".card-img-btn, .thumb-btn");
    if (btn) {
      const imgs = JSON.parse(btn.dataset.images);
      openLightbox(imgs, parseInt(btn.dataset.index, 10) || 0);
    }
  });
  $("#lb-close").addEventListener("click", closeLightbox);
  $("#lb-next").addEventListener("click", lbNext);
  $("#lb-prev").addEventListener("click", lbPrev);
  $("#lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
  document.addEventListener("keydown", (e) => {
    if ($("#lightbox").classList.contains("hidden")) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowRight") lbNext();
    else if (e.key === "ArrowLeft") lbPrev();
  });
}

/* =========================================================================
   ルート状態（localStorage）
   ========================================================================= */
/* ★ルートは「状態」ではなく「スケジュールから毎回作る値」。
   保存も Firebase 同期もしない。書き換えるのは routeFromSchedule() の結果だけ。

   かつては手で並べ替え・追加・削除ができたが、スケジュールを編集するたびに
   syncRouteFromSchedule() が丸ごと作り直すため、手動の編集は黙って消えていた
   （リロードだけでも消えた）。「編集できる見た目」のほうを無くして矛盾を解消した。
   順番を変えたいときはスケジュールタブで編集する（追補F）。 */
let routeIds = [];         // start() で作る
function routeIndex(id) { return routeIds.indexOf(id); }

/* =========================================================================
   地図（Leaflet）
   ========================================================================= */
let map, markerLayer, routeLine;
let cancelMapPinch = () => {};
const markers = {}; // id -> marker

/* ★初期表示の範囲は「見えるようになってから」当てる。
   高さ0のコンテナで fitBounds を呼ぶと getBoundsZoom が最大ズーム(18)に張り付き、
   あとから invalidateSize() を呼んでも直らない（invalidateSize は中心をずらすだけで
   ズームを計算し直さない）。マップタブを一度も開かずに編集モードで地図を出すと
   この経路に入るため、当たるまで持ち越す。
   なお fitBounds を当てるまで Leaflet は _loaded にならず、addLayer は内部で
   キューに積まれるだけなので、先にピンや点線を足しておいても落ちない。 */
let pendingFit = null;
function fitMapToPlaces() {
  if (!map || !pendingFit) return;
  const el = $("#map");
  if (!el || !el.clientHeight) return;   // まだ見えていない。次の機会に当てる
  map.fitBounds(pendingFit.pad(0.15));
  pendingFit = null;
}

function makeIcon(p, id) {
  const idx = routeIndex(id);
  let ring = "";
  if (idx >= 0) ring = "ring-route";
  else if (getStatus(id) === "confirmed") ring = "ring-confirmed";
  const num = idx >= 0 ? `<span class="pin-num">${idx + 1}</span>` : "";
  /* ★data-id は「地図から予定へドラッグする」ときの持ち手。#map に張った1本の
     pointerdown がここから地点を引くので、マーカーごとに listener を張らずに済む。
     ★title で「もう予定に入っている（N番）」を明示する。番号は routeIds の
     ＊最初の出現＊の順で、同じ地点をもう一度予定に足しても動かない（往復で
     起終点が2回出てくるため、あえて重複を除いている）。動かないことを黙って
     見せると「操作が効かなかった」と読まれるので、掴む前に分かるようにしておく。 */
  const label = idx >= 0
    ? `${p.name}（すでに予定 ${idx + 1} 番目に入っています）`
    : `${p.name}（まだ予定に入っていません）`;
  /* ピンの下に重ねるタグ（pinlabel列）。値の並びはチップのDOM順そのまま＝
     「何をどの順で出すか」の出どころを MAP_FILTER_COLUMNS 1か所に保つ（0-1）。
     点数は p.ratings から引く（一覧表の tableScore() と同じ出どころ）。
     ★持っていない値は出さない。食べログの無いスポットや★未評価は「データの欠け」であって
       故障ではないので、ここは黙って省くのが正しい（0-2 が禁じているのは壊れたまま動くこと）。
     ★このタグに title を付けないこと。tools/test_days.js §17 が html の＊最初の＊
       title を読んで「すでに予定N番目」を検査しているため、前に title が入ると意味が変わる。
     ★地点名だけ <span class="pin-name"> で包む。長さが青天井なのはこの値だけなので、
       幅の制限をそこに閉じ込める。タグ全体を切ると、名前の長い地点で後ろの点数まで
       消える（いちばん長い地点名は21文字あり、点数も持っている）。 */
  const on = $$('.filter-group[data-group="pinlabel"] input:checked').map(i => i.value);
  const r = p.ratings || {};
  const parts = on.map(v =>
    v === "name"                   ? `<span class="pin-name">${esc(p.name)}</span>` :
    v === "google"  && r.google    ? `⭐${esc(r.google)}` :
    v === "tabelog" && r.tabelog   ? `🍴${esc(r.tabelog)}` :
    v === "want"    && getWant(id) ? "★".repeat(getWant(id)) : "").filter(Boolean);
  /* ★.pin の「子」ではなく「兄弟」に置く。.pin は rotate(-45deg) の雫形なので、
     中に入れると文字まで斜めになり、逆回転を足す羽目になる（.pin span / .pin-num が実例）。 */
  const tag = parts.length ? `<div class="pin-tag">${parts.join(" ")}</div>` : "";
  return L.divIcon({
    className: "",
    html: `<div class="pin pin-${p.type} ${ring}" data-id="${esc(id)}" title="${esc(label)}"><span>${TYPE_ICONS[p.type]}</span>${num}</div>${tag}`,
    iconSize: [30, 30], iconAnchor: [15, 28], popupAnchor: [0, -28]
  });
}
function popupHtml(p, id) {
  const img = (p.images && p.images[0]) ? encImg(p.images[0], ' alt=""') : "";
  return `<div class="popup-card">
    ${img}
    <h4>${esc(p.name)}</h4>
    ${p.genre ? `<div class="p-genre">${esc(p.genre)}</div>` : ""}
    <div class="p-area">📍 ${esc(p.area)}</div>
    <p class="p-desc">${mdBold(p.desc)}</p>
    <div class="p-actions">
      <button class="p-btn add" ${sharedEditAttrs()} data-add-sched="${esc(id)}">＋ スケジュールに追加</button>
      <a class="p-btn maps" href="${placeMapsUrl(p)}" target="_blank" rel="noopener">📍マップ</a>
    </div>
  </div>`;
}
/* マップのフィルタ列を描く。★中身は MAP_FILTER_COLUMNS だけが決める（index.html には書かない）。
   呼ぶ場所に注意: setupMap() はマップタブを初めて開くまで走らないが、currentFilters() は
   init() の renderRouteEditor() から即座に呼ばれる。ここで #map-filters が空だと
   ルート列の .checked を読めずページ全体が落ちるので、init() の早い段階で呼ぶこと。 */
function renderMapFilters() {
  const el = $("#map-filters"); if (!el) return;
  const rows = MAP_FILTER_COLUMNS.map(c => {
    const chips = c.chips();
    if (!chips.length) return "";   // その旅行に該当が無い列は丸ごと出さない
    // ★チップは必ず .chip-row で包む。2列グリッドの右カラムに収まるので、
    //   何行に折り返してもラベルの下に回り込まない（カード側と同じ理由）
    return `<div class="filter-group" data-group="${esc(c.group)}">
      <span class="filter-label">${esc(c.label)}</span>
      <div class="chip-row">${chips.map(([v, l]) =>
        `<label class="chip"><input type="checkbox" value="${esc(v)}"${c.off ? "" : " checked"}> ${esc(l)}</label>`
      ).join("")}</div>
    </div>`;
  }).join("");
  // 件数バッジ #map-filter-count は applyFilters() の書き込み先。消さないこと
  el.innerHTML = `
    <div class="tools-head">
      <span class="tools-title">地図に出すピン</span>
      <span class="muted map-filter-count" id="map-filter-count"></span>
    </div>` + rows;
}
function currentFilters() {
  const get = g => $$(`.filter-group[data-group="${g}"] input:checked`).map(i => i.value);
  // ★「日」フィルタ（4泊5日対応）。閲覧者ごとのローカル操作なので同期しない。
  //   グループが無い場合（テスト等）は全日選択とみなす。
  const dayInputs = $$(`.filter-group[data-group="day"] input`);
  const days = dayInputs.length ? get("day") : DAY_KEYS.slice();
  // 「犬」フィルタ。列が無ければ null＝素通し（犬連れでない旅行では列ごと外せる）
  const areaInputs = $$(`.filter-group[data-group="area"] input`);
  /* 「予定」フィルタ。★1つ目のチップを決め打ちで読まないこと。
     チップを増やしたときに、読む対象が並び順で入れ替わって静かに壊れる。
     他の列と同じく「チェックされた値の配列」で持ち、
     0個（＝どちらも選んでいない）と全部チェックはどちらも素通しにする。 */
  const routeInputs = $$(`.filter-group[data-group="route"] input`);
  const plan = get("route");
  return { type: get("type"), status: get("status"),
           area: areaInputs.length ? get("area") : null,
           plan, planFilterOn: routeInputs.length > 0 && plan.length > 0 && plan.length < routeInputs.length,
           days, dayFilterOn: dayInputs.length > 0 && days.length < DAY_KEYS.length };
}
/* いま表示対象になっている日の地点だけを、スケジュール順に並べて返す
   （点線・Googleマップのナビはこれを使う）

   ★ここが見ているのは「日」だけ。種類・状態・犬で絞ってもルートは変わらない。
     書き忘れではなく仕様。犬で絞ってナビの経由地が減ると、
     「犬不可の場所を外したらルートが途中で切れた」という事故になるため。
     日だけが例外なのは、Googleマップの経由地が9件までで5日ぶんを1本に渡せないから（追補K-5）。 */
function visibleRouteIds() {
  const f = currentFilters();
  if (!f.dayFilterOn) return routeIds.slice();
  // ★日で絞ったときは routeIds の順ではなく「その日のスケジュール順」に並べ直す。
  //   三宮のように往路と復路の両方に出てくる地点があると、routeIds は先頭の1回しか
  //   持たないため、そのままでは復路のナビが逆向きになってしまう。
  const seen = new Set(), out = [];
  schedule.forEach(it => {
    if (!it.ref || !getPlaceById(it.ref)) return;
    if (!f.days.includes(normalizeDay(it.day))) return;
    if (seen.has(it.ref)) return;
    seen.add(it.ref); out.push(it.ref);
  });
  // ★かつては「手でルートへ足した、どの日にも属さない地点」を末尾に足していたが、
  //   ルートがスケジュールの導出値になったので、そういう地点は存在しなくなった
  return out;
}
// 地図タブのカードとピンが同じ判定を使う。日・予定の既存の意味は変えない。
function filteredMapPlaces() {
  const f = currentFilters();
  return allPlaces().filter(p => {
    const id = placeId(p.type, p.name), inRoute = routeIndex(id) >= 0, pdays = daysOfPlace(id);
    const dayOk = !f.dayFilterOn || pdays.size === 0 || f.days.some(x => pdays.has(x));
    const areaOk = !f.area || f.area.includes(groupKeyOf(p, "area"));
    const planOk = !f.planFilterOn || f.plan.includes(inRoute ? "route-only" : "route-none");
    return f.type.includes(p.type) && f.status.includes(getStatus(id)) && dayOk && areaOk && planOk;
  });
}
function applyFilters() {
  const key = activeBrowseKey();
  const places = key ? browsePlaces(key) : filteredMapPlaces();
  const ids = new Set(places.map(p => placeId(p.type, p.name)));
  Object.entries(markers).forEach(([id, m]) => {
    if (ids.has(id)) { if (!markerLayer.hasLayer(m)) m.addTo(markerLayer); }
    else if (markerLayer.hasLayer(m)) markerLayer.removeLayer(m);
  });
  const c = $("#map-filter-count");
  if (c) c.textContent = `${filteredMapPlaces().length} / ${allPlaces().length}地点`;
  if (key) {
    const root = $(`#browse-${key}`);
    $(".browse-map-message", root).textContent = places.length ? "" : "条件に合う地点がありません。絞り込みを変更してください。";
    $(".browse-fit", root).disabled = !places.length;
    reconcileBrowseSelection(key);
  }
  renderMapCards();
}
function routeCoords() {
  return visibleRouteIds().map(getPlaceById).filter(Boolean).map(p => p.coords);
}
// 現在のルート（経由地の順）をGoogleマップのナビURLにする。スマホではGoogleマップアプリが起動する。
function googleMapsDirUrl() {
  // ★経由地はURL仕様上9件が上限。4泊5日を1本にすると必ず溢れるので、
  //   マップの「日」フィルタで絞られた地点だけを対象にする。
  const pts = visibleRouteIds().map(getPlaceById).filter(Boolean);
  if (!pts.length) return null;
  const c = p => `${p.coords[0]},${p.coords[1]}`;
  if (pts.length === 1) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c(pts[0]))}`;
  const origin = c(pts[0]), destination = c(pts[pts.length - 1]);
  // 経由地はURL仕様上ほどほどに（先頭=出発, 末尾=目的地, 中間=waypoints）
  const mid = pts.slice(1, -1).map(c).slice(0, 9);
  let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving`;
  if (mid.length) url += `&waypoints=${encodeURIComponent(mid.join("|"))}`;
  return url;
}
function drawRouteLine() {
  const coords = routeCoords();
  if (routeLine) map.removeLayer(routeLine);
  if (activeBrowseKey() && activeBrowseKey() !== "map") { routeLine = null; return; }
  routeLine = L.polyline(coords, { color: "#1f9c9c", weight: 3, dashArray: "7 7", opacity: .85 }).addTo(map);
}
function refreshMarkers() {
  allPlaces().forEach(p => {
    const id = placeId(p.type, p.name);
    if (markers[id]) markers[id].setIcon(makeIcon(p, id));
  });
  updateBrowseFocus();
}
/* 予定の行にポインタを乗せたとき、その地点のピンを目立たせる。
   ★状態は持たない。クラスを付けて外すだけなので、refreshMarkers() でピンが
     作り直されても次にポインタを乗せた時点で付き直る（ズレが残らない）。 */
function focusPin(id) {
  $$("#map .pin.is-focus").forEach(el => el.classList.remove("is-focus"));
  Object.entries(markers).forEach(([key, m]) => m.setZIndexOffset?.(key === id ? 10000 : 0));
  if (!id || !markers[id] || !markers[id].getElement) return;
  const el = markers[id].getElement();
  const pin = el && el.querySelector(".pin");
  if (pin) pin.classList.add("is-focus");
}
/* ピンから予定行へ。編集中で一覧が出ているときだけ意味がある */
function scrollSchedRowIntoView(id) {
  if (!id || !$("#panel-schedule.active #sched-list")) return;
  const i = schedule.findIndex(it => it.ref === id);
  if (i < 0) return;
  const row = $$("#sched-list > li.sched-item").find(li => +li.dataset.i === i);
  if (!row) return;   // 別の日を表示中で、その行が出ていない
  if (row.scrollIntoView) row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("is-flash");
  setTimeout(() => row.classList.remove("is-flash"), 1200);
}
function setupMap() {
  map = L.map("map", { scrollWheelZoom: false, zoomSnap: .25 });
  cancelMapPinch = installMapTrackpadZoom(map, $("#map"));
  setupMapSizeObserver();
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: '© OpenStreetMap contributors'
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);

  const pts = [];
  allPlaces().forEach(p => {
    const id = placeId(p.type, p.name);
    const m = L.marker(p.coords, { icon: makeIcon(p, id) });
    m.bindPopup(popupHtml(p, id));
    m.on("click", () => { const key = activeBrowseKey(); if (key) selectBrowsePlace(key, id, true); });
    markers[id] = m;
    m.addTo(markerLayer);
    pts.push(p.coords);
  });
  drawRouteLine();
  applyFilters();
  const initial = activeBrowseKey() ? browsePlaces(activeBrowseKey()).map(p => p.coords) : pts;
  if (initial.length) pendingFit = L.latLngBounds(initial);
  else {
    // 0件でfitBoundsを呼ばない。地図の初期化に必要な中心だけを設定する。
    const wp = DATA.weatherPoint;
    map.setView(wp ? [wp.lat, wp.lon] : (pts[0] || [0, 0]), 11);
  }
  fitMapToPlaces();       // ★見えていれば今すぐ、見えていなければ次の機会に（上の説明）

  // フィルタ
  $$("#map-filters input").forEach(i => i.addEventListener("change", () => {
    // 表示切替は全地図で共用する。カード・ルート・表示範囲には触れない。
    if (i.closest('[data-group="pinlabel"]')) { refreshMarkers(); return; }
    applyFilters();
    drawRouteLine();      // 日で絞ったら点線も追随させる
    renderRouteEditor();  // 「Googleマップでルートを開く」のURLを組み直す
    refreshMarkers();
  }));

  // ポップアップ内「追加」
  map.on("popupopen", onMapPopupOpen);

  // ピンをスケジュールへドラッグする配線（パソコンのみ。中で判定している）
  setupPinDrag();
}

/* Macのピンチ: Chrome等のctrl+wheelと、SafariのGestureEventを受ける。
   通常のwheelはページへ通し、直接画面を触るピンチはLeafletのtouchZoomに任せる。
   地図は1個なのでイベントも1組だけ。ドック移動時は途中のズームだけを取り消す。 */
function installMapTrackpadZoom(m, el) {
  const events = new AbortController();
  let state = null, frame = 0, timer = 0, touches = 0, gestureUntil = 0;
  const clamp = zoom => Math.max(m.getMinZoom(), Math.min(m.getMaxZoom(), zoom));
  const busy = () => !!pinDrag || !!schedLayoutController?.drag;
  const visible = () => el.clientWidth > 0 && el.clientHeight > 0 && !document.hidden;
  const accepts = e => e.cancelable && !touches && visible() &&
    !e.target.closest?.(".leaflet-control, .leaflet-popup");
  const cancel = () => {
    cancelAnimationFrame(frame); clearTimeout(timer);
    state = null; frame = 0; timer = 0; gestureUntil = 0;
  };
  const flush = () => {
    cancelAnimationFrame(frame); frame = 0;
    if (!state) return;
    if (!visible() || busy()) { cancel(); return; }
    // setZoomAroundが中心を計算する前に丸める。同じ倍率の微小入力で地図が流れないようにする。
    const snap = m.options.zoomSnap;
    const zoom = clamp(snap ? Math.round(state.zoom / snap) * snap : state.zoom);
    if (zoom !== m.getZoom()) m.setZoomAround(state.point, zoom, { animate: false });
  };
  const queue = () => { if (!frame) frame = requestAnimationFrame(flush); };
  const point = e => {
    const rect = el.getBoundingClientRect();
    return Number.isFinite(e.clientX) && Number.isFinite(e.clientY) &&
      e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom
      ? m.mouseEventToContainerPoint(e) : m.getSize().divideBy(2);
  };
  const on = (target, type, listener, options = {}) =>
    target.addEventListener(type, listener, { ...options, signal: events.signal });
  on(el, "wheel", e => {
    if (!e.ctrlKey || !Number.isFinite(e.deltaY) || !accepts(e)) return;
    e.preventDefault();
    // Safariが両形式を通知した場合の二重ズームを防ぐ。
    if (busy() || state?.kind === "gesture" || performance.now() < gestureUntil) return;
    if (state?.kind !== "wheel") {
      m.stop(); state = { kind: "wheel", zoom: m.getZoom(), point: point(e) };
    }
    const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
    state.zoom = clamp(state.zoom - pixels / (100 * Math.LN2));
    state.point = point(e);
    queue(); clearTimeout(timer);
    timer = setTimeout(() => { flush(); cancel(); }, 160);
  }, { passive: false });
  on(el, "gesturestart", e => {
    if (!accepts(e) || !window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return;
    e.preventDefault();
    if (busy()) return;
    cancel(); m.stop();
    state = { kind: "gesture", startZoom: m.getZoom(), zoom: m.getZoom(), point: point(e) };
  }, { passive: false });
  const changeGesture = e => {
    if (state?.kind !== "gesture") return;
    if (e.cancelable) e.preventDefault();
    if (!Number.isFinite(e.scale) || e.scale <= 0) return;
    state.zoom = clamp(state.startZoom + Math.log2(e.scale));
    queue();
  };
  on(window, "gesturechange", changeGesture, { passive: false });
  on(window, "gestureend", e => {
    if (state?.kind !== "gesture") return;
    changeGesture(e); flush(); cancel();
    gestureUntil = performance.now() + 120;
  }, { passive: false });
  on(el, "touchstart", e => { touches = e.touches.length; cancel(); }, { passive: true, capture: true });
  for (const type of ["touchend", "touchcancel"]) {
    on(el, type, e => { touches = e.touches.length; }, { passive: true, capture: true });
  }
  on(el, "pointerdown", cancel, { capture: true });
  on(el, "keydown", cancel);
  on(window, "blur", () => { touches = 0; cancel(); });
  on(window, "resize", cancel);
  on(document, "visibilitychange", () => { touches = 0; cancel(); });
  m.on("unload", () => { cancel(); events.abort(); });
  return cancel;
}

function onMapPopupOpen(e) {
  const btn = e.popup._contentNode.querySelector("[data-add-sched]");
  if (!btn) return;
  // ポップアップを開き直しても多重登録しない。document のカード用委任には渡さない。
  btn.onclick = event => {
    event.stopPropagation();
    map.closePopup();
    addPlaceToSchedule(btn.dataset.addSched);
  };
  scrollSchedRowIntoView(btn.dataset.addSched);
}

/* 地図の遅延初期化はここだけ。マップタブと、編集モードの「地図で選ぶ」の両方から呼ぶ。
   ★「初期化済みか」を別のフラグで持たない。map の有無がそのまま答えなので、
     フラグを足すと同じ事実が2か所になる（0-1）。 */
function ensureMap() {
  if (map || typeof L === "undefined" || !$("#map")) return;
  setupMap();
}
/* 地図を見せたあとに必ず呼ぶ。非表示の div の中でサイズが 0 のままになっているのを直す */
function revealMap(fit = true) {
  if (!map) return;
  map.invalidateSize();
  if (fit) fitMapToPlaces();
}

/* ===== 地図の間借り（編集モードへの引っ越し） =====
   ★地図は1つしか作らない。編集モードで「地図で選ぶ」を開いたときは、
     2つ目を作るのではなく #map-dock ごと引っ越す。2つ持つと「いまどのピンが
     出ているか」という同じ事実が2か所になり、refreshMarkers()／applyFilters()／
     drawRouteLine()／currentFilters() を両方に効かせる同期コードが要る。
     それは二重化を固定するということで、かつて廃止した「スケジュールの控え」と
     同じ轍を踏む（0-1）。同期を足して解決しようとしない。

   ★置き場所は「状態から毎回決める」。routeFromSchedule() と同じ考え方で、
     「編集セクションを作り直す前に地図を返すのを忘れないこと」という
     人間向けの手順を作らない（0-3）。判断者は syncMapDock() ただ一つ。 */
function undockMap() {
  cancelMapPinch();
  endSchedResize(false);
  endPinDrag();   // ★引っ越しの前に、進行中のドラッグを畳む（地図が固まったままにしない）
  const dock = $("#map-dock"), home = $("#map-dock-home");
  if (!dock || !home) return;
  if (dock.parentNode !== home) home.appendChild(dock);
  dock.classList.remove("in-editor");
}
function syncMapDock() {
  const dock = $("#map-dock"), home = $("#map-dock-home"), slot = $("#sched-map-slot");
  if (!dock || !home) return;
  const active = $("#tabs .tab.active")?.dataset.tab;
  const key = activeBrowseKey();
  const wantSlot = !!slot && !!schedEditing && schedMapOpen && active === "schedule";
  const category = key && key !== "map" ? key : null;
  const target = category ? $(`#browse-slot-${category}`) : wantSlot ? slot : home;
  const context = category || "shared";
  if (map && mapContext !== context) {
    mapViews[mapContext] = { center: map.getCenter(), zoom: map.getZoom() };
  }
  const changed = mapContext !== context;
  if (dock.parentNode !== target || changed) {
    cancelMapPinch(); endSchedResize(false); endBrowseResize(); endPinDrag();
    focusPin(null);
    Object.values(browseViews).forEach(v => { v.hover = null; v.focused = null; });
    target.appendChild(dock);
  }
  if (!wantSlot) endSchedResize(false);
  dock.classList.toggle("in-editor", wantSlot);
  dock.classList.toggle("in-browse-category", !!category);
  const filters = $("#map-filters");
  const filterHome = key === "map" ? $("#browse-map-filter-slot") : dock;
  if (filters && filterHome && filters.parentNode !== filterHome) filterHome.prepend(filters);
  syncBrowseLayout();
  if (wantSlot || key || active === "map") {
    const firstMap = !map;
    mapContext = context;
    ensureMap();
    if (!map) return;
    revealMap(firstMap);
    if (changed) {
      const view = mapViews[context];
      if (view) map.setView(view.center, view.zoom, { animate: false });
      else if (key) fitBrowsePlaces();
      else { pendingFit = L.latLngBounds(allPlaces().map(p => p.coords)); fitMapToPlaces(); }
    }
    applyFilters(); drawRouteLine(); updateBrowseFocus(); queueMapResize();
  }
}

// 地図1個に監視も1組。非表示・ドック移動・列幅変更をまとめて扱う。
let mapSizeObserver = null, mapSizeFrame = 0, mapLastSize = "";
function queueMapResize() {
  if (!map || mapSizeFrame) return;
  mapSizeFrame = requestAnimationFrame(() => {
    mapSizeFrame = 0;
    const el = $("#map"), size = `${el?.clientWidth},${el?.clientHeight}`;
    if (el?.clientWidth && el?.clientHeight && size !== mapLastSize) {
      map.invalidateSize({ animate: false, debounceMoveend: true }); mapLastSize = size;
    }
  });
}
function setupMapSizeObserver() {
  if (typeof ResizeObserver === "function") {
    mapSizeObserver = new ResizeObserver(queueMapResize); mapSizeObserver.observe($("#map"));
  }
  window.addEventListener("resize", queueMapResize);
  map.on("unload", () => {
    mapSizeObserver?.disconnect(); window.removeEventListener("resize", queueMapResize);
    cancelAnimationFrame(mapSizeFrame); mapSizeFrame = 0;
  });
}

/* ===== 地図のピンをスケジュールへドラッグして入れる（プランニング） =====
   ★書き換えるのは正本の schedule だけ。導出値の routeIds には触らない。
     触っても次の syncRouteFromSchedule() が作り直すので黙って消える
     （チェックリストD／追補F-24）。落とし場所の解釈は schedDropSlot() に任せ、
     投入は insertSchedItem() を通す＝スケジュールへの書き込み経路を増やさない。

   ★SortableJS でも HTML5 の dragstart でもなく Pointer Events を直に使う理由:
     ・Leaflet のマーカーは transform で配置され DOM の並び順に意味がない。
       SortableJS の「並べ替え」モデルに乗らない
     ・HTML5 の dragstart は iOS Safari で発火しない
     ・どのみち map.dragging を止めないと、ピンを掴んだ瞬間に地図がパンする

   ★ドラッグの最中に掴んでいる .pin が消えることがある。refreshMarkers() → setIcon()
     は Leaflet の DivIcon が innerHTML で中身を作り直すので、同行者の編集が
     Firebase で届いただけで要素が入れ替わる。そのため:
     ・setPointerCapture() を使わない（要素が消えると pointerup が届かず、
       map.dragging.enable() が永久に呼ばれずに地図が操作不能になる）
     ・move / up / cancel は window に張る
     ・地点は掴んだ時点で控える（落とすときに DOM から読み直さない）
     ・落とし先は落とした瞬間に解決する（hover 中に覚えておかない） */
const PIN_DRAG_THRESHOLD = 8;   // これ未満の動きはタップ扱い（ポップアップを開く）
let pinDrag = null;
let pinScrollRaf = 0, pinScrollDir = 0;

/* ★スマホでは登録しない。地図は「見るため」に開くもので、予定への投入は
   ポップアップの「＋ スケジュールに追加」を使う。
   「スマホでは使わない」を人の記憶ではなくメディアクエリで担保する（0-3）。 */
function pinDragEnabled() {
  return typeof window.matchMedia === "function"
      && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}
function setupPinDrag() {
  const el = $("#map");
  if (!el || el.dataset.pinDrag || !pinDragEnabled()) return;
  el.dataset.pinDrag = "1";     // #map は作り直さないので、この1本で足りる
  el.addEventListener("pointerdown", onPinDown);
}
/* 地図側のジェスチャはまとめて止め、まとめて戻す。片方だけ戻し忘れると
   「パンできないのにスクロールは通る」という分かりにくい壊れ方をする。 */
function setMapGestures(on) {
  ["dragging", "touchZoom", "tapHold"].forEach(k => {
    if (map && map[k]) map[k][on ? "enable" : "disable"]();
  });
}

function onPinDown(e) {
  if (!canEditShared()) return;
  if (!e.isPrimary || (e.button != null && e.button > 0)) return;
  const pin = e.target && e.target.closest && e.target.closest(".pin[data-id]");
  if (!pin || !$("#sched-list") || !$("#panel-schedule.active") || !$("#map-dock.in-editor")) return;   // 編集モードで地図を開いているときだけ効く
  const place = getPlaceById(pin.dataset.id);
  if (!place) return;
  endPinDrag();
  pinDrag = { id: pin.dataset.id, name: place.name, x0: e.clientX, y0: e.clientY, moved: false, ghost: null };
  setMapGestures(false);
  window.addEventListener("pointermove", onPinMove);
  window.addEventListener("pointerup", onPinUp);
  window.addEventListener("pointercancel", onPinUp);
}
function onPinMove(e) {
  if (!pinDrag) return;
  if (!e.isPrimary) { endPinDrag(); return; }   // 2本目の指が来たら中止（座標が崩れる）
  if (!pinDrag.moved) {
    if (Math.abs(e.clientX - pinDrag.x0) < PIN_DRAG_THRESHOLD &&
        Math.abs(e.clientY - pinDrag.y0) < PIN_DRAG_THRESHOLD) return;
    pinDrag.moved = true;
    /* ★ここで範囲選択を止める。pointerdown では preventDefault できない
       （Leaflet のクリック→ポップアップが死ぬ）ので、そのぶんブラウザの既定の
       ドラッグ選択が始まっている。すでに選ばれたぶんを消し、以後を止める。
       最初から user-select:none にはしない——予定の本文をコピーできなくなる。 */
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
    document.body.classList.add("pin-dragging");
    pinDrag.ghost = document.createElement("div");
    pinDrag.ghost.className = "pin-ghost";
    document.body.appendChild(pinDrag.ghost);
  }
  e.preventDefault();
  pinDrag.ghost.style.left = e.clientX + "px";
  pinDrag.ghost.style.top = e.clientY + "px";
  const target = dropTargetAt(e.clientX, e.clientY);
  // 落とすと何が起きるかを、掴んだまま分かるようにする
  pinDrag.ghost.textContent = (target && target.onto) ? `📍 この行に紐づけ：${pinDrag.name}` : pinDrag.name;
  pinDrag.ghost.classList.toggle("is-onto", !!(target && target.onto));
  markDropTarget(target);
  const list = $("#sched-list");
  const r = list && list.getBoundingClientRect();
  pinScrollDir = !r ? 0 : (e.clientY < r.top + 48 ? -1 : e.clientY > r.bottom - 48 ? 1 : 0);
  if (pinScrollDir && !pinScrollRaf) pinScrollRaf = requestAnimationFrame(pinAutoScroll);
}
function onPinUp(e) {
  if (!pinDrag) return;
  const moved = pinDrag.moved, name = pinDrag.name, id = pinDrag.id;
  const target = moved ? dropTargetAt(e.clientX, e.clientY) : null;
  endPinDrag();                 // ★先に畳む。このあと何が起きても地図は生き返る
  if (!moved || !target) return;   // タップ、または一覧の外＝ポップアップに任せる
  /* ★落とし先は「いま」の DOM から解決する。ドラッグ中に同行者の編集が届いて
     一覧が描き直されていることがあるので、hover 中に覚えた行は当てにしない。 */
  if (target.onto && target.onto.isConnected) {
    // 行の真ん中に落とした＝その予定に地点を紐づける（新しい行は増やさない）
    setSchedRef(+target.onto.dataset.i, id);
    return;
  }
  const before = target.before && target.before.isConnected ? target.before : null;
  const slot = schedDropSlot(before);
  insertSchedItem(schedItemFromName(name, slot.day), slot.at);
}
function endPinDrag() {
  if (!pinDrag) return;
  const moved = pinDrag.moved;
  if (pinDrag.ghost) pinDrag.ghost.remove();
  document.body.classList.remove("pin-dragging");   // ★出口はここ1本。必ず選択を戻す
  markDropTarget(null);
  if (pinScrollRaf) cancelAnimationFrame(pinScrollRaf);
  pinScrollRaf = 0; pinScrollDir = 0;
  window.removeEventListener("pointermove", onPinMove);
  window.removeEventListener("pointerup", onPinUp);
  window.removeEventListener("pointercancel", onPinUp);
  pinDrag = null;
  setMapGestures(true);         // ★どの出口を通っても、必ずここを通ること
  if (moved) {
    // 実際に動かしたあとの合成 click でポップアップが開かないよう、1回だけ握り潰す
    const el = $("#map");
    if (el) el.addEventListener("click", ev => { ev.stopPropagation(); ev.preventDefault(); },
                                { capture: true, once: true });
  }
}
function pinAutoScroll() {
  pinScrollRaf = 0;
  if (!pinDrag || !pinScrollDir) return;
  const list = $("#sched-list");
  // 一覧が自前のスクロール枠を持っていればそれを、無ければページを動かす
  if (list && list.scrollHeight > list.clientHeight + 1) list.scrollTop += pinScrollDir * 14;
  else window.scrollBy(0, pinScrollDir * 14);
  pinScrollRaf = requestAnimationFrame(pinAutoScroll);
}
/* 行の矩形のどこに落ちたか。
   ★上下の端は「行と行の間に入れる」、真ん中は「その行に地点を紐づける」。
     端の幅は行の高さの3割（最大14px）。行が低いときでも真ん中が潰れないようにする。
   ★矩形を渡すだけの純関数にしてある。位置の測定は dropTargetAt() の仕事で、
     こちらは jsdom でもそのまま検査できる（0-6 の線引き）。 */
function dropZoneIn(rect, y) {
  const edge = Math.min(14, rect.height * 0.3);
  if (y < rect.top + edge) return "before";
  if (y > rect.bottom - edge) return "after";
  return "onto";
}
/* ポインタの真下がどこかを返す。一覧の外なら null。
   ・{ before: li }   … その行の手前に新しい予定を入れる（li が null なら末尾）
   ・{ onto: li }     … その予定に地点を紐づける（行は増えない）
   ★行の矩形で判定する。行と行のすき間に落としても受け付けたいので
     elementFromPoint（＝真下の1要素）は使わない。 */
function dropTargetAt(x, y) {
  const list = $("#sched-list"); if (!list) return null;
  const r = list.getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
  const rows = $$("#sched-list > li");
  for (let i = 0; i < rows.length; i++) {
    const rr = rows[i].getBoundingClientRect();
    if (y > rr.bottom) continue;                       // まだ下の行
    const zone = dropZoneIn(rr, y);
    // 日付見出しには紐づけられない（data-i を持たない）ので、常に「間に入れる」
    const linkable = rows[i].classList.contains("sched-item");
    if (zone === "onto" && linkable) return { onto: rows[i] };
    if (zone === "after") return { before: rows[i + 1] || null };
    return { before: rows[i] };
  }
  return { before: null };   // 末尾へ
}
/* 落ちる場所の目印。★行を挿し込まずクラスだけで出す（挿し込むと
   schedDropSlot() が数える子要素が変わってしまう）。
   線＝間に入る／枠＝その行に紐づく、で見分けられるようにする。 */
function markDropTarget(target) {
  const list = $("#sched-list"); if (!list) return;
  $$("#sched-list > li.drop-before, #sched-list > li.drop-onto")
    .forEach(el => el.classList.remove("drop-before", "drop-onto"));
  list.classList.remove("drop-end");
  if (!target) return;
  if (target.onto) target.onto.classList.add("drop-onto");
  else if (target.before) target.before.classList.add("drop-before");
  else list.classList.add("drop-end");
}

/* =========================================================================
   ルート編集 UI（SortableJS）
   ========================================================================= */
function renderRouteEditor() {
  const list = $("#route-list");
  if (!routeIds.length) {
    list.innerHTML = `<li class="route-empty">スケジュールに地点が紐づいていません。スケジュールタブで予定に地点を紐づけると、ここに順番が出ます。</li>`;
  } else {
    list.innerHTML = routeIds.map(id => {
      const p = getPlaceById(id); if (!p) return "";
      return `<li class="route-item" data-id="${esc(id)}">
        <span class="num"></span>
        <span class="type-emoji">${TYPE_ICONS[p.type]}</span>
        <span class="nm">${esc(p.name)}</span>
      </li>`;
    }).join("");
  }
  // ★閲覧専用。並べ替え・追加・削除の手段は置かない（順番はスケジュールが決める）
  // Googleマップでルートを開くボタンのリンクを更新（空なら無効化）
  const g = $("#route-gmaps");
  if (g) {
    const url = googleMapsDirUrl();
    const n = visibleRouteIds().length;
    // ★経由地は9件が上限。件数を出して「多すぎる」ことがその場で分かるようにする
    g.textContent = n ? `🗺 Googleマップでルートを開く（${n}地点）` : "🗺 Googleマップでルートを開く";
    if (n > 11) g.title = "経由地は9件までしか渡せません。マップの「日」フィルタで1日だけに絞ってください。";
    else g.removeAttribute("title");
    g.classList.toggle("too-many", n > 11);
    if (url) { g.href = url; g.classList.remove("disabled"); g.removeAttribute("aria-disabled"); }
    else { g.removeAttribute("href"); g.classList.add("disabled"); g.setAttribute("aria-disabled", "true"); }
  }
}

/* この地点をスケジュールに入れる（カード・特集タブ・マップのピンの「＋ スケジュールに追加」）。
   ★ルートに直接足すのではなく、唯一の正本であるスケジュールに行を足す。
     ルートはそこから自動で作られる。 */
function addPlaceToSchedule(id) {
  if (!requireSharedEditing()) return;
  const p = getPlaceById(id); if (!p) return;
  // 編集中ならその日、そうでなければ初日の末尾へ。どこに入るかを先に伝える
  const day = (schedEditing && schedEditing !== "all") ? schedEditing : FIRST_DAY;
  if (!window.confirm(`「${p.name}」をスケジュールに追加します。\n`
    + `${dayLabel(day)}の末尾に、時刻なしで入ります。\n\n同行者の画面にも反映されます。`)) return;
  insertSchedItem(schedItemFromName(p.name, day));
  renderMasterPlan();   // insertSchedItem は編集セクションしか描き直さない
}

/* =========================================================================
   天気（Open-Meteo, APIキー不要）
   ========================================================================= */
const WX_ICONS = { 0:"☀️",1:"🌤",2:"⛅",3:"☁️",45:"🌫",48:"🌫",51:"🌦",53:"🌦",55:"🌧",61:"🌧",63:"🌧",65:"🌧",71:"🌨",80:"🌦",81:"🌧",82:"⛈",95:"⛈",96:"⛈",99:"⛈" };
/* 天気を読み込み済みか。★成功したときだけ true にする。
   失敗しても true にすると、電波の無い場所で一度開いただけで
   「タブを開き直しても二度と再試行しない」状態になる（実際そうなっていた）。
   setupTabs() のローカルではなくここに置くのは、成功判定が loadWeather() の中にあるため。 */
let weatherLoaded = false;
async function loadWeather() {
  const wp = DATA.weatherPoint;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${wp.lat}&longitude=${wp.lon}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=7`;
  const box = $("#weather-content"), alert = $("#weather-alert");
  try {
    const r = await fetch(url);
    const d = await r.json();
    const dl = d.daily;
    const dows = ["日","月","火","水","木","金","土"];
    // ★4泊5日対応: 旅行期間中の日はすべて強調する（tripDate だけでなく DAY_KEYS 全部）
    const tripDays = (typeof DAY_KEYS !== "undefined") ? DAY_KEYS : [wp.tripDate];
    box.innerHTML = dl.time.map((iso, i) => {
      const dt = new Date(iso + "T00:00:00+09:00");
      const isTrip = tripDays.includes(iso);
      return `<div class="wx-day ${isTrip ? "is-trip" : ""}">
        <div class="wx-dow">${dows[dt.getDay()]}${isTrip ? " ★" : ""}</div>
        <div class="wx-date">${dt.getMonth()+1}/${dt.getDate()}</div>
        <div class="wx-icon">${WX_ICONS[dl.weather_code[i]] || "❔"}</div>
        <div class="wx-temp"><span class="hi">${Math.round(dl.temperature_2m_max[i])}°</span> / <span class="lo">${Math.round(dl.temperature_2m_min[i])}°</span></div>
        <div class="wx-pop">☔ ${dl.precipitation_probability_max[i] ?? "–"}%</div>
      </div>`;
    }).join("") + `<p class="wx-note muted">
      ☔ は <b>Open-Meteo</b>（欧米の数値予報モデル）の<b>1時間ごとの降水確率の最大値</b>です。
      気象庁・tenki.jp などの降水確率（<b>6時間区切りで1mm以上</b>）とは定義が違うため、<b>高めに出ます</b>。
      気温もモデルによって数℃変わります。<b>出発の判断は気象庁系の予報もあわせて</b>確認してください。
    </p>`;

    // 日付ラベルは weatherPoint.tripDate / DAY_KEYS から生成する（日付をハードコードしない）
    const fmt = iso => {
      const d = new Date(iso + "T00:00:00+09:00");
      return `${d.getMonth()+1}/${d.getDate()}（${dows[d.getDay()]}）`;
    };
    // その日の主目的に合わせた分岐文言。★中身は DATA.weatherAdvice にある（ここに直書きしない）
    const adviceFor = (iso, rain, hot) => {
      const plan = (DATA.weatherAdvice || {})[iso];
      if (!plan) return "";
      return mdBold(rain ? plan[2] : (hot ? plan[1] : plan[0]));
    };

    const rows = tripDays.map(iso => {
      const i = dl.time.indexOf(iso);
      if (i < 0) return null;
      const pop = dl.precipitation_probability_max[i];
      const wc = dl.weather_code[i];
      const hi = Math.round(dl.temperature_2m_max[i]);
      const rain = wc >= 51 || (pop ?? 0) >= 50;
      const hot = hi >= 33;
      return `<p class="wx-advice"><b>${fmt(iso)}:</b> ${WX_ICONS[wc] || ""} 最高${hi}° / 最低${Math.round(dl.temperature_2m_min[i])}° ・ 降水${pop ?? "–"}%。 ${adviceFor(iso, rain, hot)}</p>`;
    }).filter(Boolean);

    if (rows.length) {
      const anyBad = rows.some(r => r.includes("中止") || r.includes("短縮"));
      const missing = tripDays.filter(iso => dl.time.indexOf(iso) < 0);
      const note = missing.length
        ? `<p class="muted">${missing.map(fmt).join("・")}はまだ7日予報の範囲外です。出発が近づいたら、このページを開くだけで自動更新されます。</p>`
        : "";
      alert.innerHTML = `<div class="alert-box ${anyBad ? "" : "ok"}">
        <b>旅行期間（${esc(tripDateRange())}）の見込みと当日の動き方</b>
        ${rows.join("")}
        <p class="muted">予報は直前まで変わります。<b>各日の前夜と当日の朝に、雨雲・雷・最高気温を必ず再確認</b>してから屋外を実施するか決めてください。</p>
        ${note}
      </div>`;
    } else {
      alert.innerHTML = `<div class="alert-box ok">旅行期間（${esc(tripDateRange())}）はまだ7日予報の範囲外です。出発が近づいたら再確認を（このページを開くだけで自動更新されます）。</div>`;
    }
    weatherLoaded = true;          // ★ここまで来たときだけ。catch では立てない
  } catch (e) {
    // 文言と挙動を一致させる。フラグを立てないので、次にタブを開けば自動で再試行する
    box.innerHTML = `<p class="muted">天気情報を取得できませんでした（オフライン時など）。電波のある場所でこのタブを開き直すと、自動で再試行します。</p>`;
  }
}

/* =========================================================================
   タブ切替
   ========================================================================= */
function setupTabs() {
  $$("#tabs .tab").forEach(tab => {   // weatherLoaded は loadWeather() 側（成功時だけ立てる）
    tab.addEventListener("click", () => {
      rememberBrowseScroll(); cancelMapPinch(); endBrowseResize();
      Object.values(browseViews).forEach(v => { v.hover = null; v.focused = null; });
      focusPin(null); map?.closePopup();
      $$("#tabs .tab").forEach(t => t.classList.remove("active"));
      $$(".panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      const name = tab.dataset.tab;
      $("#panel-" + name).classList.add("active");
      // ★どのタブへ移っても地図の置き場所を決め直す。
      //   これを忘れると、編集モードに地図を貸したままマップタブへ行ったとき
      //   マップタブが空になる（syncMapDock() が唯一の判断者）。
      syncMapDock();
      if (name === "map") {
        ensureMap();
        setTimeout(revealMap, 60);
      }
      if (name === "weather" && !weatherLoaded) loadWeather();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

/* =========================================================================
   初期化
   ========================================================================= */
/* =========================================================================
   Firebase リアルタイム同期（スケジュール・確定状態・ルートを全員で共有）
   ・Firebase未接続でも localStorage で通常どおり動く（オフラインファースト）
   ・window.FB は index.html の module スクリプトが用意する
   ========================================================================= */
// Shared collections keep their existing wire format and version markers.
// Versions describe stored data; changing code defaults never resets a collection.
const SYNC_FIELDS = {
  schedule: { versionKey: "schedVersion", version: SCHED_VERSION, value: () => schedule, label: "スケジュール" },
  status: { versionKey: "statusVersion", version: STATUS_VERSION, value: statusToArray, label: "確定状態" },
  info: { versionKey: "infoVersion", version: INFO_VERSION, value: () => infoItems, label: "注意事項" },
  plans: { versionKey: "plansVersion", version: PLANS_VERSION, value: () => plans, label: "予備プラン" },
  want: { versionKey: "wantVersion", version: WANT_VERSION, value: wantToArray, label: "行きたい度" },
  note: { versionKey: "noteVersion", version: NOTE_VERSION, value: noteToArray, label: "メモ" }
};
const SYNC_PENDING_KEY = "ise-trip-sync-pending";
const SYNC_BASE_KEY = "ise-trip-sync-base";
const SYNC_ACCESS_KEY = "ise-trip-edit-user";
const SIGN_IN_MESSAGE = "編集するには初回だけGoogleでログインしてください。次回からはこのブラウザでログインが維持されます。";
let fbReady = false, applyingRemote = false, syncStarting = false, syncBusy = false;
let fbConnected = false, syncError = "", syncConflict = "", syncLatest = {};
let syncUserName = "";
let syncSession = 0, syncUnsubscribers = [], sharedAccessVerified = false;
let syncPending = readSyncStore(SYNC_PENDING_KEY), syncBases = readSyncStore(SYNC_BASE_KEY);
/* ★この公開版は「終わった旅行の記録」なので読み取り専用。
   共有編集の可否はもともと canEditShared() 一本に集まっているので、ここを閉じれば
   予定の並べ替え・★・メモ・注意タブの編集がすべて止まる（個別に消して回らない）。 */
/* ★既定は読み取り専用。公開版はこの値のまま動く。
   テストは共有・編集のコードを検査し続ける必要があるので、
   スクリプトを読み込む前に window.ITINERARY_READ_ONLY = false を置いた場合だけ外れる。
   「本番が読み取り専用であること」自体は tools/test_readonly.js が別に見る。 */
const READ_ONLY = !(typeof window !== "undefined" && window.ITINERARY_READ_ONLY === false);
function canEditShared() {
  if (READ_ONLY) return false;
  return window.ITINERARY_LOCAL_PREVIEW === true || (window.FB?.authenticated === true && sharedAccessVerified);
}
function sharedEditAttrs() { return `data-shared-edit aria-disabled="${!canEditShared()}"`; }
function requireSharedEditing() {
  if (canEditShared()) return true;
  if (READ_ONLY) { window.reportSyncError("この記録は読み取り専用です。当時の内容をそのまま残しています。"); return false; }
  if (!window.FB?.authenticated) window.reportSyncError(SIGN_IN_MESSAGE);
  else if (!syncError) window.reportSyncError("編集の準備中です。共有データへの接続を確認してからお試しください。");
  $("#sync-status")?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  const login = $("#auth-sign-in");
  if (login && !login.hidden) login.focus({ preventScroll: true });
  return false;
}
function updateSharedEditing() {
  const allowed = canEditShared();
  document.body.classList.toggle("shared-readonly", !allowed);
  if (!allowed) {
    endPinDrag();
    if (schedEditing) closeSchedEditor();
    if (infoEditing) { infoEditing = false; renderInfo(); }
  }
  $$("[data-shared-edit]").forEach(el => {
    el.setAttribute("aria-disabled", String(!allowed));
    if (el.matches("textarea")) el.readOnly = !allowed;
  });
}
function stopFirebaseSync() {
  syncSession++;
  syncUnsubscribers.splice(0).forEach(unsubscribe => unsubscribe());
  fbReady = false; fbConnected = false; syncStarting = false; syncBusy = false;
}
function revokeSharedEditing() {
  sharedAccessVerified = false;
  localStorage.removeItem(SYNC_ACCESS_KEY);
  updateSharedEditing();
}
window.handleFirebaseAuthChange = function () {
  stopFirebaseSync(); syncUserName = ""; syncError = "";
  sharedAccessVerified = !!window.FB?.uid && localStorage.getItem(SYNC_ACCESS_KEY) === window.FB.uid;
  updateSharedEditing();
  if (!window.FB?.authenticated) window.reportSyncError(SIGN_IN_MESSAGE);
  else renderSyncStatus();
};
function readSyncStore(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (err) { return {}; }
}
function syncClone(value) { return JSON.parse(JSON.stringify(value)); }
function syncEqual(a, b) {
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return JSON.stringify(stable(a ?? [])) === JSON.stringify(stable(b ?? []));
}
function persistSync() {
  localStorage.setItem(SYNC_PENDING_KEY, JSON.stringify(syncPending));
  localStorage.setItem(SYNC_BASE_KEY, JSON.stringify(syncBases));
}
function renderSyncStatus() {
  const box = $("#sync-status"); if (!box) return;
  const pending = Object.keys(syncPending).length;
  let message = "共有に接続中…", state = "connecting";
  if (syncError) {
    state = "error"; message = `${syncError}${pending ? " この端末に未送信の変更があります。" : ""}`;
  } else if (syncConflict) {
    state = "conflict";
    message = `共有側とこの端末の${SYNC_FIELDS[syncConflict].label}が異なります。この端末の変更は残っています。`;
  } else if (!navigator.onLine || (fbReady && !fbConnected)) {
    state = "offline"; message = pending ? "オフライン・変更はこの端末に保存されています" : "オフライン・この端末の保存内容を表示しています";
  } else if (pending || syncBusy) {
    state = "pending"; message = fbReady ? "共有へ送信中…" : "この端末に保存済み・共有への接続を待っています";
  } else if (fbReady) {
    state = "synced"; message = syncUserName ? `ようこそ${syncUserName}さん！` : "ようこそ！";
  }
  box.dataset.state = state;
  $("#sync-message").textContent = message;
  $("#sync-retry").hidden = !syncError || window.FB?.authenticated !== true;
  $("#sync-retry").disabled = syncStarting || syncBusy;
  $("#sync-use-local").hidden = !syncConflict;
  $("#sync-use-remote").hidden = !syncConflict;
}
window.reportSyncError = function (message) { syncError = message; renderSyncStatus(); };
function fbPush(key, value, defer = false) {
  if (READ_ONLY) return;   // 送る先が無い（index.html から Firebase を外してある）
  if (applyingRemote || !SYNC_FIELDS[key]) return;
  const previous = syncPending[key];
  syncPending[key] = {
    value: syncClone(value ?? []),
    base: previous ? previous.base : (syncBases[key] ?? null),
    known: previous ? previous.known : Object.hasOwn(syncBases, key)
  };
  persistSync(); renderSyncStatus();
  if (!defer) void flushSync();
}
async function flushSync() {
  if (!fbReady || !fbConnected || syncBusy || syncConflict || syncError || window.FB?.authenticated !== true) return;
  const session = syncSession;
  syncBusy = true; renderSyncStatus();
  try {
    for (const key of Object.keys(syncPending)) {
      if (!fbConnected) break;
      const entry = syncPending[key];
      const result = await window.FB.runTransaction(window.FB.ref(window.FB.db, "ise-trip/" + key), current => {
        if (session !== syncSession) return undefined;
        // Compare-and-set: concurrent edits are kept for the user to resolve.
        // A cache miss may conservatively produce a conflict, never a blind overwrite.
        if (syncEqual(current, entry.value) || (entry.known && syncEqual(current, entry.base))) return entry.value;
        return undefined;
      }, { applyLocally: false });
      if (session !== syncSession) return;
      if (!result.committed) {
        syncLatest[key] = result.snapshot.val() ?? [];
        syncConflict = key; break;
      }
      syncBases[key] = syncClone(entry.value);
      if (syncEqual(syncPending[key]?.value, entry.value)) delete syncPending[key];
      else if (syncPending[key]) {
        syncPending[key].base = syncClone(entry.value); syncPending[key].known = true;
      }
      persistSync();
    }
  } catch (err) {
    if (session !== syncSession) return;
    syncError = "共有へ送信できませんでした。通信とアクセス権を確認して再試行してください。";
    console.warn("Firebase sync failed:", err.code || err);
  } finally {
    if (session === syncSession) {
      syncBusy = false; renderSyncStatus();
      if (Object.keys(syncPending).length && !syncConflict && !syncError && fbConnected) void flushSync();
    }
  }
}
function receiveRemote(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    window.reportSyncError("共有データを読み取れませんでした。再試行してください。"); return false;
  }
  // Trip-specific names live in the protected database, never in public assets.
  const member = Array.isArray(d.members) ? d.members.find(item =>
    typeof item?.email === "string" && item.email.toLowerCase() === window.FB?.userEmail?.toLowerCase()) : null;
  syncUserName = typeof member?.name === "string" ? member.name.trim() : "";
  const incoming = {};
  for (const [key, field] of Object.entries(SYNC_FIELDS)) {
    const value = d[key] ?? (Object.hasOwn(d, field.versionKey) ? [] : null);
    if (value === null) continue;
    if (!Array.isArray(value) || value.some(x => !x || typeof x !== "object" || Array.isArray(x))) {
      window.reportSyncError("共有データの形式を確認できません。端末の内容を保持しています。"); return false;
    }
    incoming[key] = value;
  }
  syncLatest = syncClone(incoming);
  const applicable = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (syncPending[key]) continue;
    syncBases[key] = syncClone(value); applicable[key] = value;
  }
  applyRemote(applicable); persistSync(); renderSyncStatus();
  return true;
}
function restorePendingEdits() {
  const pending = {};
  for (const [key, entry] of Object.entries(syncPending)) {
    if (SYNC_FIELDS[key] && entry && Array.isArray(entry.value)) pending[key] = entry.value;
    else delete syncPending[key];
  }
  applyRemote(pending);
}
function setupSyncStatus() {
  // Capture before individual controls can change shared state. Reading, copying,
  // filters, maps and the device-only packing checklist remain available.
  for (const type of ["click", "beforeinput", "input", "change"]) {
    document.addEventListener(type, event => {
      if (canEditShared() || !event.target.closest?.("[data-shared-edit]")) return;
      if (type === "click" && event.target.matches("textarea[data-note]")) return; // Allow selecting/copying saved notes.
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.target.matches("textarea[data-note]")) event.target.value = getNote(event.target.dataset.note);
      requireSharedEditing();
    }, true);
  }
  $("#sync-retry").addEventListener("click", () => {
    syncError = "";
    if (fbReady) void flushSync(); else void window.startFirebaseSync();
    renderSyncStatus();
  });
  $("#sync-use-local").addEventListener("click", () => {
    if (!requireSharedEditing()) return;
    const key = syncConflict;
    if (!key || !confirm(`${SYNC_FIELDS[key].label}をこの端末の内容で共有しますか？別の端末の変更を上書きするため、同行者と確認してください。`)) return;
    syncPending[key].base = syncClone(syncLatest[key] ?? []); syncPending[key].known = true;
    syncConflict = ""; persistSync(); void flushSync();
  });
  $("#sync-use-remote").addEventListener("click", () => {
    if (!requireSharedEditing()) return;
    const key = syncConflict;
    if (!key || !confirm(`この端末の未送信の${SYNC_FIELDS[key].label}を取り消し、共有側の内容を使いますか？`)) return;
    delete syncPending[key]; syncConflict = "";
    syncBases[key] = syncClone(syncLatest[key] ?? []);
    applyRemote({ [key]: syncBases[key] }); persistSync(); renderSyncStatus(); void flushSync();
  });
  window.addEventListener("offline", renderSyncStatus);
  window.addEventListener("online", () => {
    renderSyncStatus(); if (!fbReady) void window.startFirebaseSync(); else void flushSync();
  });
  renderSyncStatus();
}
// Firebaseのキーは "." 等を使えないため、status は配列 [{id, s}] にして id を値側に持たせる
function statusToArray() { return Object.keys(statusMap).map(id => ({ id, s: getStatus(id) })); }
// リモート（DB）の変更をローカルへ反映
function applyRemote(d) {
  if (!d) return;
  applyingRemote = true;
  let changed = false;
  try {
  if (d.schedule && JSON.stringify(d.schedule) !== JSON.stringify(schedule)) {
    schedule = d.schedule; localStorage.setItem(SCHED_KEY, JSON.stringify({ v: SCHED_VERSION, items: schedule })); changed = true;
  }
  if (Array.isArray(d.status)) {
    const incoming = {};
    d.status.forEach(x => { if (x && x.id) incoming[x.id] = (x.s === "confirmed" ? "confirmed" : "tentative"); });
    // ★DBのstatusは「書き込まれた時点にあった地点」しか持たない。あとから地点を足すと
    //   そのidが欠けたまま届くので、丸ごと置き換えると新しい地点が statusMap から消える。
    //   DATA の category 由来の既定値に上書きする形で合成し、欠けた地点が
    //   （category が confirmed でも）未確定に落ちるのを防ぐ。
    const merged = { ...baseStatusMap(), ...incoming };
    if (JSON.stringify(merged) !== JSON.stringify(statusMap)) {
      statusMap = merged; localStorage.setItem(STATUS_KEY, JSON.stringify({ v: STATUS_VERSION, map: statusMap })); changed = true;
    }
  }
  // ★route は同期しない。スケジュールから作る導出値なので、受信側で作り直す（rerenderAll の先頭）
  if (Array.isArray(d.info) && JSON.stringify(d.info) !== JSON.stringify(infoItems)) {
    infoItems = d.info; localStorage.setItem(INFO_KEY, JSON.stringify({ v: INFO_VERSION, items: infoItems })); changed = true;
  }
  if (Array.isArray(d.plans) && JSON.stringify(d.plans) !== JSON.stringify(plans)) {
    plans = d.plans; localStorage.setItem(PLANS_KEY, JSON.stringify({ v: PLANS_VERSION, items: plans })); changed = true;
  }
  /* 行きたい度とメモ。★カード全体を作り直さず、その部分だけ書き換える。
     同行者が★を付けるたびに再描画すると、こちらが入力中のメモのカーソルが飛ぶ。 */
  if (Array.isArray(d.want)) {
    const inc = {}; d.want.forEach(x => { if (x && x.id) inc[x.id] = x.n; });
    if (JSON.stringify(inc) !== JSON.stringify(wantMap)) {
      wantMap = inc; localStorage.setItem(WANT_KEY, JSON.stringify({ v: WANT_VERSION, map: wantMap }));
      refreshWantRows();
      /* ★ピンの★表示（pinlabel列）もここで描き直す。この分岐は上のとおり changed を立てない
         ので rerenderAll() が走らず、これが無いと「同行者が付けた★が自分の地図に出ない」
         状態になる。自分で★を付けたときは出るので気づけない（0-2）。
         refreshMarkers() はマーカーの絵だけを作り直すので、メモ入力中のカーソルには触らない。 */
      if (typeof map !== "undefined" && map) refreshMarkers();
    }
  }
  if (Array.isArray(d.note)) {
    const inc = {}; d.note.forEach(x => { if (x && x.id) inc[x.id] = x.t; });
    if (JSON.stringify(inc) !== JSON.stringify(noteMap)) {
      noteMap = inc; localStorage.setItem(NOTE_KEY, JSON.stringify({ v: NOTE_VERSION, map: noteMap }));
      refreshNotes();
    }
  }
  } finally { applyingRemote = false; }
  if (changed) rerenderAll();
}
// status/並び順/ルートに依存する全ビューを再描画
function rerenderAll() {
  /* ★ルートを作り直す。これが無いと「同行者がスケジュールを編集しても、
     こちらの地図のピン順が古いまま」になる。
     以前は route も Firebase で送られてきたので揃っていたが、同期をやめたぶん
     受信側で作り直す必要がある。自分の端末では正常に見えるので気づけない。 */
  routeIds = routeFromSchedule();
  renderAllCards();
  if ($("#info-content")) renderInfo();
  // renderSchedule() が本命・編集セクション・予備プランをまとめて描き直す。
  // ★編集中に他端末の変更が届いても、編集セクションは作り直さない
  //   （入力中のカーソルとIME変換が飛ぶため）。本命と予備だけ更新する。
  if ($("#master-plan")) {
    renderMasterPlan();
    renderBackupPlans();
    if (schedEditing) { renderSchedDayTabs(); renderScheduleEditor(); }
    else renderSchedule();
  }
  if ($("#route-list")) renderRouteEditor();
  if (typeof map !== "undefined" && map) { refreshMarkers(); drawRouteLine(); applyFilters(); }
}
// 認証完了後に module から呼ばれる
window.startFirebaseSync = async function () {
  if (!window.FB || window.FB.authenticated !== true || fbReady || syncStarting) return;
  stopFirebaseSync();
  const session = syncSession;
  const current = () => session === syncSession && window.FB.authenticated === true;
  const track = unsubscribe => { if (current()) syncUnsubscribers.push(unsubscribe); else unsubscribe(); };
  const fail = (message, accessDenied = false) => {
    if (!current()) return;
    stopFirebaseSync();
    if (accessDenied) revokeSharedEditing();
    window.reportSyncError(message);
  };
  syncStarting = true; syncError = ""; renderSyncStatus();
  try {
    const tripRef = window.FB.ref(window.FB.db, "ise-trip");
    const d = (await window.FB.get(tripRef)).val() || {};
    if (!current()) return;
    // Only a never-created collection receives defaults. A missing value with a
    // version marker means the user cleared the list (RTDB stores [] as null).
    for (const [key, field] of Object.entries(SYNC_FIELDS)) {
      if (d[key] == null && !Object.hasOwn(d, field.versionKey)) {
        await window.FB.runTransaction(window.FB.ref(window.FB.db, "ise-trip/" + key),
          value => current() && value == null ? syncClone(field.value()) : undefined, { applyLocally: false });
        if (!current()) return;
      }
      if (!Object.hasOwn(d, field.versionKey)) {
        await window.FB.runTransaction(window.FB.ref(window.FB.db, "ise-trip/" + field.versionKey),
          value => current() && value == null ? field.version : undefined, { applyLocally: false });
        if (!current()) return;
      }
    }
    track(window.FB.onValue(window.FB.ref(window.FB.db, ".info/connected"), snapshot => {
      if (!current()) return;
      fbConnected = snapshot.val() === true; renderSyncStatus();
      if (fbConnected) void flushSync();
    }));
    // A successful get alone is not enough: retry must attach a new live listener
    // and receive a valid snapshot before reporting successful synchronization.
    track(window.FB.onValue(tripRef, snapshot => {
      if (!current()) return;
      if (!receiveRemote(snapshot.val() || {})) { stopFirebaseSync(); renderSyncStatus(); return; }
      syncError = ""; fbReady = true; syncStarting = false;
      sharedAccessVerified = true;
      if (window.FB.uid) localStorage.setItem(SYNC_ACCESS_KEY, window.FB.uid);
      updateSharedEditing(); renderSyncStatus(); void flushSync();
    }, () => fail("共有の読み取りが停止しました。アクセス権を確認して再試行してください。", true)));
  } catch (err) {
    const denied = /permission.?denied/i.test(err.code || err.message || "");
    fail(denied
      ? "このGoogleアカウントには共有データのアクセス権がありません。登録したアカウントでログインしてください。"
      : "共有に接続できませんでした。通信とアクセス権を確認して再試行してください。", denied);
    console.warn("Firebase sync start failed:", err.code || err);
  }
};

window.clearSharedCache = function () {
  [SCHED_KEY, STATUS_KEY, INFO_KEY, PLANS_KEY, WANT_KEY, NOTE_KEY,
   SYNC_PENDING_KEY, SYNC_BASE_KEY, SYNC_ACCESS_KEY, "ise-trip-user"].forEach(key => localStorage.removeItem(key));
};
function init() {
  setupSyncStatus();
  // ★日帰り（TRIP_DAYS が1件）のときは、日サブタブと日付見出しを CSS で畳む。
  //   DOM も配線も残すので tools/test_days.js はそのまま通り、
  //   複数日の旅行では TRIP_DAYS に行を足すだけで復活する（追補K・T）。
  //   マップの「日」列は MAP_FILTER_COLUMNS 側で落としている。
  document.body.classList.toggle("day-single", TRIP_DAYS.length === 1);
  // ★最初に呼ぶ。setupMap() はマップタブを開くまで走らないが、下の renderRouteEditor() が
  //   currentFilters() 経由でルート列の .checked を読むため、ここで無いとページ全体が落ちる。
  renderMapFilters();
  setupBrowse();
  // ★スケジュールタブは「本命プラン（読む）＋ 予備プラン」。編集セクションは
  //   renderSchedule() の中で schedEditing を見て作られる（既定は作られない＝誤タップ防止）
  renderSchedule();
  renderAllCards();   // スポット＋（絞り込み・並び替え付きの）レストラン／カフェ
  renderRoutes();
  renderPacking();
  renderInfo();
  renderFeature();   // 特集（読み物。FEATURE_TABS のぶんだけ描く）
  renderTickets();   // チケット・予約（添付は開いたときに読み込む）
  syncRouteFromSchedule();   // スケジュールの地点順を初期ルートに反映（片方向連動）
  renderRouteEditor();
  setupLightbox();
  setupTabs();
  restorePendingEdits();

  // カード・特集タブの「＋ スケジュールに追加」（ルートではなくスケジュールに足す）
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-add-sched]");
    if (b) addPlaceToSchedule(b.dataset.addSched);
  });

  // 確定／未確定バッジ（カード・スケジュール共通）: どこで押しても全タブに反映
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-status-toggle]");
    if (t) toggleStatus(t.dataset.statusToggle);
  });

  // 予定行の地点チップ → その地点のカードへ移動。本命プランと予備プランで共通なので委任で拾う
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-goto-ref]");
    if (a) { e.preventDefault(); gotoRefCard(a.dataset.gotoRef); }
  });
  // 比較表の行はキーボードでも押せるようにする（role=button の <tr> は Enter で click が出ない）
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const a = e.target.closest && e.target.closest("tr[data-goto-ref]");
    if (a) { e.preventDefault(); gotoRefCard(a.dataset.gotoRef); }
  });

  // 🎫 チップ・ピル → チケットタブのそのカードへ移動
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-goto-ticket]");
    if (a) { e.preventDefault(); gotoTicket(a.dataset.gotoTicket); }
  });

  // ★行きたい度。押した行だけ描き直す（カードを作り直さないのでメモ欄が閉じない）
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-want-set]");
    if (!b) return;
    const [id, n] = b.dataset.wantSet.split("|");
    setWant(id, n);
  });
  // メモ。★入力のたびに再描画しない（IMEの変換とカーソルが飛ぶ）
  document.addEventListener("input", (e) => {
    const t = e.target.closest("textarea[data-note]");
    if (t) setNoteDebounced(t.dataset.note, t.value);
  });
  // メモ欄の開閉を控える（再描画で閉じないように。保存も同期もしない）
  document.addEventListener("toggle", (e) => {
    const d = e.target.closest && e.target.closest(".note-box");
    const t = d && d.querySelector("textarea[data-note]");
    if (t) cardNoteOpen[t.dataset.note] = d.open;
  }, true);

  // 注意タブの編集モード（誤タップ防止：既定は閲覧モード）
  $("#info-edit-toggle").addEventListener("click", () => { infoEditing = !infoEditing; renderInfo(); });
  $("#info-add").addEventListener("click", () => {
    infoItems.push({ warn: false, title: "", text: "" });
    saveInfo(); infoEditing = true; renderInfo();
    const last = $$("#info-content .info-title").pop(); if (last) last.focus();
  });
  $("#info-reset").addEventListener("click", () => {
    if (!confirm("注意タブを初期状態に戻しますか？（同行者の端末にも反映されます）")) return;
    infoItems = INFO_DEFAULT.map(x => ({ ...x })); saveInfo(); renderInfo();
  });
  $("#info-export").addEventListener("click", exportInfo);
  updateSharedEditing();
  window.itineraryReady = true;
  window.dispatchEvent(new Event("itinerary-ready"));
}

/* ============================================================
   合言葉の扉（暗号化された本体を開く）
   公開されているのは AES-256-GCM の暗号文だけで、平文は build/plain 側にしかない。
   詳しい設計は「暗号化＋合言葉スキーム_引き継ぎ.md」を参照。
   ============================================================ */
const IDB_NAME = "ise-trip-key";
let keysJson = null;      // enc/keys.json
let subkeys = null;       // { kEnc, kId }
let manifest = null;      // 復号した本体
let started = false;

/* 復号済みの画像を Blob URL で持っておく。合計 28MB を超えたら古い順に捨てる。
   ★無制限にしない（この旅行の画像は合計66MBある）。捨てるときは src も外して、
     次に見えたときに復号し直させる（§5-2）。 */
const imgCache = new Map();
const inflight = new Map();
let imgBytes = 0;
const IMG_BUDGET = 28 * 1024 * 1024;
function cacheImage(path, url, size) {
  imgCache.set(path, { url, size });
  imgBytes += size;
  while (imgBytes > IMG_BUDGET && imgCache.size > 1) {
    const [oldPath, v] = imgCache.entries().next().value;
    if (oldPath === path) break;
    imgCache.delete(oldPath);
    imgBytes -= v.size;
    try { URL.revokeObjectURL(v.url); } catch (e) { /* 解放できなくても続ける */ }
    const sel = (window.CSS && CSS.escape) ? CSS.escape(oldPath) : oldPath;
    $$(`img[data-enc="${sel}"]`).forEach(el => el.removeAttribute("src"));
  }
}
async function decryptImage(path) {
  const f = manifest && manifest.files && manifest.files[path];
  if (!f || !subkeys) return "";
  const res = await fetch(`enc/b/${f.n}.bin?h=${f.h}`, { cache: "force-cache" });
  if (!res.ok) throw new Error("画像を取得できません");
  const plain = await GC.open(subkeys.kEnc, new Uint8Array(await res.arrayBuffer()), path);
  const url = URL.createObjectURL(new Blob([plain], { type: f.t || "application/octet-stream" }));
  cacheImage(path, url, plain.length);
  return url;
}
function installImageResolver() {
  imageSrc = path => (imgCache.get(path) || {}).url || "";
  requestImage = (path, el, done) => {
    const hit = imgCache.get(path);
    if (hit) { if (el) el.src = hit.url; if (done) done(hit.url); return; }
    let job = inflight.get(path);
    if (!job) {
      job = decryptImage(path).catch(() => "").finally(() => inflight.delete(path));
      inflight.set(path, job);
    }
    job.then(url => {
      if (url && el && el.isConnected) el.src = url;
      if (done) done(url);
    });
  };
}

/* 端末の記憶：合言葉も鍵のバイト列も保存せず、「復号だけできる鍵」を置く（§5-3） */
function idbRun(mode, fn) {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) return reject(new Error("no idb"));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("k"); };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("k", mode);
      const r = fn(tx.objectStore("k"));
      tx.oncomplete = () => resolve(r && r.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
async function rememberKey(k) {
  try {
    const key = await crypto.subtle.importKey("raw", k, "AES-GCM", false, ["decrypt"]);   // 取り出し不可
    await idbRun("readwrite", st => st.put({ key, v: 1 }, "content"));
    return true;
  } catch (e) { return false; }
}
async function rememberedKey() {
  try { const rec = await idbRun("readonly", st => st.get("content")); return rec && rec.key ? rec.key : null; }
  catch (e) { return null; }
}
function forgetKey() {
  try { indexedDB.deleteDatabase(IDB_NAME); } catch (e) { /* 消せなくても続ける */ }
  location.reload();
}

function gateMessage(text, kind) {
  if (typeof document === "undefined" || !document.body) return;   // 閉じたページで呼ばれても落ちない
  const el = $("#gate-msg"); if (!el) return;
  el.textContent = text || "";
  el.className = "gate-msg" + (kind ? " " + kind : "");
}
/* 鍵（生バイト or CryptoKey）で本体を開く。
   ★deriveSubkeys は生の32バイトしか受け取らない。端末に記憶した CryptoKey と混ぜないこと。
     instanceof Uint8Array はレルムをまたぐと false になるので使わない（§10-1）。 */
async function openContent(k) {
  if (started) return true;
  subkeys = ArrayBuffer.isView(k) ? await GC.deriveSubkeys(k) : { kEnc: k, kId: null };
  const res = await fetch(`enc/m.bin?h=${(keysJson && keysJson.manifest && keysJson.manifest.h) || ""}`, { cache: "force-cache" });
  if (!res.ok) throw new Error("本体を取得できません");
  const plain = await GC.open(subkeys.kEnc, new Uint8Array(await res.arrayBuffer()), "manifest");
  manifest = JSON.parse(new TextDecoder().decode(plain));
  installImageResolver();
  start(manifest);
  return true;
}

let passBusy = false;
let failCount = 0;
async function unlockWithPass(pass, remember) {
  if (passBusy || !keysJson) return false;
  passBusy = true;
  gateMessage("鍵を作っています…");
  try {
    const k = await GC.unwrapK(keysJson, pass);
    if (!k) {
      // 失敗のたびに待ち時間を伸ばす。★気休めであり、強度は合言葉の長さで決まる（§1-3・§5-4）
      failCount++;
      const wait = Math.min(30000, 500 * Math.pow(2, failCount - 1));
      gateMessage("合言葉が違います", "error");
      await new Promise(r => setTimeout(r, wait));
      return false;
    }
    failCount = 0;
    if (remember) {
      const ok = await rememberKey(k);
      if (!ok) gateMessage("この端末では記憶できませんでした（今回だけ開きます）");
    }
    await openContent(k);
    return true;
  } catch (e) {
    gateMessage("開けませんでした。通信状態を確認して、もう一度お試しください。", "error");
    return false;
  } finally { passBusy = false; }
}

/* 解錠後の初期化。テストもここを通す（本番と同じ入口）。
   ★配列は作り直さず中身を入れ替える。FILTER_GROUPS などが読み込み時に
     この配列を掴んでいるため、代入し直すと参照が古いままになる。 */
function start(payload, opts) {
  if (started) return;
  DATA = payload.data;
  const fill = (arr, v) => { arr.length = 0; (v || []).forEach(x => arr.push(x)); };
  fill(GENRE_GROUPS, DATA.genreGroups);
  fill(SPOT_GROUPS, DATA.spotGroups);
  fill(AREA_GROUPS, DATA.areaGroups);
  fill(TRIP_DAYS, DATA.tripDays);
  fill(DAY_KEYS, (DATA.tripDays || []).map(d => d.key));
  fill(SCHED_DEFAULT, (DATA.frozen && DATA.frozen.schedule) || DATA.schedDefault);
  fill(PLANS_DEFAULT, (DATA.frozen && DATA.frozen.plans) || DATA.plansDefault);
  WALK_CENTER = DATA.walkCenter || "";
  FIRST_DAY = DAY_KEYS[0] || "";
  // 旅行中に記録された最終状態を「全員に配る初期値」にする（読み取り専用なので、これが既定）
  const frozen = DATA.frozen || {};
  Object.assign(STATUS_DEFAULT, frozen.status || {});
  INFO_DEFAULT = frozen.info || DATA.info || [];
  COPY = payload.copy || {};
  if (opts && opts.imageSrc) {
    imageSrc = opts.imageSrc;
    requestImage = (p, el, done) => { const u = opts.imageSrc(p); if (el) el.src = u; if (done) done(u); };
  }
  // データに触る初期化は、ここまで来てから行う
  statusMap = loadStatusMap();
  wantMap = Object.assign({}, frozen.want || {}, loadKeyedMap(WANT_KEY, WANT_VERSION));
  noteMap = Object.assign({}, frozen.note || {}, loadKeyedMap(NOTE_KEY, NOTE_VERSION));
  plans = loadPlans();
  schedule = loadSchedule();
  routeIds = routeFromSchedule();
  infoItems = loadInfo();
  started = true;
  applyCopy();
  init();
  watchForImages();
  hydrateImages();
  const gate = $("#gate");
  if (gate) gate.hidden = true;
  document.body.classList.remove("locked");
}

/* 画面の文言は暗号化した本体から入れる。index.html には固有名詞を置かない（§6） */
function applyCopy() {
  const c = COPY || {};
  if (c.title) document.title = c.title;
  for (const [sel, html] of Object.entries(c.html || {})) {
    const el = document.querySelector(sel);
    if (el) el.innerHTML = html;
  }
  for (const [sel, text] of Object.entries(c.text || {})) {
    const el = document.querySelector(sel);
    if (el) el.textContent = text;
  }
}

async function boot() {
  if (typeof fetch !== "function" || typeof GC === "undefined") return;   // テストは start() を直接呼ぶ
  try {
    const res = await fetch("enc/keys.json", { cache: "no-cache" });
    keysJson = await res.json();
  } catch (e) { gateMessage("接続できませんでした。通信状態を確認して再読み込みしてください。", "error"); return; }
  const remembered = await rememberedKey();
  if (remembered) { try { await openContent(remembered); return; } catch (e) { forgetKey(); return; } }
  const form = $("#gate-form");
  if (form) {
    form.hidden = false;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("#gate-submit");
      if (btn) btn.disabled = true;
      await unlockWithPass($("#gate-pass").value, $("#gate-remember").checked);
      if (btn) btn.disabled = false;
    });
  }
  const forget = $("#forget-device");
  if (forget) forget.addEventListener("click", forgetKey);
}

window.Trip = { start, unlockWithPass, forgetKey, hydrateImages,
  state: () => ({ started, hasKeys: !!keysJson, cached: imgCache.size }) };
if (typeof document !== "undefined" && document.getElementById("gate")) boot();
