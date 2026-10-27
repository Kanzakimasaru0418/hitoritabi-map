// =====================================================
// app.js … 画面の動き
// =====================================================
// 流れ：
//  1. 地図・出発駅のリスト・ジャンルのボタンを作る
//  2. 条件が変わるたびに render() で「行ける駅」と地図を描き直す
//  3. 「この条件でプランを作る」で findPlans() → 1番目の案を表示
//  4. 「別の案にする（再生成）」で次の案を表示（条件が変わっていたら作りなおす）

// ----- 画面の部品 -----
const startSelect = document.getElementById("startSelect");
const budgetNumber = document.getElementById("budgetNumber");
const budgetRange = document.getElementById("budgetRange");
const useExpressBox = document.getElementById("useExpress");
const departTime = document.getElementById("departTime");
const backTime = document.getElementById("backTime");
const backLabel = document.getElementById("backLabel");
const timeNote = document.getElementById("timeNote");
const genreList = document.getElementById("genreList");
const keywordInput = document.getElementById("keyword");
const generateButton = document.getElementById("generateButton");
const staleNote = document.getElementById("staleNote");
const planSection = document.getElementById("planSection");
const planCount = document.getElementById("planCount");
const planBody = document.getElementById("planBody");
const nextPlanButton = document.getElementById("nextPlanButton");
const closePlanButton = document.getElementById("closePlan");
const summary = document.getElementById("summary");
const resultList = document.getElementById("resultList");

// ----- 今のプランの状態 -----
let plans = [];        // 作った案の一覧
let planIndex = 0;     // 今表示している案の番号
let planKey = null;    // プランを作ったときの条件（変わったか調べるため）
let isSinglePlan = false; // 「この駅だけ」のプランか

const COLORS = {
  shu: "#c8442b",
  ok: "#2f7d5b",
  ng: "#a8a29a",
  ink: "#1f2a36",
};
const LINE_COLORS = { JR: "#2b6cb0", "大阪メトロ": "#6b4fa0", "近鉄": "#c0392b", "阪堺電車": "#2f7d5b" };

// 数字を「3,000」のように区切る
function yen(n) {
  return n.toLocaleString("ja-JP");
}
// 分を「1時間25分」にする
function duration(min) {
  const m = Math.round(min);
  if (m < 60) return `${m}分`;
  return `${Math.floor(m / 60)}時間${m % 60 > 0 ? (m % 60) + "分" : ""}`;
}

// =====================================================
// 1. 地図・リスト・ボタンを作る
// =====================================================
const map = L.map("map", { zoomControl: true }).setView([34.68, 135.6], 9);

L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
}).addTo(map);

// 路線をうすく描く（どこに線路があるかわかるように。新幹線・特急は点線）
const lineLayer = L.layerGroup().addTo(map);
for (const line of LINES) {
  const points = line.stations.map(([name]) => [NODE[name].lat, NODE[name].lng]);
  L.polyline(points, {
    color: LINE_COLORS[line.op] || "#888",
    weight: line.express ? 3 : 2,
    opacity: line.express ? 0.3 : 0.35,
    dashArray: line.express ? "6 6" : null,
  }).addTo(lineLayer);
}

const stationLayer = L.layerGroup().addTo(map);
const spotLayer = L.layerGroup().addTo(map);
const planLayer = L.layerGroup().addTo(map);

// 広い範囲を見ているときは、運賃ラベルが重なるので隠す
function updateLabelVisibility() {
  map.getContainer().classList.toggle("is-zoomed-out", map.getZoom() < 11);
}
map.on("zoomend", updateLabelVisibility);
updateLabelVisibility();

// 出発駅のリスト（エリアごとにまとめる）
const areas = [...new Set(NODES.map((n) => n.area))];
for (const area of areas) {
  const group = document.createElement("optgroup");
  group.label = area;
  for (const node of NODES.filter((n) => n.area === area)) {
    const option = document.createElement("option");
    option.value = node.name;
    option.textContent = node.name;
    group.appendChild(option);
  }
  startSelect.appendChild(group);
}
startSelect.value = "天王寺";

