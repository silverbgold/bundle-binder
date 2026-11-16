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
  // the card turned by `turn` degrees (0, 90, -90), scaled so it is `tall` pixels high, optionally cropped to a band
  function upright(im, turn, tall, band) {
    var w = im.naturalWidth, h = im.naturalHeight, ow = turn ? h : w, oh = turn ? w : h;
    var y0 = band ? band[0] * oh : 0, y1 = band ? band[1] * oh : oh, sc = tall / (y1 - y0);
    var cv = document.createElement("canvas"); cv.width = Math.round(ow * sc); cv.height = Math.round((y1 - y0) * sc);
    var cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
    cx.setTransform(sc, 0, 0, sc, 0, -y0 * sc); cx.translate(ow / 2, oh / 2); cx.rotate(turn * Math.PI / 180); cx.drawImage(im, -w / 2, -h / 2);
    return cv;
  }
  // mode "gray": dark text as is.  mode "white": keep only bright, colourless pixels (white lettering on coloured banners)
  function filter(cv, mode, level) {
    var cx = cv.getContext("2d"), d = cx.getImageData(0, 0, cv.width, cv.height), p = d.data;
    for (var i = 0; i < p.length; i += 4) {
      var mx = Math.max(p[i], p[i + 1], p[i + 2]), mn = Math.min(p[i], p[i + 1], p[i + 2]), g;
      if (mode === "white") g = (mn > level && mx - mn < 70) ? 0 : 255;
      else g = 0.3 * p[i] + 0.59 * p[i + 1] + 0.11 * p[i + 2];
      p[i] = p[i + 1] = p[i + 2] = g;
    }
    cx.putImageData(d, 0, 0);
    return cv;
  }

  var SMALL = { of: 1, the: 1, and: 1, a: 1, an: 1, to: 1, in: 1, on: 1, at: 1, for: 1, de: 1 };
  var TYPE_WORDS = /^(action|location|item|character|song|trainer|energy|supporter|stadium|creature|instant|sorcery|artifact|enchantment|land|planeswalker|basic|stage|hp|lv|rookie|rc|auto|autograph|base|insert)$/i;
  function titleCase(words) {
    return words.map(function (wd, i) {
      if (wd !== wd.toUpperCase()) return wd;                       // already mixed case: keep
      var lw = wd.toLowerCase();
      if (i > 0 && SMALL[lw]) return lw;
      return lw.replace(/(^|[-'’.])([a-z])/g, function (m0, a, b) { return a + b.toUpperCase(); });
    }).join(" ");
  }
  // the longest run of real words in a line ("GRAMMA TALA © 3" → ["GRAMMA", "TALA"])
  function wordRun(text) {
    var toks = String(text || "").replace(/[|\\_~^*<>{}\[\]=+"“”«»©®°]/g, " ").split(/\s+/), best = [], cur = [];
    toks.forEach(function (t) {
      var core = t.replace(/^[^A-Za-z]+|[^A-Za-z!?.'’]+$/g, "");
      var ok = /^[A-Za-z][A-Za-z'’.-]*[A-Za-z!?.]?$/.test(core) && (core.replace(/[^A-Za-z]/g, "").length >= 2 || /^[AI]$/.test(core) || core === "-");
      if (ok) cur.push(core); else { if (cur.length > best.length) best = cur; cur = []; }
    });
    if (cur.length > best.length) best = cur;
    if (best.length >= 3 && best[0].length === 1) best.shift();          // a stray letter from the banner's edge
    while (best.length && (best[0] === "-" || SMALL[best[0].toLowerCase()] && best.length > 1 && best[0] === best[0].toLowerCase())) best.shift();
    while (best.length && best[best.length - 1] === "-") best.pop();
    return best;
  }
  // what's behind white lettering: a coloured banner (names) or a black label box (ability names)
  function onBlackBox(col, bb) {
    var cx = col.getContext("2d"), x0 = Math.max(0, bb.x0 | 0), y0 = Math.max(0, bb.y0 | 0), ww = Math.min(col.width, bb.x1 | 0) - x0, hh = Math.min(col.height, bb.y1 | 0) - y0;
    if (ww < 4 || hh < 4) return false;
    var p = cx.getImageData(x0, y0, ww, hh).data, n = 0, lum = 0, sat = 0;
    for (var i = 0; i < p.length; i += 16) {
      var mx = Math.max(p[i], p[i + 1], p[i + 2]), mn = Math.min(p[i], p[i + 1], p[i + 2]);
      if (mn > 150) continue;                                         // the letters themselves
      n++; lum += 0.3 * p[i] + 0.59 * p[i + 1] + 0.11 * p[i + 2]; sat += mx - mn;
    }
    return n > 10 && lum / n < 145 && sat / n < 45;            // grey, colourless box (names sit on coloured banners)
  }
  function nameCandidates(lines, H, src, col) {
    var out = [];
    lines.forEach(function (l) {
      if (l.confidence < 60) return;
      if (src === "white" && col && onBlackBox(col, l.bbox)) return;
      var run = wordRun(l.text);
      while (run.length > 1 && TYPE_WORDS.test(run[run.length - 1])) run.pop();   // "Pikachu HP" → "Pikachu"
      while (run.length > 1 && TYPE_WORDS.test(run[0])) run.shift();
      var letters = run.join("").replace(/[^A-Za-z]/g, "").length;
      if (letters < 4 || run.length > 7) return;
      if (run.length === 1 && TYPE_WORDS.test(run[0])) return;
      if (run.every(function (wd) { return TYPE_WORDS.test(wd) || SMALL[wd.toLowerCase()]; })) return;
      var height = (l.bbox.y1 - l.bbox.y0) / H;
      // names are the biggest print on a card; rules text is small, and long sentences aren't names
      var lower = run.filter(function (wd) { return /^[a-z]/.test(wd); }).length;
      if (lower > 1 && run.length > 3) return;
      out.push({ words: run, score: height * 1000 * (l.confidence / 100) + (run.length >= 2 ? 4 : 0), conf: l.confidence, src: src, y: l.bbox.y0 / H, y1: l.bbox.y1 / H, h: height });
    });
    return out;
  }
  // "142/204" → "142". Tiny print often loses digits ("2/204"), so a number that looks cut short is left blank.
  function pickNumber(text) {
    var all = String(text).match(/\b\d{1,4}\s*\/\s*\d{2,4}\b/g) || [], best = "";
    all.forEach(function (m0) {
      var pr = m0.split("/"), a = pr[0].trim(), b = pr[1].trim();
      if (+a > +b * 2 + 50 || a.length < b.length) return;          // "19/204" is a misread of 1?9/204: skip it
      if (a.length > best.length) best = a;
    });
    if (best) return String(+best);
    var m = String(text).match(/(?:#|\bNo\.)\s?(\d{2,4})\b/i);
    return m ? m[1] : "";
  }
  function goodWords(lines) {
    var n = 0;
    lines.forEach(function (l) { (l.words || []).forEach(function (wd) { if (wd.confidence > 80 && /^[A-Za-z]{3,}[.,]?$/.test(wd.text)) n++; }); });
    return n;
  }

  async function read(blob) {
    var worker = await getWorker(), im = await loadImage(blob);
    // 1. which way up? the turn that gives the most clearly readable words (rules text) wins
    var turns = [0, 90, -90], bestTurn = 0, bestN = -1;
    for (var i = 0; i < turns.length; i++) {
      var q = await worker.recognize(filter(upright(im, turns[i], 800), "gray"));
      var n = goodWords((q.data && q.data.lines) || []);
      if (n > bestN) { bestN = n; bestTurn = turns[i]; }
      if (i === 0 && n >= 12) break;                                  // clearly upright already
    }
    // 2. read dark text and white lettering, collect name candidates
    var cands = [], allText = "", col = upright(im, bestTurn, 1400);
    var passes = [["gray"], ["white", 150], ["white", 185]];
    for (var j = 0; j < passes.length; j++) {
      var cv = filter(upright(im, bestTurn, 1400), passes[j][0], passes[j][1]);
      var r = await worker.recognize(cv), d = r.data || {};
      allText += "\n" + (d.text || "");
      cands = cands.concat(nameCandidates(d.lines || [], cv.height, passes[j][0], col));
    }
    cands.sort(function (a, b) { return b.score - a.score; });
    // name-sized print only: ability labels and rules text are smaller, and a blank name beats a wrong one
    var best = cands[0] && cands[0].score >= 30 ? cands[0] : null, name = "";
    if (best) {
      name = titleCase(best.words);
      // a subtitle printed just under the name (e.g. "Keeper of Ancient Stories")
      var sub = cands.filter(function (c) {
        return c !== best && c.src === best.src && c.y >= best.y1 - 0.005 && c.y <= best.y1 + best.h * 0.9 && c.h < best.h * 0.8 && c.h > best.h * 0.3 && c.conf >= 60 && c.words.length >= 2;
      })[0];
      if (sub) {
        var sw = sub.words.slice(); while (sw.length > 2 && sw[sw.length - 1].replace(/[^A-Za-z]/g, "").length <= 2) sw.pop();
        name += " - " + titleCase(sw);
      }
    }
    // 3. the card number is tiny print along the bottom: read that strip zoomed in (two framings)
    var number = pickNumber(allText);
    var bands = [[260, [0.86, 1]], [360, [0.8, 1]]];
    for (var b = 0; b < bands.length && !number; b++) {
      var strip = await worker.recognize(filter(upright(im, bestTurn, bands[b][0], bands[b][1]), "gray"));
      number = pickNumber((strip.data && strip.data.text) || "");
    }
    return { name: name.slice(0, 80), number: number, confidence: best ? Math.round(best.conf) : 0, turn: bestTurn };
  }

  window.BBOcr = {
    // one card at a time, so a big batch doesn't freeze the page
    read: function (blob) { var p = queue.then(function () { return read(blob); }); queue = p.catch(function () {}); return p; },
    warmUp: function () { return getWorker().then(function () {}); }
  };
})();
