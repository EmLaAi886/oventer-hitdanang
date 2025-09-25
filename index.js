import express from "express";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 8000;

const POLL_INTERVAL = 5000;
const MAX_HISTORY = 50;

let latest_result_100 = {
  Phien: 0,
  Xuc_xac_1: 0,
  Xuc_xac_2: 0,
  Xuc_xac_3: 0,
  Tong: 0,
  Ket_qua: "Chưa có",
  id: "binhtool90",
  phien_hien_tai: 0,
};

let latest_result_101 = { ...latest_result_100 };

let history_100 = [];
let history_101 = [];

let last_sid_100 = null;
let last_sid_101 = null;
let sid_for_tx = null;

/*-----------------------
  Helper Functions
-----------------------*/
function getTaiXiu(d1, d2, d3) {
  const total = d1 + d2 + d3;
  return total <= 10 ? "Xỉu" : "Tài";
}

function updateResult(store, history, result) {
  Object.assign(store, result);
  history.unshift({ ...result });
  if (history.length > MAX_HISTORY) history.pop();
}

/*-----------------------
  MODEL & Nâng cấp dự đoán
  - Ensemble: trigram, bigram, recency, perceptron (online)
  - EMA-based dynamic weights
  - Perceptron updated online (SGD)
-----------------------*/
const MODEL = {
  // EMA alpha for accuracy smoothing (0..1). Closer to 1 => slower change.
  emaAlpha: 0.92,
  // initial smoothed accuracies for submodels
  accuracies: { trigram: 0.5, bigram: 0.5, recency: 0.5, perceptron: 0.5 },
  // ensemble weights (derived from accuracies)
  weights: { trigram: 0.4, bigram: 0.25, recency: 0.2, perceptron: 0.15 },
  minWeight: 0.01,
  // perceptron (simple logistic regression online)
  perceptron: {
    weights: [0, 0, 0, 0], // [bias, last1IsTai, last2IsTai, taiRatioLast6]
    lr: 0.12,
  },
  totals: { predictions: 0 },
  // update ensemble weights from accuracies (normalize)
  updateWeightsFromAcc() {
    const acc = this.accuracies;
    const vals = [acc.trigram, acc.bigram, acc.recency, acc.perceptron].map(
      (v) => Math.max(v, 0.01)
    );
    const s = vals.reduce((a, b) => a + b, 0);
    if (s <= 0) return;
    this.weights.trigram = Math.max(vals[0] / s, this.minWeight);
    this.weights.bigram = Math.max(vals[1] / s, this.minWeight);
    this.weights.recency = Math.max(vals[2] / s, this.minWeight);
    this.weights.perceptron = Math.max(vals[3] / s, this.minWeight);
    // normalize again
    const tot = this.weights.trigram + this.weights.bigram + this.weights.recency + this.weights.perceptron;
    this.weights.trigram /= tot;
    this.weights.bigram /= tot;
    this.weights.recency /= tot;
    this.weights.perceptron /= tot;
  },
  // sigmoid
  _sigmoid(x) {
    const z = Math.max(Math.min(x, 20), -20); // numeric safety
    return 1 / (1 + Math.exp(-z));
  },
  // features: [1, last1IsTai, last2IsTai, taiRatioLast6]
  buildFeaturesFromSeq(seq) {
    // seq: array newest-first e.g. ["Tài","Xỉu",...]
    const last1 = seq[0] || null;
    const last2 = seq[1] || null;
    const last6 = seq.slice(0, 6);
    const taiCount = last6.filter((x) => x === "Tài").length;
    const features = [
      1,
      last1 === "Tài" ? 1 : 0,
      last2 === "Tài" ? 1 : 0,
      last6.length ? taiCount / last6.length : 0.5,
    ];
    return features;
  },
  perceptronPredict(seq) {
    const f = this.buildFeaturesFromSeq(seq);
    const w = this.perceptron.weights;
    let dot = 0;
    for (let i = 0; i < f.length; i++) dot += (w[i] || 0) * f[i];
    const p = this._sigmoid(dot);
    return p; // probability of "Tài"
  },
  perceptronTrain(seq, actualLabel) {
    // actualLabel: "Tài" or "Xỉu"
    const y = actualLabel === "Tài" ? 1 : 0;
    const f = this.buildFeaturesFromSeq(seq);
    const pred = this.perceptronPredict(seq);
    const err = y - pred;
    const lr = this.perceptron.lr;
    for (let i = 0; i < f.length; i++) {
      this.perceptron.weights[i] = (this.perceptron.weights[i] || 0) + lr * err * f[i];
    }
  },
  // call after each true outcome arrives to update accuracies and retrain perceptron
  recordOutcome(historyBefore, actualLabel, subPredictions) {
    // historyBefore: snapshot of history (newest-first) BEFORE adding the current actual
    // subPredictions: object with per-model predicted label {trigram, bigram, recency, perceptron}
    const acc = this.accuracies;
    const alpha = this.emaAlpha;
    // update EMA accuracies
    ["trigram", "bigram", "recency", "perceptron"].forEach((name) => {
      const wasCorrect = subPredictions[name] === actualLabel ? 1 : 0;
      acc[name] = acc[name] * alpha + (1 - alpha) * wasCorrect;
    });
    // update ensemble weights accordingly
    this.updateWeightsFromAcc();
    // train perceptron with the snapshot
    try {
      this.perceptronTrain(historyBefore.map((h) => h.Ket_qua), actualLabel);
    } catch (e) {
      // ignore training errors
    }
    this.totals.predictions++;
  },
};

