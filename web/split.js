// Seller dashboard: split one photo of many cards into separate listings.
// Finds each card (even tilted or sideways), lets the seller fix the boxes, then cuts out and straightens every card.
(function () {
function gridBoxes(sp, r, c, area){
  var out = [], gw = area.w / c, gh = area.h / r, pad = 0.04;
  for (var i=0;i<r;i++) for (var j=0;j<c;j++) out.push({ cx: (area.x + (j + 0.5) * gw) * sp.W, cy: (area.y + (i + 0.5) * gh) * sp.H, w: gw * (1 - pad) * sp.W, h: gh * (1 - pad) * sp.H, a: 0, r: 0 });
  return out;
}
function readingOrder(bx){
  var arr = bx.slice().sort(function(a, b){ return a.cy - b.cy; }), rows = [];
  arr.forEach(function(b){ var row = rows.find(function(r){ return Math.abs(r.cy - b.cy) < Math.min(r.s, Math.min(b.w, b.h)) * 0.5; }); if (row) row.items.push(b); else rows.push({ cy: b.cy, s: Math.min(b.w, b.h), items: [b] }); });
  var out = []; rows.forEach(function(r){ r.items.sort(function(a, b){ return a.cx - b.cx; }).forEach(function(b){ out.push(b); }); });
  return out;
}
function detectBoxes(img){
  var W = img.naturalWidth, H = img.naturalHeight, sc = Math.min(1, 560 / Math.max(W, H)), w = Math.max(8, Math.round(W*sc)), h = Math.max(8, Math.round(H*sc));
  var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  var cx = cv.getContext("2d"); cx.drawImage(img, 0, 0, w, h);
  var d = cx.getImageData(0, 0, w, h).data, R = [], G = [], B = [], gray = new Float32Array(w*h);
  for (var i0=0, k0=0; i0<d.length; i0+=4, k0++) gray[k0] = 0.3*d[i0] + 0.59*d[i0+1] + 0.11*d[i0+2];
  var take = function(x, y){ var i = (y*w + x)*4; R.push(d[i]); G.push(d[i+1]); B.push(d[i+2]); };
  for (var x=0;x<w;x+=2){ take(x, 0); take(x, 1); take(x, h-1); take(x, h-2); }
  for (var y=0;y<h;y+=2){ take(0, y); take(1, y); take(w-1, y); take(w-2, y); }
  var med = function(a){ var b = a.slice().sort(function(p, q){ return p - q; }); return b[b.length >> 1]; };
  var br = med(R), bgc = med(G), bb = med(B);
  var spread = R.map(function(v, k){ return Math.abs(v - br) + Math.abs(G[k] - bgc) + Math.abs(B[k] - bb); }).sort(function(p, q){ return p - q; });
  var T = Math.min(150, Math.max(45, spread[Math.floor(spread.length * 0.5)] * 2.5 + 25));
  var m = new Uint8Array(w*h);
  var darkTable = 0.3*br + 0.59*bgc + 0.11*bb < 70;   // a near-black table (darker than any card border)
  if (darkTable) {
    // dark table: compare each pixel with the darkest table nearby, so lamp glare and reflections on the table
    // (which are only a little lighter than the table) don't count as card, while card faces (much lighter or colourful) do
    var rad = Math.max(6, Math.round(Math.min(w, h) * 0.22));
    var tmp = new Float32Array(w*h), lo = new Float32Array(w*h), loc = new Float32Array(w*h);
    function minPass(src, dst, horiz){
      var n = horiz ? w : h, lines = horiz ? h : w, q = new Int32Array(n), buf = new Float32Array(n);
      for (var L=0; L<lines; L++){
        for (var t=0; t<n; t++) buf[t] = src[horiz ? L*w + t : t*w + L];
        // sliding-window minimum (monotonic queue)
        var head = 0, tail = 0;
        for (var t2=0; t2<n + rad; t2++){
          if (t2 < n){ while (tail > head && buf[q[tail-1]] >= buf[t2]) tail--; q[tail++] = t2; }
          var c0 = t2 - rad; if (c0 < 0) continue;
          while (q[head] < c0 - rad) head++;
          dst[horiz ? L*w + c0 : c0*w + L] = buf[q[head]];
        }
      }
    }
    function boxPass(src, dst, horiz){
      var n = horiz ? w : h, lines = horiz ? h : w;
      for (var L=0; L<lines; L++){
        var sum = 0, cnt = 0, at = function(t){ return src[horiz ? L*w + t : t*w + L]; };
        for (var t=0; t<Math.min(n, rad); t++){ sum += at(t); cnt++; }
        for (var c0=0; c0<n; c0++){
          var add = c0 + rad, drop = c0 - rad - 1;
          if (add < n){ sum += at(add); cnt++; } if (drop >= 0){ sum -= at(drop); cnt--; }
          dst[horiz ? L*w + c0 : c0*w + L] = sum / cnt;
        }
      }
    }
    minPass(gray, tmp, true); minPass(tmp, lo, false);
    boxPass(lo, tmp, true); boxPass(tmp, loc, false);
    // streakiness (structure-tensor coherence): glare on wood grain is a field of parallel lines; card art isn't
    var jxx = new Float32Array(w*h), jyy = new Float32Array(w*h), jxy = new Float32Array(w*h);
    for (var sy=1; sy<h-1; sy++) for (var sx=1; sx<w-1; sx++){
      var q0 = sy*w + sx, gxv = gray[q0+1] - gray[q0-1], gyv = gray[q0+w] - gray[q0-w];
      jxx[q0] = gxv*gxv; jyy[q0] = gyv*gyv; jxy[q0] = gxv*gyv;
    }
    var rad0 = rad; rad = 3;
    boxPass(jxx, tmp, true); boxPass(tmp, jxx, false); boxPass(jyy, tmp, true); boxPass(tmp, jyy, false); boxPass(jxy, tmp, true); boxPass(tmp, jxy, false);
    rad = rad0;
    for (var i=0, k=0; i<d.length; i+=4, k++){
      var lift = gray[k] - loc[k], sat = Math.max(d[i], d[i+1], d[i+2]) - Math.min(d[i], d[i+1], d[i+2]);
      var en = jxx[k] + jyy[k], coh = en > 1 ? Math.sqrt((jxx[k] - jyy[k]) * (jxx[k] - jyy[k]) + 4 * jxy[k] * jxy[k]) / en : 0;
      var streaky = coh > 0.55 && en > 120;
      m[k] = (lift > 120 || (sat > 55 && lift > 25) || (lift > 50 && !streaky)) ? 1 : 0;
    }
  } else {
    for (var i=0, k=0; i<d.length; i+=4, k++) m[k] = (Math.abs(d[i]-br) + Math.abs(d[i+1]-bgc) + Math.abs(d[i+2]-bb)) > T ? 1 : 0;
  }
  // light closing (radius 1) so specks inside a card join up but real gaps stay open
  function morph(src, grow){
    var out = new Uint8Array(w*h);
    for (var yy=0; yy<h; yy++) for (var xx=0; xx<w; xx++){
      var v = grow ? 0 : 1;
      for (var dy=-1; dy<=1 && (grow ? !v : v); dy++) for (var dx=-1; dx<=1; dx++){
        var nx = xx+dx, ny = yy+dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h){ if (!grow){ v = 0; break; } continue; }
        var sv = src[ny*w + nx]; if (grow && sv){ v = 1; break; } if (!grow && !sv){ v = 0; break; }
      }
      out[yy*w + xx] = v;
    }
    return out;
  }
  if (darkTable) {
    // fill small gaps inside each card, then cut the thin necks of table glare that join neighbouring cards
    var rr = Math.max(3, Math.round(Math.min(w, h) * 0.018)), ii;
    for (ii=0; ii<3; ii++) m = morph(m, true); for (ii=0; ii<3; ii++) m = morph(m, false);
    for (ii=0; ii<rr; ii++) m = morph(m, false); for (ii=0; ii<rr; ii++) m = morph(m, true);
  }
  m = morph(morph(m, true), false);
  // connected components
  var lab = new Int32Array(w*h), comps = [], stack = [], n = 0;
  for (var p0=0; p0<w*h; p0++){
    if (!m[p0] || lab[p0]) continue;
    n++; var minx = w, miny = h, maxx = 0, maxy = 0, area = 0; stack.push(p0); lab[p0] = n;
    while (stack.length){
      var q = stack.pop(), qx = q % w, qy = (q - qx) / w; area++;
      if (qx < minx) minx = qx; if (qx > maxx) maxx = qx; if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
      if (qx > 0 && m[q-1] && !lab[q-1]){ lab[q-1] = n; stack.push(q-1); }
      if (qx < w-1 && m[q+1] && !lab[q+1]){ lab[q+1] = n; stack.push(q+1); }
      if (qy > 0 && m[q-w] && !lab[q-w]){ lab[q-w] = n; stack.push(q-w); }
      if (qy < h-1 && m[q+w] && !lab[q+w]){ lab[q+w] = n; stack.push(q+w); }
    }
    if (area >= 0.002 * w * h) comps.push({ x0: minx, y0: miny, x1: maxx + 1, y1: maxy + 1, id: n });
  }
  // split a region at empty gaps or at straight lines running all the way across it
  var TE = 28;
  function trim(r){
    var x0 = r.x1, y0 = r.y1, x1 = r.x0, y1 = r.y0, any = false;
    for (var yy=r.y0; yy<r.y1; yy++) for (var xx=r.x0; xx<r.x1; xx++) if (lab[yy*w + xx] === r.id){ any = true; if (xx < x0) x0 = xx; if (xx >= x1) x1 = xx + 1; if (yy < y0) y0 = yy; if (yy >= y1) y1 = yy + 1; }
    return any ? { x0: x0, y0: y0, x1: x1, y1: y1, id: r.id } : null;
  }
  function bestCut(r, vertical){
    var len = vertical ? r.x1 - r.x0 : r.y1 - r.y0, span = vertical ? r.y1 - r.y0 : r.x1 - r.x0;
    if (len < 24) return [];
    var lo = Math.floor(len * 0.12), hi = Math.ceil(len * 0.88), cov = [], line = [];
    for (var t=0; t<len; t++){
      var c = 0, e = 0;
      for (var u=0; u<span; u++){
        var xx = vertical ? r.x0 + t : r.x0 + u, yy = vertical ? r.y0 + u : r.y0 + t;
        c += lab[yy*w + xx] === r.id ? 1 : 0;
        var g1, g2;
        if (vertical){ g1 = gray[yy*w + Math.max(0, xx-1)]; g2 = gray[yy*w + Math.min(w-1, xx+1)]; }
        else { g1 = gray[Math.max(0, yy-1)*w + xx]; g2 = gray[Math.min(h-1, yy+1)*w + xx]; }
        if (Math.abs(g1 - g2) > TE) e++;
      }
      cov.push(c / span); line.push(e / span);
    }
    var found = [], t4 = lo;
    while (t4 < hi){
      if (cov[t4] < 0.06){ var a1 = t4; while (t4 < hi - 1 && cov[t4+1] < 0.06) t4++; found.push({ at: (a1 + t4) >> 1, kind: 2 }); }
      t4++;
    }
    for (var t3=lo; t3<hi; t3++){
      var lv = Math.max(line[t3], line[t3-1] || 0, line[t3+1] || 0);
      if (lv > 0.85 && lv >= (line[t3-2] || 0) && lv >= (line[t3+2] || 0)){
        if (!found.some(function(f){ return Math.abs(f.at - t3) < 4; })) found.push({ at: t3, kind: 1 });
      }
    }
    found.forEach(function(f){ f.mid = Math.abs(f.at / len - 0.5); });
    return found;
  }
  function ratio(a, b){ return Math.min(a, b) / Math.max(a, b); }
  function cardLike(a, b){ var q = ratio(a, b); return q > 0.63 && q < 0.8; }
  function okCut(rw, rh, at, vert){
    var a = vert ? [at, rh] : [rw, at], b = vert ? [rw - at - 1, rh] : [rw, rh - at - 1];
    if (cardLike(rw, rh)) return cardLike(a[0], a[1]) && cardLike(b[0], b[1]);
    return ratio(a[0], a[1]) >= 0.5 && ratio(b[0], b[1]) >= 0.5;
  }
  var out = [];
  function split(r, depth){
    r = trim(r); if (!r) return;
    var rw = r.x1 - r.x0, rh = r.y1 - r.y0;
    if (depth < 7){
      var cands = [], cut = null, vert = true;
      bestCut(r, true).forEach(function(c){ cands.push({ c: c, v: true }); });
      bestCut(r, false).forEach(function(c){ cands.push({ c: c, v: false }); });
      cands.sort(function(a, b){ return (b.c.kind - a.c.kind) || (a.c.mid - b.c.mid); });
      for (var ci=0; ci<cands.length; ci++){ if (okCut(rw, rh, cands[ci].c.at, cands[ci].v)){ cut = cands[ci].c; vert = cands[ci].v; break; } }
      if (cut){
        if (vert){ split({ x0: r.x0, y0: r.y0, x1: r.x0 + cut.at, y1: r.y1, id: r.id }, depth + 1); split({ x0: r.x0 + cut.at + 1, y0: r.y0, x1: r.x1, y1: r.y1, id: r.id }, depth + 1); }
        else { split({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y0 + cut.at, id: r.id }, depth + 1); split({ x0: r.x0, y0: r.y0 + cut.at + 1, x1: r.x1, y1: r.y1, id: r.id }, depth + 1); }
        return;
      }
    }
    out.push(r);
  }

  comps.forEach(function(c){ split(c, 0); });
  // drop fragments and boxes sitting inside bigger ones
  var areas = out.map(function(r){ return (r.x1 - r.x0) * (r.y1 - r.y0); }).sort(function(p, q){ return p - q; });
  var medA = areas.length ? areas[areas.length >> 1] : 0;
  out = out.filter(function(r){ var bw = r.x1 - r.x0, bh = r.y1 - r.y0; return bw * bh >= Math.max(0.003 * w * h, 0.25 * medA) && Math.min(bw, bh) / Math.max(bw, bh) >= 0.35; });
  out = out.filter(function(r, i){ var ar = (r.x1 - r.x0) * (r.y1 - r.y0); return !out.some(function(o, j){ if (j === i) return false; var ix = Math.max(0, Math.min(r.x1, o.x1) - Math.max(r.x0, o.x0)), iy = Math.max(0, Math.min(r.y1, o.y1) - Math.max(r.y0, o.y0)); var ao = (o.x1 - o.x0) * (o.y1 - o.y0); return ao > ar && ix * iy > 0.7 * ar; }); });
  var sx = W / w, sy = H / h;
  function hull(pts){
    pts.sort(function(p, q){ return p[0] - q[0] || p[1] - q[1]; });
    var cross = function(o, a, b){ return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]); }, lo = [], up = [];
    for (var i=0;i<pts.length;i++){ while (lo.length >= 2 && cross(lo[lo.length-2], lo[lo.length-1], pts[i]) <= 0) lo.pop(); lo.push(pts[i]); }
    for (var j=pts.length-1;j>=0;j--){ while (up.length >= 2 && cross(up[up.length-2], up[up.length-1], pts[j]) <= 0) up.pop(); up.push(pts[j]); }
    up.pop(); lo.pop(); return lo.concat(up);
  }
  function axisBox(r){ return { cx: (r.x0 + r.x1) / 2 * sx, cy: (r.y0 + r.y1) / 2 * sy, w: (r.x1 - r.x0) * sx, h: (r.y1 - r.y0) * sy, a: 0, r: 0 }; }
  function minRect(r){
    var pts = [];
    for (var yy=r.y0; yy<r.y1; yy++){
      var a1 = -1, b1 = -1;
      for (var xx=r.x0; xx<r.x1; xx++) if (lab[yy*w + xx] === r.id){ if (a1 < 0) a1 = xx; b1 = xx; }
      if (a1 >= 0) pts.push([a1*sx, yy*sy], [(b1+1)*sx, yy*sy], [a1*sx, (yy+1)*sy], [(b1+1)*sx, (yy+1)*sy]);
    }
    if (pts.length < 6) return axisBox(r);
    var hl = hull(pts), best = null;
    for (var i=0;i<hl.length;i++){
      var p1 = hl[i], p2 = hl[(i+1) % hl.length], ex = p2[0]-p1[0], ey = p2[1]-p1[1], len = Math.hypot(ex, ey);
      if (len < 1e-6) continue;
      var ux = ex/len, uy = ey/len, mnU = Infinity, mxU = -Infinity, mnV = Infinity, mxV = -Infinity;
      for (var k=0;k<hl.length;k++){ var u = hl[k][0]*ux + hl[k][1]*uy, v = -hl[k][0]*uy + hl[k][1]*ux; if (u < mnU) mnU = u; if (u > mxU) mxU = u; if (v < mnV) mnV = v; if (v > mxV) mxV = v; }
      var ar = (mxU - mnU) * (mxV - mnV);
      if (!best || ar < best.ar) best = { ar: ar, ux: ux, uy: uy, mnU: mnU, mxU: mxU, mnV: mnV, mxV: mxV };
    }
    if (!best) return axisBox(r);
    var cu = (best.mnU + best.mxU) / 2, cvv = (best.mnV + best.mxV) / 2, bw = best.mxU - best.mnU, bh = best.mxV - best.mnV, ang = Math.atan2(best.uy, best.ux), t;
    while (ang > Math.PI/4){ ang -= Math.PI/2; t = bw; bw = bh; bh = t; }
    while (ang <= -Math.PI/4){ ang += Math.PI/2; t = bw; bw = bh; bh = t; }
    var ab = axisBox(r);
    if (Math.abs(ang) < 0.03 || best.ar > 0.96 * ab.w * ab.h) return ab;
    return { cx: cu*best.ux - cvv*best.uy, cy: cu*best.uy + cvv*best.ux, w: bw, h: bh, a: ang, r: 0 };
  }
  var boxes = out.map(minRect);
  // every card in one photo is the same size: use that to split blobs of touching cards and drop clutter
  (function(){
    var cardish = boxes.filter(function(b){ var q = Math.min(b.w, b.h) / Math.max(b.w, b.h); return q > 0.62 && q < 0.8; });
    if (cardish.length < 2) return;
    var md = function(a){ a = a.slice().sort(function(p, q){ return p - q; }); return a[a.length >> 1]; };
    var Lc = md(cardish.map(function(b){ return Math.max(b.w, b.h); })) / sx, Sc = md(cardish.map(function(b){ return Math.min(b.w, b.h); })) / sx, Ac = Lc * Sc;
    var keep = [], extra = [];
    out.forEach(function(r, idx){
      var b = boxes[idx], bw = (r.x1 - r.x0), bh = (r.y1 - r.y0);
      var touches = r.x0 <= 3 || r.y0 <= 3 || r.x1 >= w - 3 || r.y1 >= h - 3;
      var areaS = (b.w / sx) * (b.h / sy);
      if (touches && areaS < 0.75 * Ac) return;            // clutter at the photo's edge (a lanyard, a box corner)
      if (areaS < 1.7 * Ac){ keep.push(b); return; }
      // a blob of several cards: cluster its pixels, fit a card-sized box to each cluster, keep boxes that are mostly card
      // fit to the colourful card faces, not to grey glare that joins them
      var face = function(q){ var i4 = q * 4, mx = Math.max(d[i4], d[i4+1], d[i4+2]), mn = Math.min(d[i4], d[i4+1], d[i4+2]); return mx - mn > 45 && mx > 60; };
      var pts = [];
      for (var yy=r.y0; yy<r.y1; yy++) for (var xx=r.x0; xx<r.x1; xx++){ var q5 = yy*w + xx; if (lab[q5] === r.id && face(q5)) pts.push(xx, yy); }
      if (pts.length < 2 * 0.3 * Ac){ keep.push(b); return; }
      var np = pts.length >> 1, inR = function(px, py){ return px >= r.x0 && py >= r.y0 && px < r.x1 && py < r.y1 && lab[py*w + px] === r.id && face(py*w + px); };
      function cover(c){
        var ca = Math.cos(c.a), sa = Math.sin(c.a), hit = 0, n = 0;
        for (var i=0;i<10;i++) for (var j=0;j<14;j++){
          var u = ((i + 0.5) / 10 - 0.5) * c.w, v = ((j + 0.5) / 14 - 0.5) * c.h;
          var px = Math.round(c.cx + u*ca - v*sa), py = Math.round(c.cy + u*sa + v*ca); n++;
          if (inR(px, py)) hit++;
        }
        return hit / n;
      }
      // how sharply the face is brighter than just outside its four edges
      function edgeScore(c){
        var ca = Math.cos(c.a), sa = Math.sin(c.a), tot = 0, n = 0, off = Math.max(1.5, Sc * 0.03);
        for (var e=0; e<4; e++){
          var horiz = e < 2, sgn = e % 2 ? 1 : -1, len = horiz ? c.w : c.h, half = horiz ? c.h / 2 : c.w / 2;
          for (var t=0; t<16; t++){
            var along = ((t + 0.5) / 16 - 0.5) * len * 0.9, inN = sgn * (half - off), outN = sgn * (half + off);
            var ux = horiz ? along : inN, uy = horiz ? inN : along, ox = horiz ? along : outN, oy = horiz ? outN : along;
            var ix = Math.round(c.cx + ux*ca - uy*sa), iy = Math.round(c.cy + ux*sa + uy*ca), jx = Math.round(c.cx + ox*ca - oy*sa), jy = Math.round(c.cy + ox*sa + oy*ca);
            if (ix < 0 || iy < 0 || jx < 0 || jy < 0 || ix >= w || jx >= w || iy >= h || jy >= h) continue;
            tot += Math.min(80, gray[iy*w + ix] - gray[jy*w + jx]); n++;
          }
        }
        return n ? tot / n : -999;
      }
      function climb(c0, f){
        var a00 = c0.a, v0 = f(c0), steps = [[Sc * 0.08, 0.06], [Sc * 0.04, 0.03], [Sc * 0.02, 0.012]];
        for (var si=0; si<steps.length; si++){
          var improved = true, guard = 0, st = steps[si][0], sa2 = steps[si][1];
          while (improved && guard++ < 40){
            improved = false;
            [[st,0,0,1],[-st,0,0,1],[0,st,0,1],[0,-st,0,1],[0,0,sa2,1],[0,0,-sa2,1],[0,0,0,1 + sa2 / 2],[0,0,0,1 - sa2 / 2]].forEach(function(mv){
              var c1 = { cx: c0.cx + mv[0], cy: c0.cy + mv[1], w: c0.w * mv[3], h: c0.h * mv[3], a: c0.a + mv[2] };
              if (Math.abs(c1.a - a00) > 0.3 || Math.max(c1.w, c1.h) > Lc * 1.12 || Math.max(c1.w, c1.h) < Lc * 0.88) return;
              var v1 = f(c1);
              if (v1 > v0 + 1e-6){ c0 = c1; v0 = v1; improved = true; }
            });
          }
        }
        return { c: c0, v: v0 };
      }
      var best = null, kMax = Math.min(6, Math.ceil(areaS / Ac) + 1);
      for (var k=2; k<=kMax; k++){
        // k-means with farthest-point start
        var cs = [[pts[0], pts[1]]];
        while (cs.length < k){ var far = -1, fi = 0; for (var p=0; p<np; p+=3){ var dmin = Infinity; cs.forEach(function(c){ var dx = pts[2*p] - c[0], dy = pts[2*p+1] - c[1]; dmin = Math.min(dmin, dx*dx + dy*dy); }); if (dmin > far){ far = dmin; fi = p; } } cs.push([pts[2*fi], pts[2*fi+1]]); }
        var asg = new Int32Array(np);
        for (var it=0; it<12; it++){
          var acc = cs.map(function(){ return [0, 0, 0]; });
          for (var p2=0; p2<np; p2++){ var bi = 0, bd = Infinity; for (var c2=0; c2<k; c2++){ var dx2 = pts[2*p2] - cs[c2][0], dy2 = pts[2*p2+1] - cs[c2][1], dd = dx2*dx2 + dy2*dy2; if (dd < bd){ bd = dd; bi = c2; } } asg[p2] = bi; acc[bi][0] += pts[2*p2]; acc[bi][1] += pts[2*p2+1]; acc[bi][2]++; }
          cs = acc.map(function(a2, c3){ return a2[2] ? [a2[0] / a2[2], a2[1] / a2[2]] : cs[c3]; });
        }
        var rects = [];
        for (var c4=0; c4<k; c4++){
          var mxx = 0, myy = 0, mxy = 0, cnt = 0;
          for (var p3=0; p3<np; p3++) if (asg[p3] === c4){ var ex = pts[2*p3] - cs[c4][0], ey = pts[2*p3+1] - cs[c4][1]; mxx += ex*ex; myy += ey*ey; mxy += ex*ey; cnt++; }
          if (cnt < 0.15 * Ac) continue;
          var ang = 0.5 * Math.atan2(2*mxy, mxx - myy);   // long axis of the cluster
          var bestC = null;
          [ang, ang + Math.PI / 2, 0, Math.PI / 2, 0.2, -0.2, 0.35, -0.35, Math.PI / 2 + 0.2, Math.PI / 2 - 0.2, Math.PI / 2 + 0.35, Math.PI / 2 - 0.35].forEach(function(a0){
            // place it over the card face first, then line its edges up with the card's border
            var c0 = climb({ cx: cs[c4][0], cy: cs[c4][1], w: Lc, h: Sc, a: a0 }, cover).c;
            var fit = climb(c0, edgeScore), cv = cover(fit.c);
            if (cv >= 0.4 && (!bestC || fit.v > bestC.v)) bestC = { c: fit.c, cov: cv, v: fit.v };
          });
          if (bestC) rects.push(bestC);
        }
        // drop boxes that overlap a better one (two boxes on one card)
        rects.sort(function(p, q){ return q.cov - p.cov; });
        var inside = function(c, px, py){ var ca = Math.cos(c.a), sa = Math.sin(c.a), dx = px - c.cx, dy = py - c.cy; return Math.abs(dx*ca + dy*sa) <= c.w/2 && Math.abs(-dx*sa + dy*ca) <= c.h/2; };
        var chosen = [];
        rects.forEach(function(x){
          var ov = 0, n2 = 0, ca = Math.cos(x.c.a), sa = Math.sin(x.c.a);
          for (var i=0;i<8;i++) for (var j=0;j<10;j++){ var u = ((i + 0.5) / 8 - 0.5) * x.c.w, v = ((j + 0.5) / 10 - 0.5) * x.c.h, px = x.c.cx + u*ca - v*sa, py = x.c.cy + u*sa + v*ca; n2++; if (chosen.some(function(y){ return inside(y.c, px, py); })) ov++; }
          if (ov / n2 < 0.2) chosen.push(x);
        });
        // how much of the blob the boxes explain; more boxes must explain clearly more
        var expl = 0, tot = 0;
        for (var p4=0; p4<np; p4+=2){ tot++; if (chosen.some(function(y){ return inside(y.c, pts[2*p4], pts[2*p4+1]); })) expl++; }
        var frac = tot ? expl / tot : 0;
        if (!best || frac > best.frac + 0.06 * Math.max(0, chosen.length - best.rects.length)) best = { rects: chosen, frac: frac };
      }
      if (!best || !best.rects.length){ keep.push(b); return; }
      best.rects.forEach(function(x){
        var c = x.c, a2 = c.a, bw2 = c.w, bh2 = c.h, t;
        while (a2 > Math.PI/4){ a2 -= Math.PI/2; t = bw2; bw2 = bh2; bh2 = t; }
        while (a2 <= -Math.PI/4){ a2 += Math.PI/2; t = bw2; bw2 = bh2; bh2 = t; }
        extra.push({ cx: c.cx * sx, cy: c.cy * sy, w: bw2 * sx, h: bh2 * sy, a: Math.abs(a2) < 0.03 ? 0 : a2, r: 0 });
      });
    });
    boxes = keep.concat(extra);
  })();
  // cards in one photo are the same size: grow any box that came out short, toward the side with more card detail
  var gm = new Float32Array(w*h);
  for (var gy=1; gy<h-1; gy++) for (var gx=1; gx<w-1; gx++){ var gk = gy*w + gx; gm[gk] = Math.abs(gray[gk+1] - gray[gk-1]) + Math.abs(gray[gk+w] - gray[gk-w]); }
  function energy(cxn, cyn, ux, uy, len, wid){
    var tot = 0, n2 = 0;
    for (var i=0;i<8;i++) for (var j=0;j<12;j++){
      var a2 = (i + 0.5) / 8 - 0.5, b2 = (j + 0.5) / 12 - 0.5;
      var X = (cxn + ux*a2*len - uy*b2*wid) / sx, Y = (cyn + uy*a2*len + ux*b2*wid) / sy;
      var ix = Math.round(X), iy = Math.round(Y);
      if (ix < 1 || iy < 1 || ix >= w-1 || iy >= h-1) continue;
      tot += gm[iy*w + ix]; n2++;
    }
    return n2 ? tot / n2 : 0;
  }
  function grow(b, alongW, d){
    var ux = Math.cos(b.a), uy = Math.sin(b.a), dx2 = alongW ? ux : -uy, dy2 = alongW ? uy : ux, half = (alongW ? b.w : b.h) / 2, other = alongW ? b.h : b.w;
    var ePlus = energy(b.cx + dx2*(half + d/2), b.cy + dy2*(half + d/2), dx2, dy2, d, other * 0.9);
    var eMinus = energy(b.cx - dx2*(half + d/2), b.cy - dy2*(half + d/2), dx2, dy2, d, other * 0.9);
    var f = (ePlus + eMinus) > 1 ? ePlus / (ePlus + eMinus) : 0.5;
    b.cx += dx2 * d * (f - 0.5); b.cy += dy2 * d * (f - 0.5);
    if (alongW) b.w += d; else b.h += d;
  }
  var shapely = boxes.filter(function(b){ var q = Math.min(b.w, b.h) / Math.max(b.w, b.h); return q > 0.62 && q < 0.8; });
  if (shapely.length >= 2){
    var md = function(a){ a = a.slice().sort(function(p, q){ return p - q; }); return a[a.length >> 1]; };
    var Lm = md(shapely.map(function(b){ return Math.max(b.w, b.h); })), Sm = md(shapely.map(function(b){ return Math.min(b.w, b.h); }));
    boxes.forEach(function(b){
      var tall = b.h >= b.w, lng = tall ? b.h : b.w, sht = tall ? b.w : b.h;
      if (lng < 0.97 * Lm && lng > 0.55 * Lm) grow(b, !tall, Lm - lng);
      if (sht < 0.97 * Sm && sht > 0.55 * Sm) grow(b, tall, Sm - sht);
    });
  }
  // a little extra room so dark card borders (which blend into dark tables) aren't clipped
  boxes.forEach(function(b){ b.w *= 1.07; b.h *= 1.07; });
  return readingOrder(boxes);
}
async function cropBox(img, b){
  var sc = Math.min(1, 1000 / Math.max(b.w, b.h)), cw = Math.max(1, Math.round(b.w * sc)), ch = Math.max(1, Math.round(b.h * sc)), turn = (b.r || 0) % 360;
  var cv = document.createElement("canvas"); cv.width = turn % 180 ? ch : cw; cv.height = turn % 180 ? cw : ch;
  var cx = cv.getContext("2d");
  cx.fillStyle = "#1b1c22"; cx.fillRect(0, 0, cv.width, cv.height);
  cx.translate(cv.width / 2, cv.height / 2);
  cx.rotate(turn * Math.PI / 180);
  cx.rotate(-(b.a || 0));
  cx.scale(sc, sc);
  cx.drawImage(img, -b.cx, -b.cy);
  return await new Promise(function(r){ cv.toBlob(r, "image/jpeg", 0.9); });
}

