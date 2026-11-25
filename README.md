# FDM Replay ✈ — จำลองการบินจากข้อมูล Flight Data (VTBS / VTBD)

เครื่องมือเว็บสำหรับ **เล่นซ้ำ (replay) ข้อมูลการบิน** แบบ FDM/FOQA/FDAP:

- **3D flight replay** บนลูกโลก (CesiumJS) มีโมเดลเครื่องบิน เส้นทางบิน ม่านความสูง และกล้อง Chase, Cockpit, Side, Top, Overview, Free
- **PFD + ND** วาดจากค่าพารามิเตอร์จริงในไฟล์: attitude, speed/alt tape, V/S, ILS deviation, FMA, คำเตือน SINK RATE/BANK ANGLE/OVERSPEED
- **ผังสนามบินจาก AIP Thailand** (AIRAC 2026-10-29): รันเวย์ VTBS 01/19, 02L/20R, 02R/20L และ VTBD 03L/21R, 03R/21L, extended centreline และ glide path 3°
- **กราฟค่าตามเวลา** 8 แผง ซิงก์กับ timeline คลิกเพื่อกระโดดไปเวลานั้น ลากเพื่อซูม แถบสีแสดงช่วง event
- **ตรวจจับ event** อัตโนมัติ 15 ชนิด เช่น unstable approach, hard landing, long landing, high ROD, GPWS, flap overspeed, tail-strike risk, high bank และ go-around
- **ส่งออก PDF และ CSV** ได้ทั้งจากเบราว์เซอร์ (PDF + snapshot 3D/PFD/ND + กราฟ, CSV ของ event, ทั้งเที่ยวบิน หรือช่วง ±60 วินาที) และจาก Python แบบ batch (`tools/analyze.py`)

> ⚠️ **ข้อมูลทั้งหมดใน repo นี้เป็นข้อมูลจำลอง (SYNTHETIC)** สร้างจาก `tools/generate.py` ไม่ใช่ข้อมูลจริงของสายการบินหรือผู้ดำเนินการใด
> ข้อมูลสนามบินคัดลอกจาก AIP เพื่อการสาธิตเท่านั้น **ห้ามใช้เพื่อการเดินอากาศ**

## ฉากจำลอง (scenarios)

| ID | สนามบิน/RWY | เหตุการณ์ | Event ที่ควรพบ |
|---|---|---|---|
| S01 | VTBS 19 | ขาเข้าปกติ (baseline) | – |
| S02 | VTBD 21R | บินเข้าเร็ว/สูง แฟลปไม่ครบ ร่อนชัน แต่ยังลงต่อ | UNSTABLE 1000/500, HIGH ROD, GS DEV, LONG LANDING |
| S03 | VTBS 01 | flare ช้า แตะพื้น ~950 fpm | HARD LANDING (1.9 g) |
| S04 | VTBD 03L | ลมขวาง 110/18 ไม่ตรงแนว LOC → go-around → บินวงจรแล้วลง | LOC DEV, UNSTABLE 1000, GO AROUND |
| S05 | VTBS 20L | rotate เร็ว 5°/s, pitch ขณะยกตัว ~11°, เลี้ยว 38° | PITCH RATE, PITCH AT LIFT-OFF, HIGH BANK |
| S06 | VTBS 02L | เก็บแฟลปช้า + เร็วเกิน 250 kt ต่ำกว่า FL100 | FLAP OVERSPEED, 250 KT |
| S07 | VTBD 21L | ร่อนชันจน GPWS SINK RATE + จัดแนวรันเวย์ช้า | GPWS, HIGH ROD, LOC/GS DEV, HIGH BANK <500 ft, UNSTABLE |
| S08 | VTBD 21R | ขาออกปกติ (baseline) | – |

## วิธีใช้

**ออนไลน์:** เปิดหน้า GitHub Pages ของ repo นี้ แล้วเลือกเที่ยวบินจากเมนู หรือกด **Open CSV…** หรือลากไฟล์ CSV ของคุณมาวางบนหน้าเว็บ
ไฟล์ที่เปิดจะถูกประมวลผลในเบราว์เซอร์เท่านั้น **ไม่ได้อัปโหลดไปที่ใด**

**ในเครื่อง (ออฟไลน์ ยกเว้น CDN และแผนที่):**
```bash
python -m http.server 8000      # แล้วเปิด http://localhost:8000
```

ปุ่มลัด: `Space` เล่น/หยุด · `←/→` ถอย/เดินหน้า 5 วินาที (`Shift` = 30 วินาที)

