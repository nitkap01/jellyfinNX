// Count composited layers on the TV page (how much the GPU/compositor has to juggle).
//   node test/tv-layers.mjs <ws>
const [, , ws] = process.argv;
const sock = new WebSocket(ws);
let id = 0;
const send = (m, p) => sock.send(JSON.stringify({ id: ++id, method: m, params: p || {} }));
sock.onopen = () => { send('DOM.enable'); send('LayerTree.enable'); };
let done = false;
sock.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method !== 'LayerTree.layerTreeDidChange' || !m.params.layers || done) return;
  done = true;
  const L = m.params.layers;
  const draws = L.filter((l) => l.drawsContent);
  let area = 0;
  for (const l of draws) area += l.width * l.height;
  console.log('layers', L.length, 'drawing', draws.length, 'area Mpx', (area / 1e6).toFixed(1));
  console.log(draws.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 15).map((l) => l.width + 'x' + l.height + ' node ' + (l.backendNodeId || '')).join('\n'));
  process.exit(0);
};
setTimeout(() => { console.log('no layer event (move focus while this runs)'); process.exit(1); }, 15000);