function estimateTilt(img){
  var sc = Math.min(1, 420 / Math.max(img.naturalWidth, img.naturalHeight)), w = Math.max(8, Math.round(img.naturalWidth*sc)), h = Math.max(8, Math.round(img.naturalHeight*sc));
  var cv = document.createElement("canvas"); cv.width = w; cv.height = h; var cx = cv.getContext("2d"); cx.drawImage(img, 0, 0, w, h);
  var d = cx.getImageData(0, 0, w, h).data, g = new Float32Array(w*h), hist = new Float32Array(91);
  for (var i=0, k=0; i<d.length; i+=4, k++) g[k] = 0.3*d[i] + 0.59*d[i+1] + 0.11*d[i+2];
  for (var y=1; y<h-1; y++) for (var x=1; x<w-1; x++){
    var q = y*w + x, gx = g[q+1] - g[q-1], gy = g[q+w] - g[q-w], mag = Math.hypot(gx, gy);
    if (mag < 40) continue;
    var deg = Math.atan2(gy, gx) * 180 / Math.PI;
    deg = ((deg % 90) + 90) % 90; if (deg > 45) deg -= 90;
    hist[Math.round(deg) + 45] += mag;
  }
  var best = 45, bv = -1;
  for (var j=0; j<91; j++){ var v = hist[j] + 0.5 * ((hist[j-1] || 0) + (hist[j+1] || 0)); if (v > bv){ bv = v; best = j; } }
  var deg2 = best - 45;
  return Math.abs(deg2) < 1 ? 0 : deg2 * Math.PI / 180;
}

