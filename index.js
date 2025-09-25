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
  Thuật toán dự đoán xịn hơn
-----------------------*/
function duDoan(history, last_n = 12) {
  if (!history.length) return "Chưa có dữ liệu";

  const recent = history.slice(0, last_n);
  
  // Phân tích xu hướng mạnh mẽ
  let tai_count = 0, xiu_count = 0;
  let consecutive_tai = 0, consecutive_xiu = 0;
  let max_consecutive_tai = 0, max_consecutive_xiu = 0;

  for (let i = 0; i < recent.length; i++) {
    if (recent[i].Ket_qua === "Tài") {
      tai_count++;
      consecutive_tai++;
      consecutive_xiu = 0;
      if (consecutive_tai > max_consecutive_tai) max_consecutive_tai = consecutive_tai;
    } else {
      xiu_count++;
      consecutive_xiu++;
      consecutive_tai = 0;
      if (consecutive_xiu > max_consecutive_xiu) max_consecutive_xiu = consecutive_xiu;
    }
  }

  // Phân tích chu kỳ và đảo chiều
  let trend_reversal = false;
  if (recent.length >= 4) {
    const last4 = recent.slice(0, 4);
    const pattern = last4.map(h => h.Ket_qua);
    
    // Phát hiện xu hướng đảo chiều
    if ((pattern[0] === pattern[1] && pattern[1] !== pattern[2]) || 
        (pattern[0] !== pattern[1] && pattern[1] === pattern[2])) {
      trend_reversal = true;
    }
  }

  // Dự đoán thông minh hơn
  let prediction = "Không rõ";

  // Ưu tiên phát hiện đảo chiều
  if (trend_reversal && recent.length >= 3) {
    prediction = recent[0].Ket_qua === "Tài" ? "Xỉu" : "Tài";
  }
  // Chuỗi dài thì đảo chiều
  else if (max_consecutive_tai >= 3) {
    prediction = "Xỉu";
  }
  else if (max_consecutive_xiu >= 3) {
    prediction = "Tài";
  }
  // Phân tích tỷ lệ đơn giản
  else {
    const tai_ratio = tai_count / recent.length;
    const xiu_ratio = xiu_count / recent.length;
    
    if (tai_ratio > 0.6) prediction = "Xỉu";
    else if (xiu_ratio > 0.6) prediction = "Tài";
    else prediction = tai_count > xiu_count ? "Xỉu" : "Tài";
  }

  return prediction;
}

/*-----------------------
  Poll API - Tao sửa lại cho chắc
-----------------------*/
async function pollAPI(gid, is_md5) {
  const url = `https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=g8&gid=${gid}`;
  
  while (true) {
    try {
      const { data } = await axios.get(url, { 
        headers: { 
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Connection": "keep-alive"
        }, 
        timeout: 10000 
      });
      
      if (data.status === "OK" && Array.isArray(data.data)) {
        // Xử lý sid trước
        if (!is_md5) {
          const cmd1008 = data.data.find(game => game.cmd === 1008);
          if (cmd1008 && cmd1008.sid) {
            sid_for_tx = cmd1008.sid;
          }
        }

        // Xử lý kết quả
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
              console.log(`[MD5] Phiên ${sid} - ${d1},${d2},${d3} - Tổng: ${total}, Kết quả: ${ket_qua}`);
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
              console.log(`[TX] Phiên ${sid} - ${d1},${d2},${d3} - Tổng: ${total}, Kết quả: ${ket_qua}`);
              sid_for_tx = null;
            }
          }
        }
      }
    } catch (err) {
      console.error(`Lỗi API ${gid}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

/*-----------------------
  Routes - Giữ nguyên
-----------------------*/
app.get("/api/taixiu", (req, res) => {
  const result = { 
    ...latest_result_100, 
    du_doan: duDoan(history_100),
    so_phien_ganday: history_100.length
  };
  res.json(result);
});

app.get("/api/taixiumd5", (req, res) => {
  const result = { 
    ...latest_result_101, 
    du_doan: duDoan(history_101),
    so_phien_ganday: history_101.length
  };
  res.json(result);
});

app.get("/api/history", (req, res) => {
  res.json({ 
    taixiu: history_100, 
    taixiumd5: history_101,
    tong_so_phien: history_100.length + history_101.length
  });
});

app.get("/", (req, res) => {
  res.send("API Server for TaiXiu is running. Endpoints: /api/taixiu, /api/taixiumd5, /api/history");
});

/*-----------------------
  Start server
-----------------------*/
pollAPI("vgmn_100", false);
pollAPI("vgmn_101", true);

app.listen(PORT, () => console.log(`Server chạy trên port ${PORT}`));
