// What this Samsung TV (Tizen 6, 2021) can play itself. Jellyfin uses this to choose direct play vs transcode.
export const AUDIO_OK = ['aac', 'mp3', 'ac3', 'eac3', 'mp2', 'opus', 'vorbis', 'flac', 'alac', 'pcm_s16le', 'pcm_s24le'];
const VIDEO_OK = 'h264,hevc,vp9,av1,mpeg2video,mpeg4,vc1';

export function deviceProfile(o) {
  o = o || {};
  return {
    Name: 'JellyfinFlix Tizen',
    MaxStreamingBitrate: o.maxBitrate || 120000000,
    MaxStaticBitrate: 200000000,
    MusicStreamingTranscodingBitrate: 384000,
    DirectPlayProfiles: [
      { Container: 'mp4,m4v,mkv,mov,webm,ts,mpegts,m2ts,avi', Type: 'Video', VideoCodec: VIDEO_OK, AudioCodec: AUDIO_OK.join(',') },
      { Container: 'mp3,aac,m4a,flac,ogg,wav', Type: 'Audio' },
    ],
    TranscodingProfiles: [
      { Container: 'ts', Type: 'Video', VideoCodec: 'h264,hevc', AudioCodec: 'aac,ac3,eac3', Context: 'Streaming', Protocol: 'hls', MaxAudioChannels: '6', MinSegments: '1', BreakOnNonKeyFrames: true },
      { Container: 'aac', Type: 'Audio', AudioCodec: 'aac', Context: 'Streaming', Protocol: 'http', MaxAudioChannels: '2' },
    ],
    ContainerProfiles: [],
    CodecProfiles: [
      { Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '52', IsRequired: false }] },
    ],
    // Text subtitles are drawn by JellyfinFlix; picture subtitles (PGS/VobSub) are burned in by the server only when chosen.
    SubtitleProfiles: ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text', 'sub', 'smi'].map((f) => ({ Format: f, Method: 'External' }))
      .concat(['pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub'].map((f) => ({ Format: f, Method: o.burnIn ? 'Encode' : 'Embed' }))),
    ResponseProfiles: [],
  };
}