// ジャンルのボタン
for (const genre of GENRES) {
  const label = document.createElement("label");
  label.className = "chip";
  label.innerHTML = `<input type="checkbox" value="${genre}"><span>${genre}</span>`;
  genreList.appendChild(label);
}

// =====================================================
// 条件を読み取る
// =====================================================
function getConditions() {
  const genres = [...genreList.querySelectorAll("input:checked")].map((box) => box.value);
  const keywords = keywordInput.value.split(/[\s　]+/).filter((w) => w !== "");
  return {
    start: startSelect.value,
    budget: Number(budgetNumber.value) || 0,
    tripType: document.querySelector('input[name="tripType"]:checked').value,
    useExpress: useExpressBox.checked,
    depart: toMinutes(departTime.value || "09:00"),
    back: toMinutes(backTime.value || "18:00"),
    genres: genres,
    keywords: keywords,
  };
}

// 条件を1つの文字にする（前と同じ条件か比べるため）
function conditionKey(cond) {
  return JSON.stringify(cond);
}

// その駅に、条件の中で日帰りで行けるか
function checkStation(name, cond) {
  const go = getLeg(cond.start, name, cond.useExpress);
  if (!go) return null;
  const back = cond.tripType === "round" ? getLeg(name, cond.start, cond.useExpress) : { fare: 0, minutes: 0 };
  if (!back) return null;
  const info = stopInfo(name, cond);
  const fare = go.fare + back.fare;
  const minutes = go.minutes + back.minutes;
  const okFare = fare <= cond.budget;
  const okTime = info.spots.length > 0 && minutes + info.min + lunchMinutes(cond) <= cond.back - cond.depart;
  return { go: go, fare: fare, minutes: minutes, info: info, ok: okFare && okTime, okFare: okFare };
}

// =====================================================
// 2. 「行ける駅」と地図を描き直す
// =====================================================
const spotStations = new Set(SPOTS.map((s) => s.station));

