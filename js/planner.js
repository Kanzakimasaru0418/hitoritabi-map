// =====================================================
// planner.js … 予算と時間に合わせて、日帰りプランを考える
// =====================================================
// 流れ：
//  1. 条件に合うスポットがあって、日帰りで行ける駅を「候補」として集める
//  2. 候補の駅を1〜3か所つなぐルートを全部ためす（出発駅 → A → B → 出発駅）
//  3. 予算と時間におさまるルートに点数をつける（予算をたくさん使うほど高得点）
//  4. 点数の高い順に並べる → 1位を表示。「別の案」ボタンで2位、3位…を表示
//  5. えらばれたルートの時間割（タイムライン）を作る

const MAX_STOPS = 3;             // 1日で回る駅の数の上限
const LUNCH_MIN = 45;            // 昼ごはんの時間（分）
const LUNCH_FROM = 11 * 60 + 30; // 11:30 をすぎたら昼ごはんにする
const MAX_PLANS = 30;            // 何案まで用意するか
const MAX_TRAVEL_RATIO = 0.7;    // 使える時間のうち、電車に乗っている時間は7割まで

// ----- 時刻の変換 -----
// "09:00" → 540（0時から何分か）
function toMinutes(timeText) {
  const [h, m] = timeText.split(":").map(Number);
  return h * 60 + m;
}
// 540 → "9:00"
function toClock(minutes) {
  const h = Math.floor(minutes / 60);
  const m = String(Math.round(minutes) % 60).padStart(2, "0");
  return `${h}:${m}`;
}

// ----- 歩く時間 -----
// 2地点の距離（メートル）。地球を球として計算する「ハバーサインの公式」
function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// 道は曲がっているので直線の1.25倍、分速75mで歩くとして計算
function walkMinutes(a, b) {
  return Math.max(3, Math.round((distanceMeters(a, b) * 1.25) / 75));
}

// ----- 駅とスポットの間の移動 -----
// バスやフェリーで行くスポットには access が書いてある
function spotGroup(spot) {
  return spot.access ? spot.access.group : null;
}
// 駅 → スポット
function goMinutes(station, spot) {
  return spot.access ? spot.access.minutes : walkMinutes(station, spot);
}
// スポット → 駅
function backMinutes(spot, station) {
  return spot.access ? spot.access.minutes : walkMinutes(spot, station);
}
// 今いる場所（駅かスポット）→ 次のスポット
function moveMinutes(here, spot, station) {
  if (here === station) return goMinutes(station, spot);
  if (spotGroup(here) === spotGroup(spot)) return walkMinutes(here, spot); // 同じエリアなら歩く
  return backMinutes(here, station) + goMinutes(station, spot);            // いったん駅にもどる
}

// ----- スポットのしぼりこみ -----
function hasNoFilter(cond) {
  return cond.genres.length === 0 && cond.keywords.length === 0;
}

function spotMatches(spot, cond) {
  if (hasNoFilter(cond)) {
    return true;
  }
  for (const g of cond.genres) {
    if (spot.genres.includes(g)) {
      return true;
    }
  }
  const text = [spot.name, spot.desc, ...spot.tags, ...spot.genres].join(" ");
  for (const word of cond.keywords) {
    if (text.includes(word)) {
      return true;
    }
  }
  return false;
}

function spotsAt(stationName, cond) {
  return SPOTS.filter((s) => s.station === stationName && spotMatches(s, cond));
}

// 回る順番を決める（今いる場所から、いちばん早く行ける所へ次々に進む）
function orderSpots(station, spots) {
  const rest = [...spots];
  const ordered = [];
  let here = station;
  while (rest.length > 0) {
    let best = 0;
    for (let i = 1; i < rest.length; i++) {
      if (moveMinutes(here, rest[i], station) < moveMinutes(here, rest[best], station)) {
        best = i;
      }
    }
    here = rest.splice(best, 1)[0];
    ordered.push(here);
  }
  return ordered;
}

