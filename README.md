# FDM Replay ✈ — จำลองการบินและวิเคราะห์ข้อมูล Flight Data (VTBS / VTBD / VTPH)

เครื่องมือเว็บสำหรับ **เล่นซ้ำ (replay) ข้อมูลการบิน** แบบ FDM/FOQA/FDAP:

- **3D flight replay** บนลูกโลก (CesiumJS) มีโมเดลเครื่องบิน เส้นทางบิน ม่านความสูง และกล้อง Chase, Cockpit, Side, Top, Overview, Free
- **PFD + ND** วาดจากค่าพารามิเตอร์จริงในไฟล์: attitude, speed/alt tape, V/S, ILS deviation, FMA, คำเตือน SINK RATE/BANK ANGLE/OVERSPEED
- **ผังสนามบินจาก AIP Thailand** (AIRAC 2026-10-29): รันเวย์ VTBS 01/19, 02L/20R, 02R/20L และ VTBD 03L/21R, 03R/21L, extended centreline และ glide path 3°
- **กราฟค่าตามเวลา** 8 แผง ซิงก์กับ timeline คลิกเพื่อกระโดดไปเวลานั้น ลากเพื่อซูม แถบสีแสดงช่วง event
- **ตรวจจับ event** อัตโนมัติ 15 ชนิด เช่น unstable approach, hard landing, long landing, high ROD, GPWS, flap overspeed, tail-strike risk, high bank และ go-around
- **ตัวช่วยนำเข้า (Import…)** CSV / Excel: ตรวจรูปแบบไฟล์เอง (แถวหัว แถวหน่วย ตัวคั่น , ; TAB) มี template สำเร็จรูปสำหรับ **Garmin G1000/G3000/G3X** และไฟล์ส่งออกจาก decoder ที่ใช้ชื่อย่อ (ALT_STD, CAS, VRTG …) จับคู่คอลัมน์และหน่วยเองได้ บันทึก template ได้ และสร้างพารามิเตอร์ที่ขาด (heading จริงจากแม่เหล็ก, ความสูงเหนือสนามจาก AIP เมื่อไม่มี radio altimeter, สถานะอากาศ/พื้น, แก้ค่า G ที่บันทึกเป็นส่วนเบี่ยง)
- **รายงานคุณภาพข้อมูล** (คะแนน 0–100): อัตราสุ่ม, ช่วงข้อมูลขาด/data recovery, แถวขาด, เวลาซ้ำ, ค่านอกช่วง, ค่าค้าง, ค่ากระโดด (ซ่อมให้), GPS หาย, ตรวจ datum ความสูงบนพื้น, ความสอดคล้อง IAS/GS และ heading/track
- **Event set ตามแบบเครื่อง** (`profiles` ใน events-config): A320 และ C172 (เครื่องฝึก G1000)
- **Routine measurements** (ICAO Doc 10000 §2.3.1) เก็บค่าจากทุกเที่ยวบิน เช่น แรง G/ระยะ/อัตราร่อนตอนแตะพื้น ความเร็วเทียบ Vapp ที่ gate
- **หน้า Fleet & trends** (`fleet.html`): KPI, อัตรา event ต่อ 1,000 เที่ยวรายเดือน, ร้อยละ unstable approach, ชนิด event, ตารางตามรันเวย์, ตัวชี้วัดของโปรแกรม (EAFDM), การกระจายของ routine measurements พร้อม "precursor band" 80–100 % ของเกณฑ์, และ **workflow ทบทวน event** (NEW → VALID/NUISANCE → ขอติดต่อลูกเรือ → gatekeeper ติดต่อแล้ว → CLOSED) พร้อมประวัติ, คัดเที่ยวบินออกจากสถิติ, investigation hold
- **เซิร์ฟเวอร์ติดตั้งเอง** (`server/fdap_server.py`, Python มาตรฐานล้วน): login, 4 บทบาท, de-identification อัตโนมัติ, audit log — ดูหัวข้อด้านล่าง
- **ส่งออก PDF และ CSV** ได้ทั้งจากเบราว์เซอร์ (PDF + snapshot 3D/PFD/ND + กราฟ, CSV ของ event, ทั้งเที่ยวบิน หรือช่วง ±60 วินาที) และจาก Python แบบ batch (`tools/analyze.py`)

