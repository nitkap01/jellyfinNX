// PlaybackInfo request checks without the TV (JTV-11: picture subtitles were never burned in).
//   node test/offline-pinfo.mjs                       offline: body building + answer checks
//   node test/offline-pinfo.mjs --live <itemId> <subIndex> [audioIndex]
//       also asks the real server for PlaybackInfo (burn-in profile, chosen picture subtitle) and checks the
//       TranscodingUrl burns that subtitle. Only PlaybackInfo is called: no transcode is started.
//       Login from ~/.secrets/jellyfin_admin.txt, read at run time, never printed.
import { readFileSync } from 'node:fs';
import { playbackInfoBody, summarizeRequest, summarizeResponse, checkAnswer, urlParams } from '../src/player/pinfo.js';

let fails = 0;
const ok = (cond, name) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };

// --- offline ---
const b = playbackInfoBody('u1', { burn: true, sub: 3, audio: 1, noDirect: true, mediaSourceId: 'ms1', startTicks: 1690544e4 });
ok(b.MediaSourceId === 'ms1' && b.SubtitleStreamIndex === 3 && b.AudioStreamIndex === 1, 'track choice carries MediaSourceId');
ok(b.EnableDirectPlay === false && b.EnableDirectStream === false, 'noDirect turns off direct play/stream');
const dvd = b.DeviceProfile.SubtitleProfiles.find((p) => p.Format === 'dvdsub');
ok(dvd && dvd.Method === 'Encode', 'burn profile: dvdsub = Encode');
const nb = playbackInfoBody('u1', { sub: -1, mediaSourceId: 'ms1' });
ok(nb.DeviceProfile.SubtitleProfiles.find((p) => p.Format === 'pgssub').Method === 'Embed' && nb.SubtitleStreamIndex === -1, 'subtitles off: Embed profile, index -1');
ok(playbackInfoBody('u1', {}).MediaSourceId === undefined, 'plain first play: no MediaSourceId needed');
const r = summarizeRequest(b);
ok(r.burnIn && r.sub === 3 && r.msid && r.start_s === 1691, 'request summary');

const good = { PlaySessionId: 'p', MediaSources: [{ SupportsDirectPlay: false, TranscodingUrl: '/videos/x/master.m3u8?DeviceId=d&VideoCodec=h264,hevc&SubtitleStreamIndex=3&SubtitleMethod=Encode&api_key=SECRET&TranscodeReasons=SubtitleCodecNotSupported' }] };
const bad = { PlaySessionId: 'p', MediaSources: [{ SupportsDirectPlay: false, TranscodingUrl: '/videos/x/master.m3u8?DeviceId=d&VideoCodec=h264,hevc&AudioStreamIndex=2&api_key=SECRET&TranscodeReasons=DirectPlayError' }] };
ok(checkAnswer(b, good).length === 0, 'burning answer accepted');
ok(checkAnswer(b, bad).length === 1, 'non-burning answer flagged');
ok(checkAnswer(playbackInfoBody('u1', { burn: true, sub: 3 }), good).some((x) => /MediaSourceId/.test(x)), 'missing MediaSourceId flagged');
ok(!JSON.stringify(summarizeResponse(good)).includes('SECRET'), 'summary never contains the token');
ok(urlParams(good.MediaSources[0].TranscodingUrl).VideoCodec === 'h264,hevc', 'url params parsed');

// --- live (PlaybackInfo only) ---
const li = process.argv.indexOf('--live');
if (li > 0) {
  const [itemId, subIdx, audIdx] = process.argv.slice(li + 1);
  const cfg = Object.fromEntries(readFileSync(process.env.HOME + '/.secrets/jellyfin_admin.txt', 'utf8').trim().split('\n').map((l) => [l.split(':')[0].trim().toLowerCase(), l.split(':').slice(1).join(':').trim()]));
  const S = cfg.server.replace(/\/$/, '');
  const A = 'MediaBrowser Client="JellyfinFlix tools", Device="INDIE", DeviceId="indie-jflix-tools", Version="1.0"';
  const call = async (path, body, tok) => {
    const res = await fetch(S + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': A + (tok ? ', Token="' + tok + '"' : '') }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(path + ' HTTP ' + res.status);
    return res.json();
  };
  const auth = await call('/Users/AuthenticateByName', { Username: cfg.user, Pw: cfg.pass });
  const uid = auth.User.Id, tok = auth.AccessToken;
  const o = { burn: true, sub: +subIdx, audio: audIdx != null ? +audIdx : undefined, noDirect: true, mediaSourceId: itemId, startTicks: 0 };
  const body = playbackInfoBody(uid, o);
  const info = await call('/Items/' + itemId + '/PlaybackInfo?UserId=' + uid, body, tok);
  console.log('live answer', JSON.stringify(summarizeResponse(info)));
  ok(checkAnswer(body, info).length === 0, 'live: server burns subtitle ' + subIdx);
  const old = Object.assign({}, body); delete old.MediaSourceId;
  const info2 = await call('/Items/' + itemId + '/PlaybackInfo?UserId=' + uid, old, tok);
  console.log('live answer without MediaSourceId (old app)', JSON.stringify(summarizeResponse(info2)));
}
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