// ----- 1つの駅で観光するときの情報 -----
// full … 条件に合うスポットを全部回る時間
// min  … いちばん手軽なスポット1か所だけ回る時間
const stopInfoCache = {};
function stopInfo(stationName, cond) {
  const key = stationName + "|" + cond.genres.join(",") + "|" + cond.keywords.join(",");
  if (stopInfoCache[key]) return stopInfoCache[key];

  const station = NODE[stationName];
  const spots = orderSpots(station, spotsAt(stationName, cond));

  let full = 0;
  let here = station;
  for (const spot of spots) {
    full += moveMinutes(here, spot, station) + spot.stay;
    here = spot;
  }
  if (here !== station) full += backMinutes(here, station);

  let min = Infinity;
  for (const spot of spots) {
    min = Math.min(min, goMinutes(station, spot) + spot.stay + backMinutes(spot, station));
  }
  const info = { name: stationName, spots: spots, full: full, min: min };
  stopInfoCache[key] = info;
  return info;
}

// 昼ごはんの時間が必要か（12時〜13時をまたぐ旅なら必要）
function lunchMinutes(cond) {
  return cond.depart < 12 * 60 && cond.back > 13 * 60 ? LUNCH_MIN : 0;
}

// =====================================================
// 1〜4. ルートの候補を作って、点数の高い順に並べる
// =====================================================
function findPlans(cond) {
  const available = cond.back - cond.depart; // 使える時間（分）
  const lunch = lunchMinutes(cond);
  const isRound = cond.tripType === "round";
  const leg = (a, b) => getLeg(a, b, cond.useExpress);

  // --- 1. 候補の駅（1か所だけでも日帰りできる駅にしぼる） ---
  const infos = {};
  const candidates = [];
  for (const node of NODES) {
    const info = stopInfo(node.name, cond);
    if (info.spots.length === 0) continue;
    if (node.name !== cond.start) {
      const go = leg(cond.start, node.name);
      if (!go) continue;
      const back = isRound ? leg(node.name, cond.start) : { fare: 0, minutes: 0 };
      if (!back) continue;
      if (go.fare + back.fare > cond.budget) continue;
      if (go.minutes + back.minutes + info.min + lunch > available) continue;
    }
    infos[node.name] = info;
    candidates.push(node.name);
  }

  // --- 2. ルートを全部ためす ---
  let found = [];

  function evaluate(stops, legs, fare, travel, minSum) {
    let totalFare = fare;
    let totalTravel = travel;
    const allLegs = [...legs];

    if (isRound) {
      const back = leg(stops[stops.length - 1], cond.start);
      if (!back) return;
      totalFare += back.fare;
      totalTravel += back.minutes;
      allLegs.push(back);
    }
    if (totalFare > cond.budget) return;
    if (totalTravel + minSum + lunch > available) return;
    if (totalTravel > available * MAX_TRAVEL_RATIO) return; // 1日のほとんどが電車の中、はやめる

    // --- 3. 点数をつける ---
    const sightTime = available - totalTravel - lunch; // 観光に使える時間
    const fullSum = stops.reduce((sum, s) => sum + infos[s].full, 0);
    const fitRatio = Math.min(1, sightTime / fullSum);
    const spotCount = stops.reduce((sum, s) => sum + infos[s].spots.length, 0) * fitRatio;
    const usage = cond.budget > 0 ? totalFare / cond.budget : 0;

    const score =
      usage * 100 +                        // 予算をたくさん使うほど高い
      Math.min(spotCount, 10) * 3 -        // 回れるスポットが多いほど高い
      stops.length * 3 -                   // 移動ばかりにならないよう、駅数は少し減点
      (totalTravel / available) * 30;      // 電車に乗っている時間が長すぎると減点

    found.push({
      stops: [...stops], legs: allLegs, fare: totalFare, travel: totalTravel,
      usage: usage, score: score,
    });

    // たくさんたまったら、点数の低いものを捨てる（メモリと時間の節約）
    if (found.length > 3000) {
      found.sort((a, b) => b.score - a.score);
      found = found.slice(0, 800);
    }
  }

  function search(stops, legs, fare, travel, minSum) {
    if (stops.length > 0) {
      evaluate(stops, legs, fare, travel, minSum);
    }
    if (stops.length === MAX_STOPS) return;

    const here = stops.length > 0 ? stops[stops.length - 1] : cond.start;
    for (const next of candidates) {
      if (stops.includes(next) || next === here) continue;
      if (next === cond.start && stops.length > 0) continue; // 出発駅に途中でもどるルートは作らない
      const l = leg(here, next);
      if (!l) continue;
      const newFare = fare + l.fare;
      const newTravel = travel + l.minutes;
      const newMin = minSum + infos[next].min;
      // 予算・時間をこえるなら、その先は調べない（むだな計算を減らす）
      if (newFare > cond.budget) continue;
      if (newTravel + newMin + lunch > available) continue;
      search([...stops, next], [...legs, l], newFare, newTravel, newMin);
    }
  }

  search([], [], 0, 0, 0);

  // --- 4. 同じ駅の組み合わせは、いちばん点数の高い順番だけ残す ---
  found.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const plans = [];
  for (const plan of found) {
    const key = [...plan.stops].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    plan.infos = plan.stops.map((s) => infos[s]);
    plans.push(plan);
    if (plans.length >= MAX_PLANS) break;
  }
  return plans;
}