// Adjust: fit one straight-or-tilted box to the single card in a photo.
function autoFit(img) {
  var W = img.naturalWidth, H = img.naturalHeight, found = [];
  try { found = detectBoxes(img); } catch (e) { found = []; }
  var big = found.slice().sort(function (a, b) { return b.w * b.h - a.w * a.h; })[0];
  if (!big || big.w * big.h < 0.2 * W * H || (big.w * big.h > 0.8 * W * H && !big.a)) {
    // the card fills the photo (or runs off it): measure the tilt from the card's printed lines and fit the biggest straight box
    var tilt = estimateTilt(img), c1 = Math.abs(Math.cos(tilt)), s1 = Math.abs(Math.sin(tilt));
    var A = W <= H ? 0.716 : 1, B = W <= H ? 1 : 0.716;
    var kIn = Math.min(W / (A * c1 + B * s1), H / (A * s1 + B * c1)), kOut = Math.max((W * c1 + H * s1) / A, (W * s1 + H * c1) / B);
    var k = kIn + 0.55 * (kOut - kIn);
    big = { cx: W / 2, cy: H / 2, w: A * k, h: B * k, a: tilt, r: 0 };
  }
  return big;
}

/* ---------- editor: check the boxes, then cut each card out ---------- */
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
var sp = null, host = null, onAdd = null, sdrag = null;