/*-----------------------
  Predict function (replaces duDoan)
  returns:
   { prediction: "Tài"/"Xỉu"/"Chưa có dữ liệu",
     p_tai: 0..1,
     confidence: 0..1,
     breakdown: {
       trigram: {p_tai, pred},
       bigram: {...},
       recency: {...},
       perceptron: {...},
       ensemble_weights: {...}
     }
   }
-----------------------*/
function predictNext(history, options = {}) {
  const seq = history.map((h) => h.Ket_qua); // newest-first
  if (!seq.length) {
    return { prediction: "Chưa có dữ liệu", p_tai: 0.5, confidence: 0, breakdown: {} };
  }

  // chronological order: oldest -> newest
  const chron = seq.slice().reverse();

  // Build bigram counts: P(next | last1)
  const bigramCounts = {}; // key: last -> {Tài:count, Xỉu:count}
  for (let i = 0; i < chron.length - 1; i++) {
    const last = chron[i];
    const next = chron[i + 1];
    if (!bigramCounts[last]) bigramCounts[last] = { Tài: 0, Xỉu: 0 };
    bigramCounts[last][next] = (bigramCounts[last][next] || 0) + 1;
  }

  // Build trigram counts: P(next | last2)
  const trigramCounts = {}; // key: "A-B" -> {Tài:count, Xỉu:count}
  for (let i = 0; i < chron.length - 2; i++) {
    const key = chron[i] + "-" + chron[i + 1];
    const next = chron[i + 2];
    if (!trigramCounts[key]) trigramCounts[key] = { Tài: 0, Xỉu: 0 };
    trigramCounts[key][next] = (trigramCounts[key][next] || 0) + 1;
  }

  // trigram prediction
  let trigramProb = 0.5;
  let trigramPred = null;
  if (chron.length >= 2) {
    const last2 = chron.slice(-2).join("-");
    const c = trigramCounts[last2];
    if (c) {
      const s = c.Tài + c.Xỉu;
      trigramProb = s ? c.Tài / s : 0.5;
      trigramPred = trigramProb >= 0.5 ? "Tài" : "Xỉu";
    } else {
      trigramProb = 0.5;
      trigramPred = null;
    }
  }

  // bigram prediction
  let bigramProb = 0.5;
  let bigramPred = null;
  if (chron.length >= 1) {
    const last1 = chron.slice(-1)[0];
    const c = bigramCounts[last1];
    if (c) {
      const s = c.Tài + c.Xỉu;
      bigramProb = s ? c.Tài / s : 0.5;
      bigramPred = bigramProb >= 0.5 ? "Tài" : "Xỉu";
    } else {
      bigramProb = 0.5;
      bigramPred = null;
    }
  }

  // recency-weighted probability (exponential decay)
  const decay = options.decay ?? 0.85;
  let wsum = 0;
  let weightedTai = 0;
  for (let i = 0; i < seq.length; i++) {
    const w = Math.pow(decay, i); // i=0 most recent
    wsum += w;
    if (seq[i] === "Tài") weightedTai += w;
  }
  const recencyProb = wsum ? weightedTai / wsum : 0.5;
  const recencyPred = recencyProb >= 0.5 ? "Tài" : "Xỉu";

  // perceptron
  const percepProb = MODEL.perceptronPredict(seq);
  const percepPred = percepProb >= 0.5 ? "Tài" : "Xỉu";

  // ensemble: weighted average of p_tai from submodels using MODEL.weights
  const w = MODEL.weights;
  const combinedNumer = (w.trigram * trigramProb) + (w.bigram * bigramProb) + (w.recency * recencyProb) + (w.perceptron * percepProb);
  const combinedDenom = (w.trigram + w.bigram + w.recency + w.perceptron) || 1;
  const p_tai = combinedNumer / combinedDenom;
  const prediction = p_tai >= 0.5 ? "Tài" : "Xỉu";
  const confidence = Math.abs(p_tai - 0.5) * 2; // 0..1

  return {
    prediction,
    p_tai,
    confidence,
    breakdown: {
      trigram: { p_tai: trigramProb, pred: trigramPred },
      bigram: { p_tai: bigramProb, pred: bigramPred },
      recency: { p_tai: recencyProb, pred: recencyPred },
      perceptron: { p_tai: percepProb, pred: percepPred },
      ensemble_weights: { ...MODEL.weights },
    },
  };
}

