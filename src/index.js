const LIVE_TTL = 12;
const META_TTL = 86400;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    try {
      // Roblox heartbeat
      if (
        request.method === "POST" &&
        url.pathname === "/api/heartbeat"
      ) {
        return await heartbeat(request, env);
      }

      // 게임 목록
      if (
        request.method === "GET" &&
        url.pathname === "/api/games"
      ) {
        return await getGames(env);
      }

      // /
      // public/index.html은 Assets가 처리하도록 넘김
      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        return env.ASSETS.fetch(request);
      }

      return json(
        {
          error: "Not Found"
        },
        404
      );

    } catch (error) {
      console.error(error);

      return json(
        {
          error: "Internal Server Error"
        },
        500
      );
    }
  }
};


/*
 * POST /api/heartbeat
 */
async function heartbeat(request, env) {
  const body = await request.json();

  const placeId = Number(body.placeId);
  const players = Number(body.players);

  if (
    !Number.isInteger(placeId) ||
    placeId <= 0
  ) {
    return json(
      {
        error: "Invalid placeId"
      },
      400
    );
  }

  if (
    !Number.isInteger(players) ||
    players < 0
  ) {
    return json(
      {
        error: "Invalid players"
      },
      400
    );
  }

  const metaKey =
    `game_meta:${placeId}`;

  const liveKey =
    `game_live:${placeId}`;

  /*
   * 게임 메타데이터 캐시 확인
   */
  let meta =
    await env.MONITOR_KV.get(
      metaKey,
      "json"
    );

  /*
   * 최초 발견된 게임이면
   * Roblox API 조회
   */
  if (!meta) {
    meta =
      await fetchGameMetadata(placeId);

    if (!meta) {
      return json(
        {
          error:
            "Unable to fetch Roblox game metadata"
        },
        502
      );
    }

    await env.MONITOR_KV.put(
      metaKey,
      JSON.stringify(meta),
      {
        expirationTtl: META_TTL
      }
    );
  }

  /*
   * 실시간 상태 저장
   * heartbeat가 들어올 때마다
   * TTL 12초가 다시 시작됨
   */
  const live = {
    placeId,
    players,
    lastSeen: Date.now()
  };

  await env.MONITOR_KV.put(
    liveKey,
    JSON.stringify(live),
    {
      expirationTtl: LIVE_TTL
    }
  );

  return json({
    success: true,
    placeId,
    players
  });
}


/*
 * GET /api/games
 */
async function getGames(env) {
  const result =
    await env.MONITOR_KV.list({
      prefix: "game_live:"
    });

  const games = [];

  for (const key of result.keys) {

    const placeId =
      key.name.substring(
        "game_live:".length
      );

    const live =
      await env.MONITOR_KV.get(
        key.name,
        "json"
      );

    if (!live) {
      continue;
    }

    const meta =
      await env.MONITOR_KV.get(
        `game_meta:${placeId}`,
        "json"
      );

    if (!meta) {
      continue;
    }

    games.push({
      placeId: Number(placeId),
      name: meta.name,
      icon: meta.icon,
      players: live.players,
      lastSeen: live.lastSeen
    });
  }

  return json({
    games
  });
}


/*
 * Roblox API
 */
async function fetchGameMetadata(placeId) {

  const detailsUrl =
    `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`;

  const response =
    await fetch(detailsUrl, {
      headers: {
        "User-Agent":
          "RobloxServerMonitor/1.0"
      }
    });

  if (!response.ok) {
    console.error(
      "Roblox API error:",
      response.status
    );

    return null;
  }

  const data =
    await response.json();

  if (
    !Array.isArray(data) ||
    !data[0]
  ) {
    return null;
  }

  const game = data[0];

  let icon = null;

  if (game.universeId) {

    const iconUrl =
      `https://thumbnails.roblox.com/v1/games/icons?` +
      `universeIds=${game.universeId}` +
      `&returnPolicy=PlaceHolder` +
      `&size=512x512` +
      `&format=Png` +
      `&isCircular=false`;

    const iconResponse =
      await fetch(iconUrl);

    if (iconResponse.ok) {

      const iconData =
        await iconResponse.json();

      if (
        iconData.data &&
        iconData.data.length > 0
      ) {
        icon =
          iconData.data[0].imageUrl;
      }
    }
  }

  return {
    name:
      game.name ?? "Unknown",
    icon,
    universeId:
      game.universeId ?? null
  };
}


/*
 * JSON Response
 */
function json(data, status = 200) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        ...corsHeaders(),

        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}


/*
 * CORS
 */
function corsHeaders() {

  return {
    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"
  };
}