// 1つの駅だけのプラン（リストの「この駅だけでプラン」ボタン用）
function makeSingleStopPlan(stationName, cond) {
  const go = getLeg(cond.start, stationName, cond.useExpress);
  if (!go) return null;
  const legs = [go];
  let fare = go.fare;
  let travel = go.minutes;
  if (cond.tripType === "round") {
    const back = getLeg(stationName, cond.start, cond.useExpress);
    legs.push(back);
    fare += back.fare;
    travel += back.minutes;
  }
  let info = stopInfo(stationName, cond);
  if (info.spots.length === 0) {
    // 条件に合うスポットがなければ、その駅のスポットを全部使う
    info = stopInfo(stationName, { genres: [], keywords: [] });
  }
  return {
    stops: [stationName], legs: legs, fare: fare, travel: travel,
    usage: cond.budget > 0 ? fare / cond.budget : 0, score: 0, infos: [info],
  };
}

// =====================================================
// 5. 時間割（タイムライン）を作る
// =====================================================
function buildTimeline(plan, cond) {
  const bonus = plan.stops.map(() => 0); // 駅ごとに足す時間
  let best = buildTimelineOnce(plan, cond, bonus);

  // 時間があまっているのに、とばしたスポットがあるなら、
  // あまった時間をその駅に足して作りなおす（よくなる間くり返す）
  for (let round = 0; round < 6; round++) {
    if (best.spare <= 5 || best.skipped.length === 0) break;
    let improved = false;
    for (const index of new Set(best.skipped.map((s) => s.stopIndex))) {
      const tryBonus = [...bonus];
      tryBonus[index] += best.spare;
      const retry = buildTimelineOnce(plan, cond, tryBonus);
      if (retry.spare >= 0 && retry.visited.length > best.visited.length) {
        best = retry;
        bonus[index] = tryBonus[index];
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }
  return best;
}

// スポットへ移動するときの「時間割の行」を作る
function moveSteps(here, spot, station, stationName) {
  if (here === station) {
    return [goStep(spot, station)];
  }
  if (spotGroup(here) === spotGroup(spot)) {
    return [{ type: "walk", title: `歩いて${spot.name}へ`, minutes: walkMinutes(here, spot) }];
  }
  return [backStep(here, station, stationName), goStep(spot, station)];
}
function goStep(spot, station) {
  const minutes = goMinutes(station, spot);
  if (spot.access) {
    return { type: "walk", title: `${spot.access.by}で${spot.name}へ`, minutes: minutes, note: `${spot.access.by}の料金は別` };
  }
  return { type: "walk", title: `歩いて${spot.name}へ`, minutes: minutes };
}
function backStep(spot, station, stationName) {
  const minutes = backMinutes(spot, station);
  if (spot.access) {
    return { type: "walk", title: `${spot.access.by}で${stationName}駅へ`, minutes: minutes, note: `${spot.access.by}の料金は別` };
  }
  return { type: "walk", title: `歩いて${stationName}駅へ`, minutes: minutes };
}

function buildTimelineOnce(plan, cond, bonus) {
  const available = cond.back - cond.depart;
  const lunch = lunchMinutes(cond);
  const sightTime = Math.max(0, available - plan.travel - lunch);

  // --- 観光の時間を、駅ごとに分ける ---
  const fullSum = plan.infos.reduce((sum, info) => sum + info.full, 0);
  const minSum = plan.infos.reduce((sum, info) => sum + info.min, 0);
  const allot = plan.infos.map((info) => {
    if (fullSum <= sightTime) return info.full;                       // 全部回れる
    if (sightTime <= minSum || fullSum === minSum) return info.min;   // 最低限だけ
    // 最低限の時間に、残りの時間を「全部回るのに足りない分」の割合で足す
    const extra = (sightTime - minSum) * (info.full - info.min) / (fullSum - minSum);
    return info.min + extra;
  });

  const steps = [];
  const skipped = [];
  const visited = [];
  let t = cond.depart;
  let hadLunch = lunch === 0; // 昼ごはんが要らない旅なら、最初から「食べた」ことにする
  let place = cond.start;

  steps.push({ time: t, type: "start", title: `${cond.start}を出発` });

  // 昼ごはんの時間になっていたら入れる
  function lunchIfNeeded(nextSpot) {
    if (hadLunch || t < LUNCH_FROM) return false;
    const isFood = nextSpot && (nextSpot.genres.includes("食べ歩き") || nextSpot.genres.includes("カフェ"));
    if (isFood) {
      return true; // 次が食べ物のスポットなら、そこで食べる
    }
    steps.push({ time: t, type: "lunch", title: "昼ごはん", desc: `近くのお店でひと休み（約${LUNCH_MIN}分）` });
    t += LUNCH_MIN;
    hadLunch = true;
    return false;
  }

  plan.stops.forEach((stopName, index) => {
    const leg = plan.legs[index];
    const info = plan.infos[index];
    const station = NODE[stopName];

    // --- 電車で移動 ---
    if (leg.rides.length > 0) {
      steps.push({
        time: t, type: "move", title: `${place} → ${stopName}`,
        desc: `${leg.fare.toLocaleString("ja-JP")}円・約${leg.minutes}分`, rides: leg.rides,
      });
      t += leg.minutes;
      steps.push({ time: t, type: "arrive", title: `${stopName}に到着` });
    }

    // --- 駅のまわりを観光 ---
    let used = 0;                            // この駅で使った時間
    let limit = allot[index] + bonus[index]; // この駅で使える時間
    let here = station;
    let count = 0;
    for (const spot of info.spots) {
      const moves = moveSteps(here, spot, station, stopName);
      const moveTotal = moves.reduce((sum, m) => sum + m.minutes, 0);
      const backTime = backMinutes(spot, station);
      const eatHere = lunchIfNeeded(spot);
      const stay = eatHere ? spot.stay + 30 : spot.stay;
      if (eatHere) {
        limit += 30; // 昼ごはんの分は、別に用意してある時間から使う
      }

      // 時間が足りなければとばす（ただし1か所は必ず行く）
      if (count > 0 && used + moveTotal + stay + backTime > limit) {
        if (eatHere) limit -= 30;
        skipped.push({ name: spot.name, stopIndex: index });
        continue;
      }

      for (const m of moves) {
        steps.push({ time: t, type: "walk", title: m.title, desc: `約${m.minutes}分` + (m.note ? `（${m.note}）` : "") });
        t += m.minutes;
      }
      steps.push({
        time: t, type: "spot", title: spot.name, spot: spot,
        desc: spot.desc + (eatHere ? "　ここでお昼ごはんも◎" : "") + `（約${stay}分）`,
      });
      t += stay;
      used += moveTotal + stay;
      here = spot;
      count++;
      visited.push(spot);
      if (eatHere) hadLunch = true;
    }

    // 駅にもどる
    if (here !== station) {
      const m = backStep(here, station, stopName);
      steps.push({ time: t, type: "walk", title: m.title, desc: `約${m.minutes}分` + (m.note ? `（${m.note}）` : "") });
      t += m.minutes;
    }
    place = stopName;
  });

  // まだ昼ごはんを食べていなければ、ここで
  if (!hadLunch) {
    steps.push({ time: t, type: "lunch", title: "昼ごはん", desc: `${place}の近くで（約${LUNCH_MIN}分）` });
    t += LUNCH_MIN;
  }

  // --- 帰り ---
  if (cond.tripType === "round") {
    const back = plan.legs[plan.legs.length - 1];
    if (back.rides.length > 0) {
      steps.push({
        time: t, type: "move", title: `${place} → ${cond.start}`,
        desc: `${back.fare.toLocaleString("ja-JP")}円・約${back.minutes}分`, rides: back.rides,
      });
      t += back.minutes;
    }
    steps.push({ time: t, type: "goal", title: `${cond.start}に到着`, desc: "おつかれさまでした！" });
  } else {
    steps.push({ time: t, type: "goal", title: `${place}で旅はおしまい`, desc: "ここから先は、帰り道を楽しんでください" });
  }

  return {
    steps: steps,
    skipped: skipped,
    visited: visited,
    endTime: t,
    spare: cond.back - t, // 時間のあまり（マイナスなら時間オーバー）
  };
}
