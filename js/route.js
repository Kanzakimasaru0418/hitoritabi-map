// =====================================================
// route.js … 運賃と所要時間を計算する
// =====================================================
// 考え方：
//  ・同じ鉄道会社の中なら、乗りかえても1枚のきっぷ（距離を合計して運賃を決める）
//  ・ちがう会社に乗りかえるときは、きっぷを買いなおす（運賃を足す）
//  ・新幹線・特急に乗った区間は、運賃に「特急料金」を足す
//  ・いちばん安くて早い行き方を「ダイクストラ法」（一番近い所から順に確定させていく、
//    カーナビなどでも使われる道さがしの方法）で探す

// 行き方をえらぶとき「1分 = 何円」とみなすか（安さと早さのバランス）
// 新幹線・特急を使うときは、時間を大事にする（1分 = 50円）
const TIME_VALUE_LOCAL = 10;
const TIME_VALUE_EXPRESS = 50;
const WAIT_MIN = 5;        // 電車を待つ時間（1回乗るごと）
const LINE_CHANGE_MIN = 5; // 同じ会社の中で、別の路線に乗りかえる時間
const EXPRESS_CHANGE_MIN = 10; // 新幹線・特急に乗りかえる時間（決まった列車を待つので長め）
const TRANSFER_MIN = 8;    // 別の会社に乗りかえる時間（改札を出て、入りなおす）
const LINE_CHANGE_PENALTY_KM = 2; // 普通列車だけのとき、乗りかえは「2km 遠回り」と同じくらい面倒、とみなす

// ----- 名前から駅をすぐ取り出せるようにしておく -----
const NODE = {};
for (const node of NODES) {
  NODE[node.name] = node;
}

// JRの「電車特定区間」の中の駅か
function inJrZone(name) {
  const node = NODE[name];
  if (node.jrZone !== undefined) return node.jrZone;
  return JR_ZONE_AREAS.includes(node.area);
}

// ----- 会社ごとの「つながり表」を作る -----
// EDGES["JR"]["天王寺"] = [{ to: "鶴橋", km: 3.0, line: 大阪環状線 }, ...]
const EDGES = {};

function addEdge(graph, from, to, km, line) {
  if (!graph[from]) {
    graph[from] = [];
  }
  graph[from].push({ to: to, km: km, line: line });
}

for (const line of LINES) {
  if (!EDGES[line.op]) {
    EDGES[line.op] = {};
  }
  for (let i = 0; i < line.stations.length - 1; i++) {
    const [a, kmA] = line.stations[i];
    const [b, kmB] = line.stations[i + 1];
    const km = Math.abs(kmB - kmA);
    addEdge(EDGES[line.op], a, b, km, line); // 行き
    addEdge(EDGES[line.op], b, a, km, line); // 帰り
  }
}

// その駅に乗り入れている会社の一覧
function operatorsAt(name) {
  return Object.keys(EDGES).filter((op) => EDGES[op][name]);
}

// 新幹線・特急がある会社か
const EXPRESS_OPS = new Set(LINES.filter((l) => l.express).map((l) => l.op));

// ----- 運賃表から運賃を読む -----
function tableFare(table, km) {
  // 小数の計算のずれを直してから、端数を切り上げる（10.7km → 11km）
  const k = Math.ceil(Math.round(km * 10) / 10);
  for (const [maxKm, fare] of table) {
    if (k <= maxKm) {
      return fare;
    }
  }
  return table[table.length - 1][1];
}

// JRの特定運賃をさがす（なければ null）
function findSpecialFare(a, b) {
  for (const [x, y, fare] of SPECIAL_FARES) {
    if ((x === a && y === b) || (x === b && y === a)) {
      return fare;
    }
  }
  return null;
}

// 1回の乗車（同じ会社の中）の運賃（特急料金はふくまない）
function rideFare(op, from, to, km) {
  if (op === "JR") {
    const special = findSpecialFare(from, to);
    if (special !== null) {
      return special;
    }
    const zone = inJrZone(from) && inJrZone(to);
    return tableFare(zone ? FARE_TABLES.JR_ZONE : FARE_TABLES.JR_MAIN, km);
  }
  if (op === "大阪メトロ") return tableFare(FARE_TABLES.METRO, km);
  if (op === "近鉄") return tableFare(FARE_TABLES.KINTETSU, km);
  if (op === "阪堺電車") return tableFare(FARE_TABLES.HANKAI, km);
  return 0;
}

