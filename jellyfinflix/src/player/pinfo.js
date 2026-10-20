// PlaybackInfo request body + a short, token-free summary of request and answer for the log.
// Kept free of DOM/app imports so it can be tested with plain node (test/offline-pinfo.mjs).
import { deviceProfile } from './profile.js';

// Jellyfin (10.10) only uses AudioStreamIndex / SubtitleStreamIndex when the body also names the MediaSourceId
// (MediaInfoHelper.SetDeviceSpecificData). Without it the server silently picks its own default tracks, which is
// why a chosen picture subtitle was never burned in (JTV-11). So any track choice must carry the media source id.
export function playbackInfoBody(userId, o) {
  o = o || {};
  const body = {
    UserId: userId, DeviceProfile: deviceProfile({ maxBitrate: o.maxBitrate, burnIn: o.burn }), MaxStreamingBitrate: o.maxBitrate || 120000000, StartTimeTicks: o.startTicks || 0,
    IsPlayback: true, AutoOpenLiveStream: true, EnableDirectPlay: !o.noDirect, EnableDirectStream: !o.noDirect, EnableTranscoding: true,
    AllowVideoStreamCopy: true, AllowAudioStreamCopy: true,
  };
  if (o.audio != null) body.AudioStreamIndex = o.audio;
  if (o.sub != null) body.SubtitleStreamIndex = o.sub;
  if (o.mediaSourceId) body.MediaSourceId = o.mediaSourceId;
  return body;
}

const URL_KEYS = ['SubtitleMethod', 'SubtitleStreamIndex', 'AudioStreamIndex', 'VideoCodec', 'AudioCodec', 'TranscodeReasons'];

// Key query parameters of a TranscodingUrl (never the token).
export function urlParams(u) {
  const out = {};
  const q = String(u || '').split('?')[1] || '';
  for (const part of q.split('&')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i);
    if (URL_KEYS.indexOf(k) >= 0) { try { out[k] = decodeURIComponent(part.slice(i + 1)); } catch (e) { out[k] = part.slice(i + 1); } }
  }
  return out;
}

export function summarizeRequest(body) {
  const sp = (body.DeviceProfile && body.DeviceProfile.SubtitleProfiles) || [];
  const pic = sp.find((p) => p.Format === 'dvdsub' || p.Format === 'pgssub');
  return {
    burnIn: !!(pic && pic.Method === 'Encode'), sub: body.SubtitleStreamIndex, audio: body.AudioStreamIndex, msid: !!body.MediaSourceId,
    directPlay: body.EnableDirectPlay, directStream: body.EnableDirectStream, videoCopy: body.AllowVideoStreamCopy,
    start_s: Math.round((body.StartTimeTicks || 0) / 1e7), maxBitrate: body.MaxStreamingBitrate,
  };
}

export function summarizeResponse(info) {
  const ms = ((info && info.MediaSources) || [])[0] || {};
  const s = { playSession: info && info.PlaySessionId, supportsDirectPlay: !!ms.SupportsDirectPlay, supportsDirectStream: !!ms.SupportsDirectStream, transcode: !!ms.TranscodingUrl };
  if (ms.TranscodingUrl) s.url = urlParams(ms.TranscodingUrl);
  return s;
}

// Problems worth a warning: the server did not do what we asked for.
export function checkAnswer(body, info) {
  const req = summarizeRequest(body);
  const res = summarizeResponse(info);
  const issues = [];
  if ((req.sub != null || req.audio != null) && !req.msid) issues.push('track choice sent without MediaSourceId (server ignores it)');
  if (req.burnIn && req.sub != null && req.sub >= 0) {
    if (!res.transcode) issues.push('burn-in asked but the server offered no transcode');
    else if (String(res.url.SubtitleStreamIndex) !== String(req.sub) || res.url.SubtitleMethod !== 'Encode') issues.push('burn-in asked but the transcode does not burn subtitle ' + req.sub);
  }
  return issues;
}
