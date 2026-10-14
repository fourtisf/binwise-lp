// Puts a recorded tour together: intro card, each shot with its captions and a "recorded live" stamp,
// crossfades, end card and the soundtrack, as a 1920×1080, 30 fps H.264 MP4 at social-media loudness.
// usage: node compose.mjs [tourDir=tour] [out=kovra-live.mp4]
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_FROM || '/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');

const here = dirname(new URL(import.meta.url).pathname);
const [, , tourDir = 'tour', outFile = 'kovra-live.mp4'] = process.argv;
const tour = JSON.parse(readFileSync(`${tourDir}/tour.json`, 'utf8'));
const work = resolve(tourDir, '_build');
mkdirSync(work, { recursive: true });
const FPS = 30, XF = 0.5, INTRO = 2.8, OUTRO = 4.2;
const ff = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'inherit' });
const enc = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p', '-r', String(FPS)];
const host = new URL(tour.base).host;
const day = new Date(tour.recordedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// ---------------------------------------------------------------- cards, captions and the stamp
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto('file://' + resolve(here, 'cards.html'));
await page.evaluate(() => document.fonts.ready);
const still = async (file, kind, data, transparent = false) => {
  await page.evaluate(([k, d]) => window.show(k, d), [kind, data]);
  await page.screenshot({ path: `${work}/${file}`, omitBackground: transparent });
};
await still('intro.png', 'intro');
await still('outro.png', 'outro');
await still('stamp.png', 'stamp', { text: `Recorded live on ${host} · ${day}` }, true);
for (const s of tour.scenes)
  for (const [i, c] of s.cues.entries()) await still(`cap-${s.name}-${i}.png`, 'caption', c, true);
await browser.close();

// ---------------------------------------------------------------- each shot: frames → 30 fps, captions on top
const clips = [];
for (const s of tour.scenes) {
  const dir = resolve(tourDir, s.name);
  const fr = s.frames;
  let list = 'ffconcat version 1.0\n';
  fr.forEach((f, i) => {
    // The first frame also covers the moment before it was painted; the last one runs to the end of the shot.
    const end = i + 1 < fr.length ? fr[i + 1].t : s.duration;
    const start = i === 0 ? 0 : f.t;
    list += `file '${dir}/${f.file}'\nduration ${Math.max(0.001, end - start).toFixed(4)}\n`;
  });
  list += `file '${dir}/${fr.at(-1).file}'\n`;
  writeFileSync(`${work}/${s.name}.txt`, list);
  const inputs = ['-f', 'concat', '-safe', '0', '-i', `${work}/${s.name}.txt`, '-loop', '1', '-framerate', String(FPS), '-i', `${work}/stamp.png`];
  let graph = `[0:v]fps=${FPS},scale=1920:1080:flags=lanczos,setsar=1,format=rgba[b0];[1:v]format=rgba[st];[b0][st]overlay=0:0[v0]`;
  let last = 'v0';
  s.cues.forEach((c, i) => {
    const a = Math.max(0.35, c.at + 0.15);
    const e = (i + 1 < s.cues.length ? s.cues[i + 1].at : s.duration) - 0.2;
    inputs.push('-loop', '1', '-framerate', String(FPS), '-i', `${work}/cap-${s.name}-${i}.png`);
    graph += `;[${i + 2}:v]format=rgba,fade=t=in:st=${a.toFixed(2)}:d=0.35:alpha=1,fade=t=out:st=${(e - 0.35).toFixed(2)}:d=0.35:alpha=1[c${i}]`;
    graph += `;[${last}][c${i}]overlay=0:0:enable='between(t,${a.toFixed(2)},${e.toFixed(2)})'[v${i + 1}]`;
    last = `v${i + 1}`;
  });
  graph += `;[${last}]format=yuv420p[out]`;
  ff([...inputs, '-filter_complex', graph, '-map', '[out]', '-t', s.duration.toFixed(3), ...enc, `${work}/${s.name}.mp4`]);
  clips.push({ file: `${work}/${s.name}.mp4`, d: s.duration });
}

// ---------------------------------------------------------------- the cards: a slow push in
const card = (name, d, fades) => {
  const n = Math.round(d * FPS);
  ff([
    '-loop', '1', '-framerate', String(FPS), '-t', String(d), '-i', `${work}/${name}.png`,
    '-vf', `scale=3840:2160,zoompan=z='1+0.04*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=${FPS},${fades},format=yuv420p`,
    '-t', String(d), ...enc, `${work}/${name}.mp4`,
  ]);
};
card('intro', INTRO, 'fade=t=in:st=0:d=0.45');
card('outro', OUTRO, `fade=t=out:st=${OUTRO - 0.9}:d=0.9`);
const all = [{ file: `${work}/intro.mp4`, d: INTRO }, ...clips, { file: `${work}/outro.mp4`, d: OUTRO }];

// ---------------------------------------------------------------- crossfade everything into one silent cut
let graph = '', prev = '0:v', at = 0;
const starts = [0];
for (let i = 1; i < all.length; i++) {
  at += all[i - 1].d - XF;
  starts.push(at);
  graph += `${graph ? ';' : ''}[${prev}][${i}:v]xfade=transition=fade:duration=${XF}:offset=${at.toFixed(3)}[x${i}]`;
  prev = `x${i}`;
}
const total = at + all.at(-1).d;
ff([...all.flatMap((c) => ['-i', c.file]), '-filter_complex', graph, '-map', `[${prev}]`, ...enc, `${work}/silent.mp4`]);

// ---------------------------------------------------------------- music on the cuts, then mux
writeFileSync(`${work}/cues.json`, JSON.stringify({ total, cuts: starts.slice(1, -1).map((t) => t + XF / 2), outro: starts.at(-1) + XF / 2 }));
execFileSync('python3', [resolve(here, 'music_live.py'), `${work}/cues.json`, `${work}/music.wav`], { stdio: 'inherit' });
ff([
  '-i', `${work}/silent.mp4`, '-i', `${work}/music.wav`, '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
  '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', outFile,
]);
console.log(`${outFile}: ${total.toFixed(1)}s, ${all.length} clips`);