function boxStyle(b) { return "left:" + ((b.cx - b.w / 2) / sp.W * 100) + "%;top:" + ((b.cy - b.h / 2) / sp.H * 100) + "%;width:" + (b.w / sp.W * 100) + "%;height:" + (b.h / sp.H * 100) + "%;transform:rotate(" + b.a + "rad)"; }
function countText() { var n = sp.boxes.length; return n + " card" + (n === 1 ? "" : "s") + " marked"; }

function render() {
  if (!host) return;
  if (!sp) { host.innerHTML = ""; return; }
  var n = sp.boxes.length, adj = sp.mode === "adjust", dis = sp.busy ? ' disabled' : '';
  host.innerHTML = '<section class="splitbox"><div class="row2"><h2>' + (adj ? 'Adjust photo' + (sp.title ? ': ' + esc(sp.title) : '') : 'Photo of many cards') + '</h2><span class="note" id="split-count">' + countText() + '</span></div>'
    + '<div class="splittools">' + (adj
      ? '<button class="btn sm" data-split="detect"' + dis + '>Auto adjust</button>' + (sp.startBox ? '<button class="btn sm" data-split="reset"' + dis + '>Back to saved crop</button>' : '') + '<button class="btn ghost sm" data-split="clear"' + dis + '>Clear box</button></div>'
      : '<button class="btn sm" data-split="detect"' + dis + '>Find cards again</button>'
    + '<span class="gridset"><label>Grid <input id="split-rows" type="number" min="1" max="10" value="' + sp.rows + '" aria-label="Rows"></label> × <input id="split-cols" type="number" min="1" max="10" value="' + sp.cols + '" aria-label="Columns"><button class="btn sm" data-split="grid"' + (sp.busy ? ' disabled' : '') + '>Use grid</button></span>'
    + '<button class="btn ghost sm" data-split="clear"' + dis + '>Clear boxes</button></div>')
    + '<p class="note" role="status">' + esc(sp.msg) + '</p>'
    + '<div class="splitstage" id="split-stage" style="max-width:calc(68vh * ' + (sp.W / sp.H).toFixed(4) + ')"><img src="' + sp.url + '" alt="Photo of several cards" draggable="false">'
    + sp.boxes.map(function (b, i) { return '<div class="sbox" data-i="' + i + '" style="' + boxStyle(b) + '"><span class="sbox-n">' + (i + 1) + (b.r ? ' ↻' + b.r + '°' : '') + '</span><button class="sbox-t" data-split="turn" data-i="' + i + '" aria-label="Turn card ' + (i + 1) + ' a quarter turn" title="Turn a quarter turn">↻</button><button class="sbox-x" data-split="del" data-i="' + i + '" aria-label="Remove box ' + (i + 1) + '">×</button><span class="sbox-r" aria-hidden="true" title="Drag to tilt"></span><span class="sbox-h" aria-hidden="true" title="Drag to resize"></span></div>'; }).join("")
    + '</div><div class="splitacts"><button class="btn primary" data-split="go"' + (n && !sp.busy && (!adj || n === 1) ? '' : ' disabled') + '>' + (sp.busy ? 'Working…' : adj ? (n === 1 ? 'Save photo' : n ? 'Keep exactly one box to save' : 'Draw a box to save') : 'Add ' + n + ' card' + (n === 1 ? '' : 's')) + '</button><button class="btn ghost" data-split="cancel"' + dis + '>Cancel</button>'
    + '<span class="note">' + (adj ? 'Saves a new, straightened photo for this card. You can adjust it again later from the same original photo.' : 'Each box becomes its own listing, straightened, using the default price, game, condition and box above. The original photo is kept so you can re-crop any card later.') + '</span></div></section>';
}