function render() {
  const cond = getConditions();
  const isRound = cond.tripType === "round";
  backLabel.textContent = isRound ? "出発駅にもどる" : "観光を終える";

  // 時間のチェック
  const timeOk = cond.back > cond.depart + 60;
  timeNote.textContent = timeOk
    ? `使える時間は ${duration(cond.back - cond.depart)} です`
    : "もどる時刻は、出発より1時間以上あとにしてください";
  timeNote.classList.toggle("is-error", !timeOk);
  generateButton.disabled = !timeOk;

  stationLayer.clearLayers();
  spotLayer.clearLayers();
  resultList.innerHTML = "";

  const reachable = [];

  for (const name of spotStations) {
    if (name === cond.start) continue;
    const check = checkStation(name, cond);
    if (!check) continue;
    const node = NODE[name];
    const fareText = isRound ? `往復${yen(check.fare)}円` : `${yen(check.fare)}円`;

    const circle = L.circleMarker([node.lat, node.lng], {
      radius: check.ok ? 8 : 4,
      color: "#fff",
      weight: 2,
      fillColor: check.ok ? COLORS.ok : COLORS.ng,
      fillOpacity: check.ok ? 0.95 : 0.6,
    }).addTo(stationLayer);

    circle.bindPopup(stationPopupHtml(name, check, cond));

    if (check.ok) {
      circle.bindTooltip(`${name} ${fareText}`, {
        permanent: true, direction: "right", offset: [8, 0], className: "fare-label",
      });
      reachable.push({ name: name, check: check });

      for (const spot of check.info.spots) {
        L.circleMarker([spot.lat, spot.lng], {
          radius: 4, color: "#fff", weight: 1, fillColor: COLORS.shu, fillOpacity: 0.85,
        })
          .bindPopup(`<b>${spot.name}</b><br>${spot.genres.join("・")}<br>${spot.desc}`)
          .addTo(spotLayer);
      }
    }
  }

  // 出発駅
  const startNode = NODE[cond.start];
  L.marker([startNode.lat, startNode.lng], {
    icon: L.divIcon({ className: "", html: `<div class="start-pin">発</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
    zIndexOffset: 1000,
  })
    .bindPopup(`<b>出発駅：${cond.start}</b>`)
    .addTo(stationLayer);

  // --- リスト（予算を多く使える順） ---
  reachable.sort((a, b) => b.check.fare - a.check.fare);
  const budgetText = isRound ? `往復${yen(cond.budget)}円` : `片道${yen(cond.budget)}円`;
  if (reachable.length === 0) {
    summary.textContent = `${cond.start}から${budgetText}で行ける、条件に合う駅は見つかりませんでした。`;
    resultList.innerHTML = `<p class="empty">予算や時間を増やすか、ジャンルを変えてみてください。</p>`;
  } else {
    summary.textContent = `${cond.start}から${budgetText}で ${reachable.length} 駅に行けます（予算を多く使える順）。`;
  }
  for (const item of reachable) {
    resultList.appendChild(makeResultCard(item.name, item.check, cond));
  }

  updateStale();
}

// 駅をタップしたときの吹き出し
function stationPopupHtml(name, check, cond) {
  const routeText = check.go.rides.map(describeRide).join("<br>");
  const reason = check.ok ? "" : !check.okFare ? "<br><span class='ng'>予算オーバー</span>" : "<br><span class='ng'>時間が足りないか、条件に合うスポットなし</span>";
  return `
    <div class="popup">
      <b>${name}</b>（${NODE[name].area}）<br>
      ${cond.start}から 片道${yen(check.go.fare)}円・約${duration(check.go.minutes)}${reason}
      <div class="popup-route">${routeText}</div>
      <button type="button" class="popup-start" data-start="${name}">ここから出発する</button>
    </div>`;
}

// 「行ける駅」のカード1枚
function makeResultCard(name, check, cond) {
  const card = document.createElement("article");
  card.className = "result-card";

  const fareText = cond.tripType === "round" ? `往復 ${yen(check.fare)}円` : `片道 ${yen(check.fare)}円`;
  const lines = [...new Set(check.go.rides.flatMap((r) => r.lines))].filter((l) => l !== "徒歩").join("・");
  const tags = check.info.spots.map((s) => `<span class="spot-tag">${s.name}</span>`).join("");

  card.innerHTML = `
    <div class="result-top">
      <p class="result-name">${name}<span class="result-area">${NODE[name].area}</span></p>
      <span class="result-fare">${fareText}</span>
    </div>
    <p class="result-meta">片道 約${duration(check.go.minutes)}・${lines}</p>
    <div class="spot-tags">${tags}</div>
    <button type="button" class="button button-small">この駅だけでプランを作る</button>
  `;
  card.querySelector("button").addEventListener("click", () => {
    const cond2 = getConditions();
    const plan = makeSingleStopPlan(name, cond2);
    if (!plan) return;
    plans = [plan];
    planIndex = 0;
    planKey = conditionKey(cond2);
    isSinglePlan = true;
    showPlan();
  });
  return card;
}

// =====================================================
// 3. プランを作る・表示する
// =====================================================
function generatePlans() {
  const cond = getConditions();
  generateButton.disabled = true;
  generateButton.textContent = "考え中…";

  // 「考え中…」を表示してから計算するため、少しだけ待つ
  setTimeout(() => {
    plans = findPlans(cond);
    planIndex = 0;
    planKey = conditionKey(cond);
    isSinglePlan = false;
    generateButton.disabled = false;
    showPlan();
  }, 30);
}

function showPlan() {
  const cond = JSON.parse(planKey);
  planSection.hidden = false;
  planLayer.clearLayers();

  if (plans.length === 0) {
    planCount.textContent = "";
    planBody.innerHTML = `<p class="empty">この条件で回れるプランが見つかりませんでした。<br>予算や時間を増やすか、ジャンルを変えてみてください。</p>`;
    nextPlanButton.hidden = true;
    updateStale();
    planSection.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const plan = plans[planIndex];
  const timeline = buildTimeline(plan, cond);

  planCount.textContent = isSinglePlan ? "（この駅だけ）" : `案 ${planIndex + 1} / ${plans.length}`;
  nextPlanButton.hidden = false;
  nextPlanButton.textContent = isSinglePlan ? "おまかせでプランを作る" : "別の案にする（再生成）";

  // --- ルートの流れ ---
  const routeNames = [cond.start, ...plan.stops];
  if (cond.tripType === "round") routeNames.push(cond.start);
  const routeHtml = routeNames
    .map((n, i) => `<span class="route-stop ${i === 0 || (cond.tripType === "round" && i === routeNames.length - 1) ? "is-home" : ""}">${n}</span>`)
    .join(`<span class="route-arrow">→</span>`);

  // --- 予算メーター ---
  const usage = Math.min(100, Math.round(plan.usage * 100));
  const left = cond.budget - plan.fare;
  const spotCount = timeline.visited.length;

  // --- 時間割 ---
  let listHtml = "";
  for (const step of timeline.steps) {
    let ridesHtml = "";
    if (step.rides) {
      ridesHtml = `<ul class="rides">${step.rides.map((r) => `<li>${describeRide(r)}</li>`).join("")}</ul>`;
    }
    listHtml += `
      <li class="step-row type-${step.type}">
        <span class="time">${toClock(step.time)}</span>
        <div class="step">
          <p class="step-title">${step.title}</p>
          ${step.desc ? `<p class="step-desc">${step.desc}</p>` : ""}
          ${ridesHtml}
        </div>
      </li>`;
  }

  // --- お知らせ ---
  let notes = "";
  if (timeline.spare < 0) {
    notes += `<p class="plan-warning">予定より約${-timeline.spare}分おそくなりそうです。スポットを減らすか、時間を見直してください。</p>`;
  } else if (timeline.spare >= 20) {
    notes += `<p class="plan-info">時間に約${duration(timeline.spare)}の余裕があります。のんびりしたり、寄り道したりできます。</p>`;
  }
  if (timeline.skipped.length > 0) {
    notes += `<p class="plan-info">時間の都合で入れなかった場所：${timeline.skipped.map((s) => s.name).join("、")}</p>`;
  }
  if (!isSinglePlan && plan.usage < 0.7) {
    notes += `<p class="plan-info">時間や条件の関係で、予算を使い切れるプランは見つかりませんでした。</p>`;
  }

  planBody.innerHTML = `
    <div class="route-line">${routeHtml}</div>
    <div class="meter">
      <div class="meter-text">
        <span>電車賃 <b>${yen(plan.fare)}円</b> / 予算 ${yen(cond.budget)}円</span>
        <span>${left >= 0 ? `あと${yen(left)}円` : `${yen(-left)}円オーバー`}</span>
      </div>
      <div class="meter-bar"><div class="meter-fill" style="width:${usage}%"></div></div>
    </div>
    <p class="plan-stats">電車の時間 約${duration(plan.travel)}・スポット ${spotCount}か所・${toClock(timeline.endTime)}ごろ${cond.tripType === "round" ? "到着" : "終了"}</p>
    <ol class="timeline">${listHtml}</ol>
    ${notes}
  `;

  drawPlanOnMap(plan, timeline, cond);
  updateStale();
  planSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

// プランを地図に描く
function drawPlanOnMap(plan, timeline, cond) {
  const allPoints = [];

  // 電車のルート
  for (const leg of plan.legs) {
    for (const ride of leg.rides) {
      const points = ride.path.map((n) => [NODE[n].lat, NODE[n].lng]);
      allPoints.push(...points);
      L.polyline(points, {
        color: COLORS.shu, weight: 5, opacity: 0.85,
        dashArray: ride.op === "徒歩" ? "4 8" : null,
      }).addTo(planLayer);
    }
  }

  // 立ち寄る駅に番号をつける
  plan.stops.forEach((name, index) => {
    const node = NODE[name];
    allPoints.push([node.lat, node.lng]);
    L.marker([node.lat, node.lng], {
      icon: L.divIcon({ className: "", html: `<div class="stop-pin">${index + 1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
      zIndexOffset: 900,
    })
      .bindPopup(`<b>${index + 1}. ${name}</b>`)
      .addTo(planLayer);
  });

  // 回るスポット
  for (const spot of timeline.visited) {
    allPoints.push([spot.lat, spot.lng]);
    L.circleMarker([spot.lat, spot.lng], {
      radius: 7, color: "#fff", weight: 2, fillColor: COLORS.ink, fillOpacity: 0.9,
    })
      .bindPopup(`<b>${spot.name}</b><br>${spot.desc}`)
      .addTo(planLayer);
  }

  const start = NODE[cond.start];
  allPoints.push([start.lat, start.lng]);
  map.fitBounds(L.latLngBounds(allPoints), { padding: [40, 40], maxZoom: 14 });
}

function closePlan() {
  plans = [];
  planKey = null;
  planSection.hidden = true;
  planLayer.clearLayers();
  updateStale();
}

// 条件が、プランを作ったときから変わったか
function updateStale() {
  const hasPlan = !planSection.hidden && planKey !== null;
  const changed = hasPlan && conditionKey(getConditions()) !== planKey;
  staleNote.hidden = !changed;
  generateButton.textContent = changed ? "この条件で作りなおす" : "この条件でプランを作る";
  generateButton.classList.toggle("is-attention", changed);
}

// 出発駅に合わせて地図を動かす
function fitToReachable() {
  const cond = getConditions();
  const points = [[NODE[cond.start].lat, NODE[cond.start].lng]];
  for (const name of spotStations) {
    if (name === cond.start) continue;
    const check = checkStation(name, cond);
    if (check && check.ok) points.push([NODE[name].lat, NODE[name].lng]);
  }
  if (points.length > 1) {
    map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 13 });
  } else {
    map.setView(points[0], 12);
  }
}