// 小さい順に取り出せる箱（優先度つきキュー）。たくさんの候補から最小を速く取り出すために使う
class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (a[parent].cost <= a[i].cost) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < a.length && a[l].cost < a[smallest].cost) smallest = l;
        if (r < a.length && a[r].cost < a[smallest].cost) smallest = r;
        if (smallest === i) break;
        [a[smallest], a[i]] = [a[i], a[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

// =====================================================
// A. 同じ会社の中で、ある駅から行けるすべての駅への「1回の乗車」を調べる
// =====================================================
// useExpress = false … 普通列車だけ。距離が短い道をえらぶ
// useExpress = true  … 新幹線・特急も使う。時間が短い道をえらぶ
const rideCache = {}; // 一度計算したら覚えておく（同じ計算をくり返さないため）

function ridesFrom(op, from, useExpress) {
  const key = op + "|" + from + "|" + useExpress;
  if (rideCache[key]) {
    return rideCache[key];
  }

  const graph = EDGES[op];
  // 「どの駅に、どの路線で着いたか」を1つの状態として考える
  const states = {}; // states["鶴橋|大阪環状線"] = { node, line, cost, km, prevKey, edge }
  const done = {};
  const heap = new MinHeap();
  states[from + "|"] = { node: from, line: null, cost: 0, km: 0, prevKey: null, edge: null };
  heap.push({ key: from + "|", cost: 0 });

  while (heap.size > 0) {
    const { key: currentKey } = heap.pop();
    if (done[currentKey]) continue;
    done[currentKey] = true;
    const current = states[currentKey];

    for (const edge of graph[current.node] || []) {
      if (edge.line.express && !useExpress) continue; // 普通列車だけのときは特急に乗らない
      const change = current.line !== null && current.line !== edge.line.name;
      let step;
      if (useExpress) {
        const changeMin = edge.line.express ? EXPRESS_CHANGE_MIN : LINE_CHANGE_MIN;
        step = (edge.km / edge.line.speed) * 60 + (change ? changeMin : 0); // 時間（分）
      } else {
        step = edge.km + (change ? LINE_CHANGE_PENALTY_KM : 0); // 距離（km）
      }
      const cost = current.cost + step;
      const nextKey = edge.to + "|" + edge.line.name;
      if (!states[nextKey] || cost < states[nextKey].cost - 0.0001) {
        states[nextKey] = {
          node: edge.to, line: edge.line.name, cost: cost,
          km: current.km + edge.km, prevKey: currentKey, edge: edge,
        };
        heap.push({ key: nextKey, cost: cost });
      }
    }
  }

  // 駅ごとに、いちばん cost が小さい状態をえらぶ
  const best = {};
  for (const k in states) {
    const s = states[k];
    if (s.node !== from && (!best[s.node] || s.cost < best[s.node].cost)) {
      best[s.node] = s;
    }
  }

  const result = {};
  for (const to in best) {
    result[to] = makeRide(op, from, best[to], states);
  }
  rideCache[key] = result;
  return result;
}

// 道を逆にたどって、1回の乗車の情報（運賃・時間・通る駅）を作る
function makeRide(op, from, endState, states) {
  const to = endState.node;
  const km = endState.km;
  const edges = [];
  let s = endState;
  while (s.edge !== null) {
    edges.unshift(s.edge);
    s = states[s.prevKey];
  }

  let minutes = WAIT_MIN;
  const lineNames = [];
  const kasanKm = new Map();   // 加算運賃がある路線を何km乗ったか
  const expressKm = new Map(); // 特急料金の表ごとに何km乗ったか

  for (const edge of edges) {
    minutes += (edge.km / edge.line.speed) * 60;
    const lastLine = lineNames[lineNames.length - 1];
    if (lastLine !== edge.line.name) {
      if (lineNames.length > 0) {
        minutes += edge.line.express ? EXPRESS_CHANGE_MIN : LINE_CHANGE_MIN; // 路線を乗りかえた
      }
      lineNames.push(edge.line.name);
    }
    if (edge.line.kasan) {
      kasanKm.set(edge.line, (kasanKm.get(edge.line) || 0) + edge.km);
    }
    if (edge.line.express) {
      const t = edge.line.express;
      expressKm.set(t, (expressKm.get(t) || 0) + edge.km);
    }
  }

  let fare = rideFare(op, from, to, km);
  for (const [line, lineKm] of kasanKm) {
    fare += tableFare(line.kasan, lineKm);
  }
  let expressFee = 0;
  for (const [tableName, tableKm] of expressKm) {
    expressFee += tableFare(EXPRESS_TABLES[tableName], tableKm);
  }

  return {
    op: op,
    from: from,
    to: to,
    km: km,
    fare: fare + expressFee,   // 運賃 + 特急料金
    expressFee: expressFee,    // そのうち特急料金
    minutes: Math.round(minutes),
    path: [from, ...edges.map((e) => e.to)], // 通る駅
    lines: lineNames,
  };
}

// 歩いて乗りかえる「乗車」
function walkRidesFrom(from) {
  const result = [];
  for (const [a, b, minutes] of WALKS) {
    if (a === from || b === from) {
      const to = a === from ? b : a;
      result.push({ op: "徒歩", from: from, to: to, km: 0, fare: 0, expressFee: 0, minutes: minutes, path: [from, to], lines: ["徒歩"] });
    }
  }
  return result;
}

// =====================================================
// B. 会社をまたいで、ある駅からすべての駅への「いちばん良い行き方」を調べる
// =====================================================
const routeCache = {};

// start から全部の駅への行き方を返す
// 結果：routes["奈良"] = { fare, minutes, rides: [乗車, 乗車, ...] }
function routesFrom(start, useExpress) {
  const cacheKey = start + "|" + useExpress;
  if (routeCache[cacheKey]) {
    return routeCache[cacheKey];
  }
  const timeValue = useExpress ? TIME_VALUE_EXPRESS : TIME_VALUE_LOCAL;

  const routes = {};
  const visited = {};
  const heap = new MinHeap();
  heap.push({ node: start, lastOp: null, fare: 0, minutes: 0, rides: [], cost: 0 });

  while (heap.size > 0) {
    const state = heap.pop();
    const key = state.node + "|" + state.lastOp;
    if (visited[key]) continue;
    visited[key] = true;

    // その駅に初めて着いたときが、いちばん良い行き方
    if (!routes[state.node] && state.node !== start) {
      routes[state.node] = { fare: state.fare, minutes: state.minutes, rides: state.rides };
    }

    // 次に乗れる「乗車」を全部ためす
    const nextRides = [];
    for (const op of operatorsAt(state.node)) {
      if (op === state.lastOp) continue; // 同じ会社に続けて乗る＝きっぷを分けることになるので、しない
      nextRides.push(...Object.values(ridesFrom(op, state.node, false)));
      if (useExpress && EXPRESS_OPS.has(op)) {
        // 特急を使う行き方も候補に入れる（特急に乗らない行き方は、上と同じなので入れない）
        for (const ride of Object.values(ridesFrom(op, state.node, true))) {
          if (ride.expressFee > 0) nextRides.push(ride);
        }
      }
    }
    if (state.lastOp !== "徒歩") {
      nextRides.push(...walkRidesFrom(state.node));
    }

    for (const ride of nextRides) {
      const needTransfer = state.lastOp !== null && state.lastOp !== "徒歩" && ride.op !== "徒歩";
      const minutes = state.minutes + ride.minutes + (needTransfer ? TRANSFER_MIN : 0);
      const fare = state.fare + ride.fare;
      heap.push({
        node: ride.to,
        lastOp: ride.op,
        fare: fare,
        minutes: minutes,
        rides: [...state.rides, ride],
        cost: fare + minutes * timeValue,
      });
    }
  }

  routeCache[cacheKey] = routes;
  return routes;
}

// A駅からB駅への行き方（同じ駅なら 0円・0分）
function getLeg(from, to, useExpress) {
  if (from === to) {
    return { fare: 0, minutes: 0, rides: [] };
  }
  return routesFrom(from, useExpress)[to] || null;
}

// 行き方を「JR大和路線　天王寺→奈良　510円」のような短い文にする
function describeRide(ride) {
  if (ride.op === "徒歩") {
    return `${ride.from}から${ride.to}まで歩く（約${ride.minutes}分）`;
  }
  const express = ride.expressFee > 0 ? `（うち特急料金 ${ride.expressFee.toLocaleString("ja-JP")}円）` : "";
  return `${ride.lines.join("・")}　${ride.from}→${ride.to}　${ride.fare.toLocaleString("ja-JP")}円${express}`;
}