function detect() {
  if (sp.mode === "adjust") {
    var b = autoFit(sp.img); sp.boxes = [b];
    sp.msg = (b.a ? "The card is tilted; the box follows it and the photo will be straightened. " : "") + "Line the box up with the card: drag to move, pull the corner dot to resize, drag the top dot to tilt, ↻ for a quarter turn. Then save.";
    render(); return;
  }
  var found = [];
  try { found = detectBoxes(sp.img); } catch (e) { found = []; }
  var tilted = found.filter(function (b) { return b.a; }).length;
  if (found.length) sp.boxes = found, sp.msg = "Found " + found.length + " card" + (found.length === 1 ? "" : "s") + (tilted ? " (" + tilted + " tilted; they’ll be straightened)" : "") + ". Check the boxes: drag to move, pull the corner dot to resize, drag the top dot to tilt, tap ↻ to turn a card a quarter turn, × to remove, or drag on an empty spot to add one.";
  else sp.boxes = gridBoxes(sp, 3, 3, { x: 0.01, y: 0.01, w: 0.98, h: 0.98 }), sp.msg = "Couldn’t tell the cards apart from the background, so this starts with a 3 × 3 grid (a binder page). Change the grid, or drag the boxes to line them up.";
  render();
}

function close() { if (sp && sp.url) URL.revokeObjectURL(sp.url); sp = null; render(); }