### สร้างข้อมูลจำลองใหม่และออกรายงาน
```bash
pip install matplotlib            # PyMuPDF ไม่จำเป็น
python tools/generate.py          # -> data/flights/*.csv + index.json
python tools/analyze.py           # -> reports/<id>_report.pdf, <id>_events.csv, summary_events.csv
python tools/analyze.py my.csv    # วิเคราะห์ไฟล์ CSV ใดก็ได้
python tools/selftest.py          # ตรวจว่าแต่ละฉากพบ event ตามที่คาดไว้
```

## รูปแบบ CSV

แถวละหนึ่งเวลา (demo ใช้ 2 Hz) หัวคอลัมน์ต้องตรงตามชื่อด้านล่าง (ถ้าใช้ข้อมูลจริง ให้ map ชื่อพารามิเตอร์จาก FDAP มาเป็นชื่อเหล่านี้ก่อน)

| คอลัมน์ | หน่วย | จำเป็น |
|---|---|---|
| `time_s` | วินาที | ✅ |
| `lat`, `lon` | องศา WGS-84 | ✅ |
| `alt_ft` | ft (pressure/MSL) | ✅ |
| `ias_kt` | kt | ✅ |
| `pitch_deg`, `roll_deg` | องศา (เงยหัว +, เอียงขวา +) | ✅ |
| `hdg_true_deg` | องศาจริง | ✅ |
| `ra_ft`, `gs_kt`, `tas_kt`, `vs_fpm`, `nz_g`, `aoa_deg`, `trk_true_deg`, `hdg_mag_deg`, `mach` | | แนะนำ |
| `flap` (0–4, 4 = FULL), `gear` (0/1), `ap`, `athr`, `air_ground` (1 = airborne), `gpws_warn`, `rev` | discrete | แนะนำ |
| `loc_dev_dot`, `gs_dev_dot` | dot (+ = ขวา/สูงกว่า) | แนะนำ |
| `n1_1`, `n1_2`, `wind_dir_deg`, `wind_spd_kt`, `sat_c`, `utc`, `phase` | | ไม่บังคับ |

เกณฑ์ event อยู่ใน [`data/events-config.json`](data/events-config.json) ใช้ร่วมกันทั้ง `js/events.js` (เว็บ) และ `tools/fdm_common.py` (Python) ทั้งสองฝั่งตรวจแล้วได้ผลตรงกันทั้ง 8 ฉาก
ค่าในไฟล์เป็นค่าตัวอย่างทั่วไป ไม่ใช่ event set ที่ได้รับอนุมัติของผู้ดำเนินการรายใด

## ข้อมูลจริง → repo ส่วนตัว

ข้อมูล FDAP จริงได้รับความคุ้มครองตาม ICAO Annex 19 (safety data & safety information protection):

1. ใช้ repo นี้เป็นต้นแบบ แล้วสร้าง repo **private** แยก หรือเปิด `index.html` ในเครื่องโดยไม่ต้องขึ้น GitHub เลย
2. วางไฟล์จริงไว้ใน `private/` (อยู่ใน `.gitignore` แล้ว) แล้วใช้ **Open CSV…** เพื่อเปิด ไม่ต้อง commit
3. ตัดทะเบียนเครื่อง เที่ยวบิน วันที่ และข้อมูลระบุตัวลูกเรือออกก่อนนำไปใช้สาธิต
4. CesiumJS และแผนที่โหลดจาก CDN/tile server แต่ข้อมูลการบินไม่ถูกส่งออกไป ถ้าต้องการออฟไลน์ 100% ให้ดาวน์โหลดไลบรารีมาไว้ในเครื่อง

## โครงสร้าง
```
index.html            หน้าเว็บ (GitHub Pages)
js/app.js             controller: โหลดข้อมูล, playback, wiring
js/scene.js           CesiumJS 3D (model, path, runways, glide path)
js/instruments.js     PFD + ND (canvas)
js/charts.js          uPlot charts + event bands
js/events.js          FDM event detection (JS)
js/export.js          CSV / PDF (jsPDF)
data/airports.json    AIP Thailand AD 2.2/2.12/2.19 (VTBS, VTBD)
data/events-config.json   เกณฑ์ event
data/flights/         ข้อมูลจำลอง CSV + index.json
tools/generate.py     ตัวจำลองการบิน (point-mass + autopilot modes)
tools/analyze.py      batch report PDF/CSV (matplotlib)
tools/fdm_common.py   geometry + event detection (Python)
reports/              รายงานที่สร้างไว้แล้ว
```

## Credits
CesiumJS (Apache-2.0), uPlot (MIT), PapaParse (MIT), jsPDF (MIT), jsPDF-AutoTable (MIT), โมเดล Cesium Air จาก Cesium sample data,
แผนที่ © OpenStreetMap contributors / Esri, ข้อมูลรันเวย์จาก AIP Thailand (CAAT) · License: MIT