// =====================================================
// 4. ボタンや入力のイベント
// =====================================================
budgetNumber.addEventListener("input", () => {
  budgetRange.value = budgetNumber.value;
  render();
});
budgetRange.addEventListener("input", () => {
  budgetNumber.value = budgetRange.value;
  render();
});
startSelect.addEventListener("change", () => {
  render();
  fitToReachable();
});
for (const radio of document.querySelectorAll('input[name="tripType"]')) {
  radio.addEventListener("change", render);
}
useExpressBox.addEventListener("change", () => {
  render();
  fitToReachable();
});
departTime.addEventListener("change", render);
backTime.addEventListener("change", render);
genreList.addEventListener("change", render);
keywordInput.addEventListener("input", render);

generateButton.addEventListener("click", generatePlans);

nextPlanButton.addEventListener("click", () => {
  const changed = conditionKey(getConditions()) !== planKey;
  if (changed || isSinglePlan || plans.length <= 1) {
    generatePlans(); // 条件が変わっていたら、新しい条件で作りなおす
    return;
  }
  planIndex = (planIndex + 1) % plans.length;
  showPlan();
});

closePlanButton.addEventListener("click", () => {
  closePlan();
  fitToReachable();
});

// 地図の吹き出しの「ここから出発する」ボタン
document.addEventListener("click", (event) => {
  const button = event.target.closest(".popup-start");
  if (!button) return;
  startSelect.value = button.dataset.start;
  map.closePopup();
  render();
  fitToReachable();
});

// 最初に1回描く
render();
fitToReachable();