function open(file, container, addFn, opts) {
  host = container; onAdd = addFn; opts = opts || {};
  if (!file || !/^image\//.test(file.type)) { return Promise.reject(new Error("Choose a photo (JPG, PNG or WebP).")); }
  if (sp && sp.url) URL.revokeObjectURL(sp.url);
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file), im = new Image();
    im.onload = function () {
      sp = { url: url, img: im, W: im.naturalWidth, H: im.naturalHeight, boxes: [], rows: 3, cols: 3, msg: "", busy: false,
             base: (file.name || "group").replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-") || "group",
             mode: opts.mode === "adjust" ? "adjust" : "many", title: opts.title || "", startBox: opts.startBox ? Object.assign({ a: 0, r: 0 }, opts.startBox) : null };
      if (sp.startBox) { sp.boxes = [Object.assign({}, sp.startBox)]; sp.msg = "This is the original photo with your saved crop. Move, resize, tilt or turn the box (or tap Auto adjust), then save to cut a new photo from it."; render(); }
      else detect();
      host.scrollIntoView({ behavior: "smooth", block: "start" });
      resolve();
    };
    im.onerror = function () { URL.revokeObjectURL(url); reject(new Error("That photo couldn’t be opened. iPhone HEIC photos need converting to JPG first.")); };
    im.src = url;
  });
}