> ⚠️ **ข้อมูลทั้งหมดใน repo นี้เป็นข้อมูลจำลอง (SYNTHETIC)** สร้างจาก `tools/generate.py`, `tools/gen_samples.py` และ `tools/fleet.py` ไม่ใช่ข้อมูลจริงของสายการบินหรือผู้ดำเนินการใด
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

## ไฟล์ตัวอย่างสำหรับทดสอบการนำเข้า (`data/samples/`, ข้อมูลจำลอง)

| ID | รูปแบบ | เนื้อหา | Event ที่ควรพบ |
|---|---|---|---|
| G01 | Garmin G1000 CSV (C172, 1 Hz) | บินวงจร VTPH 34 ปกติ | – |
| G02 | G1000 | วงจรที่ 2 ไม่เสถียร + ลงแรง, วงจรที่ 3 ลงไกล | UNSTABLE 500/300 ft AGL, HIGH ROD, HARD LANDING, LONG LANDING |
| G03 | G1000 | rotate แรง, steep turn ~60°, เลี้ยวเข้า final เลยแนว | PITCH, PITCH RATE, HIGH BANK, HIGH BANK < 500 ft |
| G04 | G1000 | ไฟล์มีข้อบกพร่อง: ข้อมูลขาด 9 วินาที, เวลาซ้ำ, GPS หาย, ความสูงค้าง, ค่ากระโดด, บรรทัดสุดท้ายขาด | – (คะแนนคุณภาพ ~55–60) |
| X01 | Excel .xlsx (sheet Data + แถวหน่วย) / CSV คั่นด้วย ; | ไฟล์ decoder ของ A320 ชื่อย่อ ALT_STD, CAS, VRTG, RALT, WOW | เหมือน S02 |

