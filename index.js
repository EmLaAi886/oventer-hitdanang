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
  Thuật toán dự đoán xịn
-----------------------*/
function duDoan(history, last_n = 12) {
  if (!history.length) return "Chưa có dữ liệu";

  const recent = history.slice(0, last_n);
  const fullSeq = history.map((h) => h.Ket_qua);

  // 1. Đếm Tài/Xỉu gần nhất
  const tai_count = recent.filter((h) => h.Ket_qua === "Tài").length;
  const xiu_count = recent.filter((h) => h.Ket_qua === "Xỉu").length;

  // 2. Phân tích chuỗi (pattern) 3 phiên gần nhất
  const last3 = fullSeq.slice(0, 3).join("-");
  const matchSeq = fullSeq.filter((_, i) => i + 3 < fullSeq.length)
    .map((_, i) => fullSeq.slice(i, i + 3).join("-"));
  const idx = matchSeq.indexOf(last3);
  let seq_predict = null;
  if (idx !== -1) {
    seq_predict = fullSeq[idx + 3]; // dự đoán theo mẫu chuỗi
  }

  // 3. Markov Chain bậc 2
  let markov_predict = null;
  if (fullSeq.length >= 3) {
    const trans = {};
    for (let i = 0; i < fullSeq.length - 2; i++) {
      const key = fullSeq[i] + "-" + fullSeq[i + 1];
      if (!trans[key]) trans[key] = { Tài: 0, Xỉu: 0 };
      trans[key][fullSeq[i + 2]]++;
    }
    const last2 = fullSeq[0] + "-" + fullSeq[1];
    if (trans[last2]) {
      const { Tài, Xỉu } = trans[last2];
      markov_predict = Tài > Xỉu ? "Tài" : Xỉu > Tài ? "Xỉu" : null;
    }
  }

  // 4. Kết hợp kết quả
  let final_predict = "Không rõ";
  if (seq_predict) {
    final_predict = seq_predict; // Ưu tiên theo mẫu chuỗi
  } else if (markov_predict) {
    final_predict = markov_predict; // Sau đó Markov
  } else {
    final_predict = tai_count > xiu_count ? "Tài" : "Xỉu";
  }

  return final_predict;
}

/*-----------------------
  Poll API
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
              console.log(`[MD5] Phiên ${sid} - Tổng: ${total}, Kết quả: ${ket_qua}`);
            }
          } else if (!is_md5 && game.cmd === 1003) {
            const { d1, d2, d3 } = game;
            const sid = sid_for_tx;
            if (sid && sid !== last_sid_100 && d1 != null && d2 != null && d3 != null) {
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
              console.log(`[TX] Phiên ${sid} - Tổng: ${total}, Kết quả: ${ket_qua}`);
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
  const result = { ...latest_result_100, du_doan: duDoan(history_100) };
  res.json(result);
});

app.get("/api/taixiumd5", (req, res) => {
  const result = { ...latest_result_101, du_doan: duDoan(history_101) };
  res.json(result);
});

app.get("/api/history", (req, res) => {
  res.json({ taixiu: history_100, taixiumd5: history_101 });
});

app.get("/", (req, res) => {
  res.send("API Server for TaiXiu is running. Endpoints: /api/taixiu, /api/taixiumd5, /api/history");
});

/*-----------------------
  Start polling
-----------------------*/
pollAPI("vgmn_100", false);
pollAPI("vgmn_101", true);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