async function go() {
  if (!sp || !sp.boxes.length || sp.busy) return;
  if (sp.mode === "adjust") {
    if (sp.boxes.length !== 1) return;
    sp.busy = true; sp.msg = "Saving the adjusted photo…"; render();
    var box = Object.assign({}, sp.boxes[0]), ablob = await cropBox(sp.img, box), acb = onAdd;
    try { if (acb) await acb({ blob: ablob, box: box }); close(); }
    catch (e) { if (sp) { sp.busy = false; sp.msg = "Couldn’t save the photo: " + (e.message || e) + ". Try again."; render(); } }
    return;
  }
  sp.busy = true; sp.msg = "Cutting out and straightening " + sp.boxes.length + " cards…"; render();
  var boxes = readingOrder(sp.boxes), files = [];
  for (var i = 0; i < boxes.length; i++) {
    var blob = await cropBox(sp.img, boxes[i]); if (!blob) continue;
    files.push(new File([blob], sp.base + "-" + String(i + 1).padStart(2, "0") + ".jpg", { type: "image/jpeg" }));
  }
  // keep the whole photo (up to 2400px) so each card can be re-cropped from it later
  var f = Math.min(1, 2400 / Math.max(sp.W, sp.H)), ocv = document.createElement("canvas");
  ocv.width = Math.round(sp.W * f); ocv.height = Math.round(sp.H * f); ocv.getContext("2d").drawImage(sp.img, 0, 0, ocv.width, ocv.height);
  var original = await new Promise(function (r) { ocv.toBlob(r, "image/jpeg", 0.9); });
  var srcBoxes = boxes.map(function (b) { return { cx: b.cx * f, cy: b.cy * f, w: b.w * f, h: b.h * f, a: b.a || 0, r: b.r || 0 }; });
  var cb = onAdd; close();
  if (cb) await cb(files, { original: original, boxes: srcBoxes });
}

