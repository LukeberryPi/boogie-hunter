import { readFileSync, writeFileSync, mkdirSync } from "fs";

interface Song {
  title: string | null;
  artist: string | null;
  spotifyUrl: string | null;
  thumbnailUrl: string | null;
  youtubeUrl: string;
  source: string;
}

interface Playlist {
  title: string | null;
  url: string;
  thumbnailUrl: string | null;
  source: string;
}

interface OEmbed {
  title?: string;
  thumbnail_url?: string;
}

interface Output {
  songs: Song[];
  playlists: Playlist[];
}

// \p{Cf} = Unicode "Format" category: zero-width, directional embeddings, etc.
// WhatsApp wraps phone numbers in U+202A/202C which broke the "added +" filter.
const ZERO_WIDTH = /\p{Cf}/gu;
const MSG_START = /^\[(\d{2}\/\d{2}\/\d{2}, \d{2}:\d{2}:\d{2})\] ([^:]+): ([\s\S]*)/;

const SYSTEM_NOISE = [
  /joined using a group link/,
  /created this group/,
  /Messages and calls are end-to-end encrypted/,
  /image omitted/,
  /video omitted/,
  /added \+\d/,
  /Your security code with/,
  /changed the subject/,
  /changed this group/,
  /^\+\d[\d\s]{6,}/, // message sender IS a phone number
];

const LINE_NOISE = [
  /^[^\w\sÀ-ɏ]*$/, // only emoji/punctuation
  /^(yes+|no+|ayy+|hell\s*ye[ah]+|hell\s*yeh|awesome|nice|wow|lol|haha|omg|agreed|yep|nope|literally|perfect|hell\s*yes|of\s*course|definitely)[\s!.?]*$/i,
  /degrees (aswell|as well)/i,
  /played it last time/i,
  /will save it for after/i,
  /^a girl requested/i,
  /do you guys rate/i,
  /i have recruited/i,
  /who will boogie to anything/i,
  /^got a playlist with/i,
  /^reckon i would shed/i,
  /was a fave of the night/i,
  /immediate shazam/i,
  /posted a story with it/i,
  /^it wasn't!!/i,
  /couldn't ID it for/i,
  /^absolute favou?rite/i,
  /mine and my best/i,
  /will absolutely lose it/i,
  /please play some/i,
  /^my first request/i,
  /^@\S/,
  /^‎$/,
  /^[☀️🔥🫶🏻❤️💖🇧🇷🪩🌟☎️✅🫶]+$/u,
  /^\d{1,2}\s+degrees/i,
  /^20\s+degrees/i,
  /\+\d[\d\s]{6,}/, // phone number anywhere in line
];

function isNoise(line: string): boolean {
  const s = line.trim();
  if (!s || s.length < 2) return true;
  if (!/[a-zA-Z0-9À-ɏ]/.test(s)) return true;
  return LINE_NOISE.some((p) => p.test(s));
}

