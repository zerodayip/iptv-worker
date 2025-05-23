const M3U_URL = "https://raw.githubusercontent.com/zerodayip/Py/refs/heads/main/m3u8/playlist2.m3u";
const USERS_URL = "https://raw.githubusercontent.com/zerodayip/denemeler/refs/heads/main/users.json";

function m3uToJsonAndCategories(text) {
  const lines = text.split(/\r?\n/);
  const streams = [];
  const categoriesMap = {};
  let catCounter = 1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXTINF")) {
      const name = lines[i].split(",").pop().trim();
      const groupMatch = lines[i].match(/group-title="([^"]*)"/);
      const categoryName = groupMatch ? groupMatch[1] : "Others";
      if (!categoriesMap[categoryName]) categoriesMap[categoryName] = catCounter++;

      const logoMatch = lines[i].match(/tvg-logo="([^"]*)"/);
      const icon = logoMatch ? logoMatch[1] : "";

      const vlcOpts = [];
      let j = i + 1;
      while (lines[j] && lines[j].startsWith("#EXTVLCOPT:")) {
        vlcOpts.push(lines[j]);
        j++;
      }

      const url = lines[j] || "";

      streams.push({
        num: streams.length + 1,
        name,
        stream_type: "live",
        stream_id: streams.length + 100,
        stream_icon: icon,
        category_id: String(categoriesMap[categoryName]),
        tv_archive: "0",
        direct_source: url.trim(),
        stream_url: url.trim(),
        vlc_opts: vlcOpts,
        container_extension: "m3u8"
      });

      i = j;
    }
  }

  const categories = Object.entries(categoriesMap).map(([name, id]) => ({
    category_id: String(id),
    category_name: name,
    parent_id: 0
  }));

  return { streams, categories };
}

async function auth(username, password, env) {
  const ghHeader = { Authorization: `Bearer ${env.GH_TOKEN}` };
  const usersResp = await fetch(USERS_URL, { headers: ghHeader });
  if (!usersResp.ok) throw new Error("User list error");
  const users = await usersResp.json();
  const user = Object.values(users).find(u => u.username === username && u.password === password);
  if (!user) return { ok: false, code: 403 };
  if (Date.now() > Date.parse(user.expire_date)) return { ok: false, code: 402, exp: user.expire_date };
  return { ok: true, exp: user.expire_date };
}

export default {
  async fetch(request, env) {
    try {
      const { pathname, searchParams, hostname } = new URL(request.url);
      const host = hostname;

      if (pathname === "/get.php") {
        const username = searchParams.get("username");
        const password = searchParams.get("password");
        const type = (searchParams.get("type") || "m3u").toLowerCase();
        if (!username || !password || !/^m3u(_plus)?$/.test(type))
          return new Response("Missing or wrong parameters", { status: 400 });

        const authRes = await auth(username, password, env);
        if (!authRes.ok) {
          if (authRes.code === 402)
            return new Response("#EXTM3U\n#EXTINF:-1,Abonelik süre doldu\n", {
              headers: { "Content-Type": "text/plain; charset=utf-8" }
            });
          return new Response("Invalid login", { status: authRes.code });
        }

        const ghHeader = { Authorization: `Bearer ${env.GH_TOKEN}` };
        const m3uResp = await fetch(M3U_URL, { headers: ghHeader });
        if (!m3uResp.ok) return new Response("Upstream error", { status: 502 });

        return new Response(await m3uResp.text(), {
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }

      if (pathname === "/player_api.php") {
        const username = searchParams.get("username");
        const password = searchParams.get("password");
        const action = (searchParams.get("action") || "").toLowerCase();

        if (!username || !password) return new Response("[]", { status: 400 });
        const authRes = await auth(username, password, env);
        if (!authRes.ok) return new Response("[]", { status: authRes.code });

        const ghHeader = { Authorization: `Bearer ${env.GH_TOKEN}` };
        const m3uResp = await fetch(M3U_URL, { headers: ghHeader });
        if (!m3uResp.ok) return new Response("[]", { status: 502 });
        const text = await m3uResp.text();

        const { streams, categories } = m3uToJsonAndCategories(text);

        if (!action) {
          const expTS = Math.floor(Date.parse(authRes.exp) / 1000);
          const nowTS = Math.floor(Date.now() / 1000);
          const payload = {
            user_info: {
              username,
              password,
              status: "Active",
              exp_date: String(expTS),
              is_trial: "0",
              active_cons: 0,
              max_connections: 1
            },
            server_info: {
              url: host,
              port: 80,
              https_port: 443,
              server_protocol: "http",
              rtmp_port: 8080,
              timestamp_now: nowTS,
              timezone: "Europe/Istanbul"
            }
          };
          return new Response(JSON.stringify(payload), {
            headers: { "Content-Type": "application/json" }
          });
        }

        if (action === "get_live_categories") {
          return new Response(JSON.stringify(categories), {
            headers: { "Content-Type": "application/json" }
          });
        }

        if (action === "get_live_streams") {
          const updatedStreams = streams.map(stream => {
            const streamUrl = `https://${host}/player_api.php?username=${username}&password=${password}&action=stream&stream_id=${stream.stream_id}.m3u8`;
            return {
              ...stream,
              direct_source: streamUrl,
              stream_url: streamUrl
            };
          });

          return new Response(JSON.stringify(updatedStreams), {
            headers: { "Content-Type": "application/json" }
          });
        }

        if (action === "stream") {
          const streamId = parseInt(searchParams.get("stream_id"));
          if (isNaN(streamId)) return new Response("Missing stream_id", { status: 400 });

          const stream = streams.find(s => s.stream_id === streamId);
          if (!stream) return new Response("Not Found", { status: 404 });

          const playlistResp = await fetch(stream.direct_source);
          if (!playlistResp.ok) return new Response("Playlist resolve error", { status: 502 });
          let playlistText = await playlistResp.text();

          playlistText = playlistText.replace(/(\/proxy\/ts\?[^ \n\r]*)/g, "https://zeroipday-zeroipday.hf.space$1");

          return new Response(playlistText, {
            headers: { "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8" }
          });
        }

        return new Response("[]", { headers: { "Content-Type": "application/json" } });
      }

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      return new Response("Internal error: " + e.message, { status: 500 });
    }
  }
};
