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
      if (request.method === "POST" && url.pathname === "/heartbeat") {
        return await heartbeat(request, env);
      }

      if (request.method === "GET" && url.pathname === "/games") {
        return await getGames(env);
      }

      if (url.pathname === "/") {
        return json({
          service: "Roblox Server Monitor",
          status: "ok"
        });
      }

      return json(
        { error: "Not Found" },
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
 * POST /heartbeat
 *
 * Body:
 * {
 *   "placeId": 123456789,
 *   "players": 42
 * }
 */
async function heartbeat(request, env) {
  const body = await request.json();

  const placeId = Number(body.placeId);
  const players = Number(body.players);

  if (!Number.isInteger(placeId) || placeId <= 0) {
    return json(
      { error: "Invalid placeId" },
      400
    );
  }

  if (!Number.isInteger(players) || players < 0) {
    return json(
      { error: "Invalid players" },
      400
    );
  }

  const metaKey = `game_meta:${placeId}`;
  const liveKey = `game_live:${placeId}`;

  /*
   * 1. 메타데이터 확인
   *
   * 이미 존재한다면 Roblox API를 호출하지 않습니다.
   */
  let meta = await env.MONITOR_KV.get(
    metaKey,
    "json"
  );

  /*
   * 2. 최초 발견된 Place ID라면
   *    Roblox API에서 게임 이름을 가져옵니다.
   */
  if (!meta) {
    meta = await fetchGameMetadata(placeId);

    if (!meta) {
      return json(
        {
          error: "Unable to fetch Roblox game metadata"
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
   * 3. 실시간 상태 저장
   *
   * heartbeat가 다시 들어올 때마다
   * TTL 12초가 새로 시작됩니다.
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
 * GET /games
 *
 * 현재 살아있는 게임 목록을 반환합니다.
 */
async function getGames(env) {
  const liveKeys = await env.MONITOR_KV.list({
    prefix: "game_live:"
  });

  const games = [];

  for (const key of liveKeys.keys) {
    const placeId = key.name.substring(
      "game_live:".length
    );

    const live = await env.MONITOR_KV.get(
      key.name,
      "json"
    );

    if (!live) {
      continue;
    }

    const meta = await env.MONITOR_KV.get(
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
 * Roblox 게임 메타데이터 조회
 */
async function fetchGameMetadata(placeId) {
  /*
   * Place 상세 정보
   */
  const detailsUrl =
    `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`;

  const detailsResponse = await fetch(
    detailsUrl,
    {
      headers: {
        "User-Agent": "RobloxServerMonitor/1.0"
      }
    }
  );

  if (!detailsResponse.ok) {
    console.error(
      "Roblox details API:",
      detailsResponse.status
    );

    return null;
  }

  const details = await detailsResponse.json();

  if (!Array.isArray(details) || !details[0]) {
    return null;
  }

  const game = details[0];

  /*
   * Place ID → Universe ID
   */
  const universeId = game.universeId;

  let icon = null;

  /*
   * Universe ID가 있으면 게임 아이콘 조회
   */
  if (universeId) {
    const iconUrl =
      `https://thumbnails.roblox.com/v1/games/icons?` +
      `universeIds=${universeId}` +
      `&returnPolicy=PlaceHolder` +
      `&size=512x512` +
      `&format=Png` +
      `&isCircular=false`;

    const iconResponse = await fetch(iconUrl);

    if (iconResponse.ok) {
      const iconData = await iconResponse.json();

      if (
        iconData.data &&
        iconData.data.length > 0
      ) {
        icon =
          iconData.data[0].imageUrl ?? null;
      }
    }
  }

  return {
    name: game.name ?? "Unknown",
    icon,
    universeId: universeId ?? null
  };
}


/*
 * JSON response helper
 */
function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/json; charset=utf-8"
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
