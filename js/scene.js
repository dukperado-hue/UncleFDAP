// CesiumJS 3D scene: aircraft model, flight path, airport runways and glide paths.
(function (global) {
  'use strict';
  const D2R = Math.PI / 180;
  const FT = 0.3048;
  const MODEL_URL = 'https://cdn.jsdelivr.net/gh/CesiumGS/cesium@1.120/Apps/SampleData/models/CesiumAir/Cesium_Air.glb';
  const LEVEL_COL = { 1: '#38d9f5', 2: '#ffb000', 3: '#ff3b3b' };

  const Scene = {
    viewer: null, pose: null, flightEntities: [], camMode: 'chase', geoidM: 0, terrainOn: false,

    init(containerId, { imagery = 'osm', ionToken = '' } = {}) {
      if (!global.Cesium) throw new Error('CesiumJS failed to load');
      Cesium.Ion.defaultAccessToken = ionToken || '';
      const base = this.imageryProvider(imagery);
      const opts = {
        baseLayer: new Cesium.ImageryLayer(base),
        baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
        navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
        infoBox: false, selectionIndicator: false, shouldAnimate: false,
        contextOptions: { webgl: { preserveDrawingBuffer: true } },
      };
      if (ionToken) { opts.terrain = Cesium.Terrain.fromWorldTerrain(); this.terrainOn = true; }
      this.viewer = new Cesium.Viewer(containerId, opts);
      const sc = this.viewer.scene;
      sc.globe.depthTestAgainstTerrain = false;
      sc.globe.enableLighting = false;
      sc.skyAtmosphere.show = true;
      sc.fog.enabled = true;
      sc.screenSpaceCameraController.enableCollisionDetection = true;
      this.viewer.cesiumWidget.creditContainer.style.fontSize = '9px';

      const self = this;
      this.aircraft = this.viewer.entities.add({
        position: new Cesium.CallbackProperty(() => self.pose && self.pose.pos, false),
        orientation: new Cesium.CallbackProperty(() => self.pose && self.pose.q, false),
        model: { uri: MODEL_URL, minimumPixelSize: 56, maximumScale: 400, scale: 2.0,
          silhouetteColor: Cesium.Color.fromCssColorString('#ffb000'), silhouetteSize: 1.2 },
      });
      return this;
    },

    imageryProvider(kind) {
      if (kind === 'esri') {
        return new Cesium.UrlTemplateImageryProvider({
          url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          credit: 'Imagery © Esri, Maxar, Earthstar Geographics', maximumLevel: 19 });
      }
      return new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' });
    },

    setImagery(kind) {
      const layers = this.viewer.imageryLayers;
      layers.removeAll();
      layers.addImageryProvider(this.imageryProvider(kind));
    },

    h(altFt) { return altFt * FT + (this.terrainOn ? this.geoidM : 0); },

    clearFlight() {
      for (const e of this.flightEntities) this.viewer.entities.remove(e);
      this.flightEntities = [];
    },

    add(e) { const ent = this.viewer.entities.add(e); this.flightEntities.push(ent); return ent; },

    drawAirports(airports) {
      for (const ap of Object.values(airports)) {
        const fr = new FDM.Frame(ap.lat, ap.lon);
        const done = new Set();
        for (const rw of Object.values(ap.runways)) {
          if (rw.endLat == null) continue;
          const key = [rw.id, rw.pair].sort().join('/');
          if (!done.has(key)) {
            done.add(key);
            const [x1, y1] = fr.toXY(rw.lat, rw.lon), [x2, y2] = fr.toXY(rw.endLat, rw.endLon);
            const L = Math.hypot(x2 - x1, y2 - y1), nx = -(y2 - y1) / L * rw.width_m / 2, ny = (x2 - x1) / L * rw.width_m / 2;
            const corners = [[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]]
              .map(([x, y]) => fr.toLL(x, y)).flatMap(([la, lo]) => [lo, la]);
            this.viewer.entities.add({ polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(corners),
              material: Cesium.Color.fromCssColorString('#2b2f36').withAlpha(0.92), height: 0.5,
              outline: true, outlineColor: Cesium.Color.WHITE } });
            this.viewer.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArrayHeights([rw.lon, rw.lat, 1, rw.endLon, rw.endLat, 1]),
              width: 2, material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.WHITE, dashLength: 24 }) } });
          }
          const c = rw.true_brg * D2R, frT = new FDM.Frame(rw.lat, rw.lon);
          const [llat, llon] = frT.toLL(Math.sin(c) * 120, Math.cos(c) * 120);
          this.viewer.entities.add({ position: Cesium.Cartesian3.fromDegrees(llon, llat, 3),
            label: { text: rw.id, font: '600 14px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK,
              outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 25000) } });
          if (rw.ils_loc_mhz) {
            // extended centreline on the ground + 3 deg glide path in the air (10 NM)
            const D = 10 * 1852, gp = 300;
            const [g0lat, g0lon] = frT.toLL(Math.sin(c) * gp, Math.cos(c) * gp);
            const [elat, elon] = frT.toLL(-Math.sin(c) * D, -Math.cos(c) * D);
            const hEnd = (D + gp) * Math.tan((rw.gp_deg || 3) * D2R);
            this.viewer.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArrayHeights([rw.lon, rw.lat, 1, elon, elat, 1]),
              width: 1, material: Cesium.Color.fromCssColorString('#38d9f5').withAlpha(0.5) } });
            this.viewer.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArrayHeights([g0lon, g0lat, 15, elon, elat, hEnd + this.h(rw.thr_elev_ft)]),
              width: 2, material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.fromCssColorString('#ff5cf0').withAlpha(0.8), dashLength: 32 }) } });
          }
        }
        this.viewer.entities.add({ position: Cesium.Cartesian3.fromDegrees(ap.lon, ap.lat, 30),
          label: { text: `${ap.icao} ${ap.name}`, font: '700 16px sans-serif', fillColor: Cesium.Color.fromCssColorString('#38d9f5'),
            outlineColor: Cesium.Color.BLACK, outlineWidth: 4, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(2000, 400000) } });
      }
    },

    loadFlight(rows, events, geoidM) {
      this.clearFlight();
      this.geoidM = geoidM || 0;
      this.rows = rows;
      const step = Math.max(1, Math.floor(rows.length / 2500));
      const pts = [];
      for (let i = 0; i < rows.length; i += step) pts.push(rows[i]);
      this.pathCart = pts.map(r => Cesium.Cartesian3.fromDegrees(r.lon, r.lat, this.h(r.alt_ft)));
      this.pathIdx = pts.map((r, k) => k * step);
      this.add({ polyline: { positions: this.pathCart, width: 3, material: new Cesium.PolylineOutlineMaterialProperty({ color: Cesium.Color.fromCssColorString('#38d9f5').withAlpha(0.9), outlineColor: Cesium.Color.fromCssColorString('#0b2540'), outlineWidth: 1 }) } });
      const self = this;
      this.add({ polyline: { positions: new Cesium.CallbackProperty(() => {
        const n = Math.max(2, Math.ceil((self.curIdx || 0) / step) + 1);
        return self.pathCart.slice(0, n);
      }, false), width: 3, material: new Cesium.PolylineGlowMaterialProperty({ color: Cesium.Color.fromCssColorString('#ffb000'), glowPower: 0.15 }) } });
      // curtain to the ground
      const wallPts = pts.filter((_, k) => k % 2 === 0);
      this.add({ wall: { positions: wallPts.map(r => Cesium.Cartesian3.fromDegrees(r.lon, r.lat, this.h(r.alt_ft))),
        minimumHeights: wallPts.map(() => this.terrainOn ? this.geoidM : 0),
        material: Cesium.Color.fromCssColorString('#38d9f5').withAlpha(0.12) } });
      // event markers
      for (const e of events) {
        const r = rows[e.idx]; if (!r) continue;
        const col = Cesium.Color.fromCssColorString(LEVEL_COL[e.level] || '#fff');
        this.add({ position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, this.h(r.alt_ft)),
          point: { pixelSize: 11, color: col, outlineColor: Cesium.Color.BLACK, outlineWidth: 2 },
          label: { text: e.code.replace(/_/g, ' '), font: '600 12px sans-serif', fillColor: col, outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -18),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 30000) } });
      }
      this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    },

    update(r, idx) {
      this.curIdx = idx;
      const pos = Cesium.Cartesian3.fromDegrees(r.lon, r.lat, this.h(r.alt_ft) + (r.air_ground >= 0.5 ? 0 : 2));
      const hpr = new Cesium.HeadingPitchRoll(r.hdg_true_deg * D2R - Math.PI / 2, r.pitch_deg * D2R, r.roll_deg * D2R);
      this.pose = { pos, q: Cesium.Transforms.headingPitchRollQuaternion(pos, hpr), r };
      this.updateCamera();
      this.viewer.scene.requestRender();
    },

    setCamera(mode) {
      this.camMode = mode;
      this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      if (mode === 'overview' && this.pathCart) {
        this.viewer.camera.flyToBoundingSphere(Cesium.BoundingSphere.fromPoints(this.pathCart), {
          duration: 1.2, offset: new Cesium.HeadingPitchRange(0, -60 * D2R, Cesium.BoundingSphere.fromPoints(this.pathCart).radius * 2.4) });
      }
      this.updateCamera();
    },

    updateCamera() {
      const p = this.pose; if (!p) return;
      const r = p.r, cam = this.viewer.camera, hd = r.hdg_true_deg * D2R;
      switch (this.camMode) {
        case 'chase': cam.lookAt(p.pos, new Cesium.HeadingPitchRange(hd, -10 * D2R, 260)); break;
        case 'side': cam.lookAt(p.pos, new Cesium.HeadingPitchRange(hd - Math.PI / 2, -4 * D2R, 380)); break;
        case 'top': cam.lookAt(p.pos, new Cesium.HeadingPitchRange(hd, -89.9 * D2R, 2500)); break;
        case 'cockpit': {
          cam.lookAtTransform(Cesium.Matrix4.IDENTITY);
          const fwd = new FDM.Frame(r.lat, r.lon).toLL(Math.sin(hd) * 18, Math.cos(hd) * 18);
          cam.setView({ destination: Cesium.Cartesian3.fromDegrees(fwd[1], fwd[0], this.h(r.alt_ft) + 4),
            orientation: { heading: hd, pitch: (r.pitch_deg - 2) * D2R, roll: r.roll_deg * D2R } });
          break;
        }
        default: break; // 'free' / 'overview': user controls the camera
      }
    },

    snapshot() {
      this.viewer.render();
      return this.viewer.scene.canvas.toDataURL('image/jpeg', 0.85);
    },
  };

  global.Scene = Scene;
})(window);