/*-----------------------
  Poll API (unchanged flow, but compute prediction BEFORE update and record outcome)
-----------------------*/
async function pollAPI(gid, is_md5) {
  const url = `https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=g8&gid=${gid}`;
  while (true) {
    try {
      const { data } = await axios.get(url, { headers: { "User-Agent": "Node-Proxy/1.0" }, timeout: 10000 });
      if (data.status === "OK" && Array.isArray(data.data)) {
        for (const game of data.data) {
          if (!is_md5 && game.cmd === 1008) {
            sid_for_tx = game.sid;
          }
        }
        for (const game of data.data) {
          if (is_md5 && game.cmd === 2006) {
            const { sid, d1, d2, d3 } = game;
            if (sid && sid !== last_sid_101 && d1 != null && d2 != null && d3 != null) {
              // compute prediction on snapshot BEFORE adding this real result
              const histSnap = history_101.slice(); // newest-first
              const predObj = predictNext(histSnap);

              last_sid_101 = sid;
              const total = d1 + d2 + d3;
              const ket_qua = getTaiXiu(d1, d2, d3);
              const result = {
                Phien: sid,
                Xuc_xac_1: d1,
                Xuc_xac_2: d2,
                Xuc_xac_3: d3,
                Tong: total,
                Ket_qua: ket_qua,
                id: "binhtool90",
                phien_hien_tai: sid + 1,
              };
              updateResult(latest_result_101, history_101, result);
              // record outcome to model (train/update weights)
              MODEL.recordOutcome(histSnap, ket_qua, {
                trigram: predObj.breakdown.trigram.pred,
                bigram: predObj.breakdown.bigram.pred,
                recency: predObj.breakdown.recency.pred,
                perceptron: predObj.breakdown.perceptron.pred,
              });
              console.log(`[MD5] Phiên ${sid} - Tổng: ${total}, Kết quả: ${ket_qua} - Pred: ${predObj.prediction} (p_tai=${predObj.p_tai.toFixed(3)}, conf=${predObj.confidence.toFixed(2)})`);
            }
          } else if (!is_md5 && game.cmd === 1003) {
            const { d1, d2, d3 } = game;
            const sid = sid_for_tx;
            if (sid && sid !== last_sid_100 && d1 != null && d2 != null && d3 != null) {
              const histSnap = history_100.slice(); // snapshot before update
              const predObj = predictNext(histSnap);

              last_sid_100 = sid;
              const total = d1 + d2 + d3;
              const ket_qua = getTaiXiu(d1, d2, d3);
              const result = {
                Phien: sid,
                Xuc_xac_1: d1,
                Xuc_xac_2: d2,
                Xuc_xac_3: d3,
                Tong: total,
                Ket_qua: ket_qua,
                id: "binhtool90",
                phien_hien_tai: sid + 1,
              };
              updateResult(latest_result_100, history_100, result);
              MODEL.recordOutcome(histSnap, ket_qua, {
                trigram: predObj.breakdown.trigram.pred,
                bigram: predObj.breakdown.bigram.pred,
                recency: predObj.breakdown.recency.pred,
                perceptron: predObj.breakdown.perceptron.pred,
              });
              console.log(`[TX] Phiên ${sid} - Tổng: ${total}, Kết quả: ${ket_qua} - Pred: ${predObj.prediction} (p_tai=${predObj.p_tai.toFixed(3)}, conf=${predObj.confidence.toFixed(2)})`);
              sid_for_tx = null;
            }
          }
        }
      }
    } catch (err) {
      console.error(`Lỗi khi lấy dữ liệu API ${gid}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

/*-----------------------
  Routes
-----------------------*/
app.get("/api/taixiu", (req, res) => {
  const pred = predictNext(history_100);
  const result = { ...latest_result_100, du_doan: pred };
  res.json(result);
});

app.get("/api/taixiumd5", (req, res) => {
  const pred = predictNext(history_101);
  const result = { ...latest_result_101, du_doan: pred };
  res.json(result);
});

app.get("/api/history", (req, res) => {
  res.json({ taixiu: history_100, taixiumd5: history_101 });
});

// New: model stats
app.get("/api/model_stats", (req, res) => {
  res.json({
    accuracies: MODEL.accuracies,
    weights: MODEL.weights,
    perceptron_weights: MODEL.perceptron.weights,
    totals: MODEL.totals,
  });
});

app.get("/", (req, res) => {
  res.send("API Server for TaiXiu is running. Endpoints: /api/taixiu, /api/taixiumd5, /api/history, /api/model_stats");
});

/*-----------------------
  Start polling
-----------------------*/
pollAPI("vgmn_100", false);
pollAPI("vgmn_101", true);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