รูปแบบ G1000 เลียนแบบไฟล์บน SD card (หัว `#airframe_info`, แถวหน่วย, เวลา local + UTCOfst, HDG แม่เหล็ก, AltGPS อิงทรงรี WGS-84, ไม่มี radio altimeter/WOW/flap)
ข้อที่ยังไม่ได้ยืนยันกับไฟล์จริง: NormAc บันทึกเป็นค่าเบี่ยงจาก 1 g หรือค่าเต็ม — ตัวนำเข้าตรวจเองอัตโนมัติ (`g-auto`) และเครื่องหมายของ MagVar
VTPH ใช้ข้อมูล AD 2.12 จาก eAIP (THR 16 สูง 62 ft, THR 34 สูง 17 ft — รันเวย์ลาด ตัวนำเข้าคำนวณความสูงเหนือพื้นตามแนวรันเวย์)

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
python tools/selftest.py          # ตรวจว่าแต่ละฉากพบ event ตามที่คาดไว้ (รวมไฟล์ตัวอย่าง)
python tools/gen_samples.py       # สร้างไฟล์ดิบ G1000 / Excel ตัวอย่าง -> data/samples/
node tools/import_cli.js --all    # นำเข้าไฟล์ตัวอย่างด้วยโค้ดเดียวกับหน้าเว็บ -> *.normalized.csv + *.qc.json
node tools/import_cli.js my_log.csv --template g1000 --out out.csv --qc qc.json
python tools/parity.py            # ตรวจว่า JS (เว็บ) กับ Python ได้ event + measurements ตรงกันทุกเที่ยว
python tools/fleet.py             # สร้างข้อมูลฝูงบินจำลอง 12 เดือน -> data/fleet/fleet.json
python tools/server_test.py       # ทดสอบเซิร์ฟเวอร์: สิทธิ์, de-identification, review, audit
```

## เซิร์ฟเวอร์ติดตั้งเอง (login + de-identification)

GitHub Pages เป็นแค่ demo (ข้อมูลจำลอง สถานะ review เก็บในเบราว์เซอร์) ถ้าจะใช้กับข้อมูลจริงให้รันเซิร์ฟเวอร์ในเครื่องหรือในเครือข่ายขององค์กร ไม่ต้องติดตั้งแพ็กเกจเพิ่ม:

```bash
python server/fdap_server.py init                       # สร้าง server/var/ + ผู้ใช้ admin (แสดงรหัสครั้งเดียว)
python server/fdap_server.py adduser somchai gatekeeper # บทบาท: admin / gatekeeper / analyst / manager
python server/fdap_server.py serve                      # http://127.0.0.1:8780
python server/fdap_server.py seed-demo                  # (ไม่บังคับ) โหลดเที่ยวบินจำลองไว้ลองใช้
```

| บทบาท | เห็นอะไร |
|---|---|
| **gatekeeper** | ข้อมูลระบุตัว (ทะเบียน, call sign, วันเวลา) เพื่อติดต่อลูกเรือแบบลับ, บันทึก "ติดต่อลูกเรือแล้ว", ตั้ง investigation hold |
| **analyst** | ข้อมูลไม่ระบุตัว (รหัสแฝง + เดือน, CSV ไม่มีเวลาจริง), replay, นำเข้า, ทบทวน event |
| **manager** | สถิติรวมเท่านั้น (ไม่เห็นรายเที่ยวบิน ไม่เห็นรายละเอียด event) |
| **admin** | จัดการผู้ใช้ + ดู audit log (`admin.html`) |

- **De-identification อัตโนมัติ** หลังอัปโหลด `--deid-days` วัน (ค่าเริ่ม 30): ลบทะเบียน/call sign/วันเวลา/ชื่อไฟล์ และล้างคอลัมน์เวลาใน CSV แบบย้อนกลับไม่ได้ (SQLite `secure_delete`) ยกเว้นเที่ยวที่ gatekeeper ตั้ง hold (Annex 13)
- รหัสแฝงของเที่ยวบินสุ่มขึ้นใหม่ ไม่ได้คำนวณจากทะเบียนหรือวันที่
- **Audit log** ทุกการ login, อัปโหลด, ดูข้อมูล, ดูตัวตน, ทบทวน, hold, de-identify
- รหัสผ่านเก็บแบบ PBKDF2-SHA256, ล็อกบัญชี 5 นาทีหลังผิด 5 ครั้ง, session cookie HttpOnly + SameSite=Strict, POST ต้องมี header `X-FDAP` (กัน CSRF)
- ค่าเริ่มฟังเฉพาะ 127.0.0.1 ถ้าจะเปิดในเครือข่ายให้ใช้ HTTPS (`--cert/--key` หรือ reverse proxy)
- ข้อมูลอยู่ที่ `server/var/` (อยู่ใน `.gitignore`) — ห้าม commit

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
data/samples/         ไฟล์ดิบตัวอย่าง (G1000, Excel) + normalised + QC
data/fleet/fleet.json ฝูงบินจำลอง 12 เดือน (summary)
data/import-templates.json  template การจับคู่คอลัมน์
fleet.html, js/fleet.js     หน้า Fleet & trends + review
js/importer.js        แกนนำเข้า (ใช้ทั้งเว็บและ Node)
js/import-ui.js       หน้าต่าง Import
js/backend.js         demo (localStorage) / server mode
server/fdap_server.py เซิร์ฟเวอร์ติดตั้งเอง; login.html, admin.html
tools/generate.py     ตัวจำลองการบิน (point-mass + autopilot modes)
tools/analyze.py      batch report PDF/CSV (matplotlib)
tools/fdm_common.py   geometry + event detection (Python)
reports/              รายงานที่สร้างไว้แล้ว
```

## Credits
CesiumJS (Apache-2.0), uPlot (MIT), PapaParse (MIT), SheetJS Community Edition (Apache-2.0, โหลดเมื่อเปิดไฟล์ Excel), jsPDF (MIT), jsPDF-AutoTable (MIT), โมเดล Cesium Air จาก Cesium sample data,
แผนที่ © OpenStreetMap contributors / Esri, ข้อมูลรันเวย์จาก AIP Thailand (CAAT) · License: MIT
