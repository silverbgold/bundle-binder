// Free card-name reading in the browser (Tesseract OCR). Nothing is sent to any server:
// the reader downloads once (about 10 MB, then cached) and runs on this computer.
// BBOcr.read(blobOrFile) → { name, number, confidence } (empty strings when it isn't sure)
(function () {
  var LIB = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  var PATHS = {
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1",
    langPath: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int"
  };
  var workerP = null, queue = Promise.resolve();

  function loadLib() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = LIB; s.onload = res;
      s.onerror = function () { rej(new Error("Couldn’t download the name reader. Check your internet connection.")); };
      document.head.appendChild(s);
    });
  }
  function getWorker() {
    if (!workerP) workerP = loadLib().then(function () { return window.Tesseract.createWorker("eng", 1, PATHS); })
      .catch(function (e) { workerP = null; throw e; });
    return workerP;
  }

  async function loadImage(blob) {
    var url = URL.createObjectURL(blob), im = new Image();
    try { await new Promise(function (res, rej) { im.onload = res; im.onerror = function () { rej(new Error("That photo couldn’t be opened.")); }; im.src = url; }); }
    finally { setTimeout(function () { URL.revokeObjectURL(url); }, 0); }
    return im;
  }
  // upright, grey, 1000px tall canvas; turn = 0, 90 or -90 degrees
  function prepare(im, turn) {
    var w = im.naturalWidth, h = im.naturalHeight, side = turn ? [h, w] : [w, h], sc = 1000 / side[1];
    var cv = document.createElement("canvas"); cv.width = Math.round(side[0] * sc); cv.height = 1000;
    var cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
    cx.translate(cv.width / 2, cv.height / 2); cx.rotate(turn * Math.PI / 180); cx.scale(sc, sc); cx.drawImage(im, -w / 2, -h / 2);
    var d = cx.getImageData(0, 0, cv.width, cv.height), p = d.data;
    for (var i = 0; i < p.length; i += 4) { var g = 0.3 * p[i] + 0.59 * p[i + 1] + 0.11 * p[i + 2]; p[i] = p[i + 1] = p[i + 2] = g; }
    cx.setTransform(1, 0, 0, 1, 0, 0); cx.putImageData(d, 0, 0);
    return cv;
  }

  function cleanName(t) {
    t = String(t || "").replace(/[|_~^*<>{}\[\]\\=+"“”«»]/g, " ").replace(/\s+/g, " ").trim();
    t = t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9!?.)]+$/g, "").trim();
    // drop things printed on the same line as the name: "HP 60", "60 HP", a mana or ink cost
    t = t.replace(/\s+(HP\s*\d{1,3}|\d{1,3}\s*HP)$/i, "").replace(/\s+\d{1,2}$/, "").replace(/^\d{1,2}\s+(?=[A-Za-z])/, "").trim();
    return t;
  }
  function letters(t) { return (t.match(/[A-Za-z]/g) || []).length; }
  function pickName(lines, H) {
    var best = null;
    lines.forEach(function (l) {
      var t = cleanName(l.text), n = letters(t);
      if (n < 3 || t.length > 60 || n / Math.max(1, t.replace(/\s/g, "").length) < 0.6) return;
      if (l.bbox.y0 > 0.35 * H || l.confidence < 55) return;
      if (/^(hp|lv|stage|basic|trainer|energy|item|supporter|creature|instant|sorcery|artifact|enchantment|legendary)\b/i.test(t) && t.split(" ").length <= 2) return;
      // prefer the top-most confident line; among close ones, the taller (bigger print) one
      var height = l.bbox.y1 - l.bbox.y0, score = l.confidence + height * 0.8 - l.bbox.y0 / H * 60;
      if (!best || score > best.score) best = { text: t, score: score, conf: l.confidence };
    });
    return best;
  }
  function pickNumber(text) {
    var m = String(text).match(/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/);
    if (m && +m[1] <= +m[2] * 2 + 50) return m[1];
    m = String(text).match(/(?:#|No\.?\s)\s?(\d{1,4})\b/i);
    return m ? m[1] : "";
  }

  async function readOnce(worker, cv) {
    var r = await worker.recognize(cv), d = r.data || {}, lines = d.lines || [];
    var mean = lines.length ? lines.reduce(function (t, l) { return t + l.confidence; }, 0) / lines.length : 0;
    return { lines: lines, text: d.text || "", mean: mean, H: cv.height };
  }

  async function read(blob) {
    var worker = await getWorker(), im = await loadImage(blob);
    var turns = im.naturalWidth > im.naturalHeight * 1.1 ? [90, -90] : [0];
    var best = null;
    for (var i = 0; i < turns.length; i++) {
      var res = await readOnce(worker, prepare(im, turns[i]));
      if (!best || res.mean > best.mean) best = res;
    }
    var nm = pickName(best.lines, best.H);
    return { name: nm ? nm.text : "", number: pickNumber(best.text), confidence: nm ? Math.round(nm.conf) : 0 };
  }

  window.BBOcr = {
    // one card at a time, so a big batch doesn't freeze the page
    read: function (blob) { var p = queue.then(function () { return read(blob); }); queue = p.catch(function () {}); return p; },
    warmUp: function () { return getWorker().then(function () {}); }
  };
})();