function makeYouTubeUrl(title: string | null, artist: string | null): string {
  const query = [title, artist].filter(Boolean).join(" ");
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query).replace(/%20/g, "+")}`;
}

async function fetchSpotifyOEmbed(url: string): Promise<OEmbed | null> {
  try {
    const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
    const res = await fetch(oembedUrl);
    if (!res.ok) return null;
    return (await res.json()) as OEmbed;
  } catch (e) {
    console.error(`  ✗ oEmbed failed: ${url} — ${e}`);
    return null;
  }
}

async function fetchOgTitle(url: string): Promise<{ title: string | null; thumbnail: string | null }> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
    const html = await res.text();
    const m =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const imgM =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const raw = m ? m[1] : html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? null;
    const title = raw
      ? raw
          .replace(/\s*\|\s*SoundCloud\s*$/i, "")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&#x27;/g, "'")
          .trim()
      : null;
    return { title, thumbnail: imgM?.[1] ?? null };
  } catch (e) {
    console.error(`  ✗ Failed: ${url} — ${e}`);
    return { title: null, thumbnail: null };
  }
}

// ── Parse chat ────────────────────────────────────────────────────────────────

const raw = readFileSync("_chat.txt", "utf-8");
const rawLines = raw.split("\n");

type Message = { content: string };
const messages: Message[] = [];
let current: Message | null = null;

for (const line of rawLines) {
  const m = line.match(MSG_START);
  if (m) {
    if (current) messages.push(current);
    current = { content: m[3] };
  } else if (current) {
    current.content += "\n" + line;
  }
}
if (current) messages.push(current);

const songs: Song[] = [];
const playlists: Playlist[] = [];

type UrlJob = { url: string; isPlaylist: boolean };
const urlJobs: UrlJob[] = [];
const seenUrls = new Set<string>();

function queueUrl(url: string, isPlaylist: boolean) {
  const clean = url.replace(/[^\w:/?.=&%#~@!$'()*+,;=-]/g, "");
  if (!seenUrls.has(clean)) {
    seenUrls.add(clean);
    urlJobs.push({ url: clean, isPlaylist });
  }
}

for (const msg of messages) {
  const content = msg.content.replace(ZERO_WIDTH, "").replace(/<This message was edited>/g, "");

  if (SYSTEM_NOISE.some((p) => p.test(content))) continue;

  const urlMatches = content.match(/https?:\/\/[^\s]+/g) ?? [];
  const textOnly = content.replace(/https?:\/\/[^\s]+/g, "").trim();

  for (const url of urlMatches) {
    if (url.includes("open.spotify.com/track")) {
      queueUrl(url, false);
    } else if (url.includes("open.spotify.com/playlist")) {
      queueUrl(url, true);
    } else if (url.includes("open.spotify.com/album")) {
      // skip
    } else if (url.startsWith("http")) {
      queueUrl(url, false);
    }
  }

  for (const rawLine of textOnly.split("\n")) {
    const line = rawLine
      .replace(ZERO_WIDTH, "")
      .replace(/^[\s\-•*⁠]+/, "")
      .replace(/⁣/g, "")
      .trim();

    if (isNoise(line)) continue;

    const sepMatch = line.match(/^(.*?)\s*-\s*(.+)$/);
    if (sepMatch) {
      const part1 = sepMatch[1].trim();
      const part2 = sepMatch[2].trim();
      if (part1 && part2) {
        songs.push({
          title: part1,
          artist: part2,
          spotifyUrl: null,
          thumbnailUrl: null,
          youtubeUrl: makeYouTubeUrl(part1, part2),
          source: rawLine.trim(),
        });
        continue;
      }
    }

    if (line.length >= 3) {
      songs.push({
        title: line,
        artist: null,
        spotifyUrl: null,
        thumbnailUrl: null,
        youtubeUrl: makeYouTubeUrl(line, null),
        source: rawLine.trim(),
      });
    }
  }
}

// ── Fetch URLs ────────────────────────────────────────────────────────────────

console.log(`\nFetching ${urlJobs.length} URLs...\n`);

for (const job of urlJobs) {
  console.log(`→ ${job.url}`);

  const isSpotify = job.url.includes("spotify.com");
  let resolvedTitle: string | null = null;
  let thumbnail: string | null = null;

  if (isSpotify) {
    const oembed = await fetchSpotifyOEmbed(job.url);
    resolvedTitle = oembed?.title ?? null;
    thumbnail = oembed?.thumbnail_url ?? null;
  } else {
    const result = await fetchOgTitle(job.url);
    resolvedTitle = result.title;
    thumbnail = result.thumbnail;
  }

  console.log(`  "${resolvedTitle ?? "(no title)"}"\n`);

  if (job.isPlaylist) {
    playlists.push({ title: resolvedTitle, url: job.url, thumbnailUrl: thumbnail, source: job.url });
  } else {
    let title: string | null = null;
    let artist: string | null = null;
    if (resolvedTitle) {
      const dash = resolvedTitle.indexOf(" - ");
      if (dash !== -1) {
        title = resolvedTitle.slice(0, dash).trim();
        artist = resolvedTitle.slice(dash + 3).trim();
      } else {
        title = resolvedTitle;
      }
    }
    songs.push({
      title,
      artist,
      spotifyUrl: isSpotify ? job.url : null,
      thumbnailUrl: thumbnail,
      youtubeUrl: makeYouTubeUrl(title, artist),
      source: job.url,
    });
  }
}

// ── Deduplicate ───────────────────────────────────────────────────────────────

const seen = new Set<string>();
const deduped = songs.filter((s) => {
  const key = `${(s.title ?? "").toLowerCase().trim()}|${(s.artist ?? "").toLowerCase().trim()}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const output: Output = { songs: deduped, playlists };

mkdirSync("src/data", { recursive: true });
writeFileSync("src/data/songs.json", JSON.stringify(output, null, 2));
console.log(`✓ ${deduped.length} songs + ${playlists.length} playlists → src/data/songs.json`);