function bind(container) {
  container.addEventListener("click", function (e) {
    var t = e.target.closest("[data-split]"); if (!t || !sp || t.disabled) return;
    var a = t.getAttribute("data-split"), i = +t.getAttribute("data-i");
    if (a === "detect") detect();
    else if (a === "grid") {
      var gr = Math.max(1, Math.min(10, parseInt(document.getElementById("split-rows").value, 10) || 3)), gc = Math.max(1, Math.min(10, parseInt(document.getElementById("split-cols").value, 10) || 3));
      sp.rows = gr; sp.cols = gc; sp.boxes = gridBoxes(sp, gr, gc, { x: 0.01, y: 0.01, w: 0.98, h: 0.98 });
      sp.msg = "Split into a " + gr + " × " + gc + " grid. Drag the boxes to line them up with the cards."; render();
    }
    else if (a === "clear") { sp.boxes = []; sp.msg = sp.mode === "adjust" ? "Box cleared. Drag on the photo to draw a box around the card." : "Boxes cleared. Drag on the photo to draw a box around each card."; render(); }
    else if (a === "reset" && sp.startBox) { sp.boxes = [Object.assign({}, sp.startBox)]; sp.msg = "Back to your saved crop."; render(); }
    else if (a === "del") { sp.boxes.splice(i, 1); render(); }
    else if (a === "turn") { var b = sp.boxes[i]; if (b) { b.r = ((b.r || 0) + 90) % 360; render(); } }
    else if (a === "go") go();
    else if (a === "cancel") close();
  });
  container.addEventListener("pointerdown", function (e) {
    var st = e.target.closest && e.target.closest("#split-stage"); if (!st || !sp || sp.busy) return;
    if (e.target.closest(".sbox-x") || e.target.closest(".sbox-t")) return;
    var r = st.getBoundingClientRect(), k = sp.W / r.width, px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k;
    var bx = e.target.closest(".sbox"), i = bx ? +bx.getAttribute("data-i") : -1;
    if (i >= 0) sdrag = { mode: e.target.closest(".sbox-h") ? "size" : e.target.closest(".sbox-r") ? "tilt" : "move", i: i, sx: px, sy: py, o: Object.assign({}, sp.boxes[i]) };
    else sdrag = { mode: "draw", i: -1, sx: px, sy: py };
    sdrag.rect = r; sdrag.k = k;
    try { st.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  container.addEventListener("pointermove", function (e) {
    if (!sdrag || !sp) return;
    var r = sdrag.rect, k = sdrag.k;
    var px = Math.max(0, Math.min(sp.W, (e.clientX - r.left) * k)), py = Math.max(0, Math.min(sp.H, (e.clientY - r.top) * k)), dx = px - sdrag.sx, dy = py - sdrag.sy, bxs = sp.boxes, b, o = sdrag.o;
    if (sdrag.mode === "draw") {
      if (sdrag.i < 0) { if (Math.abs(dx) < 0.01 * sp.W && Math.abs(dy) < 0.01 * sp.W) return; bxs.push({ cx: sdrag.sx, cy: sdrag.sy, w: 0, h: 0, a: 0, r: 0 }); sdrag.i = bxs.length - 1; render(); }
      b = bxs[sdrag.i]; b.cx = (sdrag.sx + px) / 2; b.cy = (sdrag.sy + py) / 2; b.w = Math.abs(dx); b.h = Math.abs(dy);
    } else if (sdrag.mode === "move") {
      b = bxs[sdrag.i]; b.cx = Math.max(0, Math.min(sp.W, o.cx + dx)); b.cy = Math.max(0, Math.min(sp.H, o.cy + dy));
    } else if (sdrag.mode === "size") {
      b = bxs[sdrag.i];
      var ca = Math.cos(o.a), sa = Math.sin(o.a), lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca, min = 0.02 * sp.W;
      var nw = Math.max(min, o.w + lx), nh = Math.max(min, o.h + ly); lx = nw - o.w; ly = nh - o.h;
      b.w = nw; b.h = nh; b.cx = o.cx + (lx / 2 * ca - ly / 2 * sa); b.cy = o.cy + (lx / 2 * sa + ly / 2 * ca);
    } else {
      b = bxs[sdrag.i];
      var ang = Math.atan2(py - o.cy, px - o.cx) + Math.PI / 2;
      while (ang > Math.PI) ang -= 2 * Math.PI; while (ang <= -Math.PI) ang += 2 * Math.PI;
      b.a = Math.abs(ang) < 0.035 ? 0 : ang;
    }
    var elx = host.querySelector('#split-stage .sbox[data-i="' + sdrag.i + '"]'); if (elx) elx.setAttribute("style", boxStyle(b));
  });
  function endDrag() {
    if (!sdrag || !sp) { sdrag = null; return; }
    var bxs = sp.boxes, i = sdrag.i, mode = sdrag.mode; sdrag = null;
    if (mode === "draw" && i >= 0 && (bxs[i].w < 0.02 * sp.W || bxs[i].h < 0.02 * sp.H)) bxs.splice(i, 1);
    if (mode === "draw") render(); else { var c = document.getElementById("split-count"); if (c) c.textContent = countText(); }
  }
  container.addEventListener("pointerup", endDrag);
  container.addEventListener("pointercancel", endDrag);
}

window.BBSplit = {
  // Opens the editor for one photo inside `container`. When the seller confirms, addFn(files) gets one JPEG File per card.
  // opts: { mode: "adjust", title, startBox } edits one card's photo; addFn({ blob, box }) gets the new crop.
  open: function (file, container, addFn, opts) { if (!container.__bbBound) { bind(container); container.__bbBound = true; } return open(file, container, addFn, opts); },
  isOpen: function () { return !!sp; },
  detectBoxes: detectBoxes
};
})();
