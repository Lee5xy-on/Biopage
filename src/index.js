const LIVE_TTL = 60;
const LIVE_TIMEOUT = 12_000;
const META_TTL = 86_400;

const ROBLOX_API_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json"
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // CORS Preflight
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders()
            });
        }

        try {
            // Roblox 서버 → Heartbeat
            if (
                request.method === "POST" &&
                url.pathname === "/api/heartbeat"
            ) {
                return await heartbeat(request, env);
            }

            // Frontend → 현재 활성 게임 목록
            if (
                request.method === "GET" &&
                url.pathname === "/api/games"
            ) {
                return await getGames(env);
            }

            // Worker 상태 확인
            if (
                request.method === "GET" &&
                url.pathname === "/"
            ) {
                return json({
                    service: "Roblox Server Monitor",
                    status: "ok"
                });
            }

            return json(
                {
                    error: "Not Found"
                },
                404
            );
        } catch (error) {
            console.error("[Worker Error]", error);

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
 * ============================================================
 * POST /api/heartbeat
 * ============================================================
 */

async function heartbeat(request, env) {
    let body;

    try {
        body = await request.json();
    } catch {
        return json(
            {
                error: "Invalid JSON"
            },
            400
        );
    }

    const placeId = Number(body.placeId);

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

    const metaKey = `game_meta:${placeId}`;
    const liveKey = `game_live:${placeId}`;

    /*
     * --------------------------------------------------------
     * 1. 게임 메타데이터 캐시 확인
     * --------------------------------------------------------
     */

    let meta = await env.MONITOR_KV.get(
        metaKey,
        "json"
    );

    /*
     * --------------------------------------------------------
     * 2. 최초 발견된 Place ID
     * --------------------------------------------------------
     */

    if (!meta) {
        console.log(
            `[Metadata] New Place ID: ${placeId}`
        );

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
     * Universe ID 확인
     */

    if (!meta.universeId) {
        return json(
            {
                error: "Universe ID not found"
            },
            502
        );
    }

    /*
     * --------------------------------------------------------
     * 3. Roblox 전체 동접자 조회
     * --------------------------------------------------------
     */

    const players = await fetchPlayerCount(
        meta.universeId
    );

    if (players === null) {
        return json(
            {
                error: "Unable to fetch Roblox player count"
            },
            502
        );
    }

    /*
     * --------------------------------------------------------
     * 4. 실시간 상태 저장
     *
     * KV TTL은 최소 60초이므로
     * 실제 활성 여부는 lastSeen으로 판단합니다.
     * --------------------------------------------------------
     */

    const live = {
        placeId: placeId,
        players: players,
        lastSeen: Date.now()
    };

    await env.MONITOR_KV.put(
        liveKey,
        JSON.stringify(live),
        {
            expirationTtl: LIVE_TTL
        }
    );

    console.log(
        `[Heartbeat] ${placeId} → ${players} players`
    );

    return json({
        success: true,
        placeId: placeId,
        players: players,
        lastSeen: live.lastSeen
    });
}


/*
 * ============================================================
 * GET /api/games
 * ============================================================
 */

async function getGames(env) {
    const games = [];
    let cursor = undefined;

    do {
        const options = {
            prefix: "game_live:",
            limit: 1000
        };

        if (cursor) {
            options.cursor = cursor;
        }

        const result = await env.MONITOR_KV.list(
            options
        );

        for (const key of result.keys) {
            const placeIdString = key.name.substring(
                "game_live:".length
            );

            const placeId = Number(placeIdString);

            if (
                !Number.isInteger(placeId) ||
                placeId <= 0
            ) {
                continue;
            }

            /*
             * 실시간 데이터
             */

            const live = await env.MONITOR_KV.get(
                key.name,
                "json"
            );

            if (!live) {
                continue;
            }

            /*
             * 12초 이상 heartbeat가 없으면
             * 비활성 서버로 취급
             */

            const lastSeen = Number(
                live.lastSeen
            );

            if (!Number.isFinite(lastSeen)) {
                continue;
            }

            const elapsed =
                Date.now() - lastSeen;

            if (elapsed > LIVE_TIMEOUT) {
                continue;
            }

            /*
             * 메타데이터
             */

            const meta = await env.MONITOR_KV.get(
                `game_meta:${placeId}`,
                "json"
            );

            if (!meta) {
                continue;
            }

            games.push({
                placeId: placeId,
                name: meta.name,
                icon: meta.icon,
                players: Number(live.players) || 0,
                lastSeen: lastSeen
            });
        }

        cursor = result.list_complete
            ? undefined
            : result.cursor;

    } while (cursor);

    /*
     * 동접자 수가 높은 순으로 정렬
     */

    games.sort(
        (a, b) => b.players - a.players
    );

    return json({
        games: games
    });
}


/*
 * ============================================================
 * Roblox Games API
 *
 * Place ID
 * ↓
 * Universe ID
 * ↓
 * 게임 이름 / 아이콘
 * ============================================================
 */

async function fetchGameMetadata(placeId) {
    const url =
        `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`;

    try {
        const response = await fetch(
            url,
            {
                headers: ROBLOX_API_HEADERS
            }
        );

        if (!response.ok) {
            console.error(
                `[Roblox Metadata Fail] Status: ${response.status} ${response.statusText}`
            );

            return null;
        }

        const data = await response.json();

        if (
            !Array.isArray(data) ||
            !data[0]
        ) {
            console.error(
                `[Roblox Metadata Fail] Empty response for placeId: ${placeId}`
            );

            return null;
        }

        const game = data[0];

        const universeId = Number(
            game.universeId
        );

        if (
            !Number.isInteger(universeId) ||
            universeId <= 0
        ) {
            console.error(
                `[Roblox Metadata Fail] Missing universeId for placeId: ${placeId}`
            );

            return null;
        }

        /*
         * 게임 아이콘 조회
         */

        let icon = null;

        const iconUrl =
            `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`;

        const iconResponse = await fetch(
            iconUrl,
            {
                headers: ROBLOX_API_HEADERS
            }
        );

        if (iconResponse.ok) {
            const iconData =
                await iconResponse.json();

            if (
                Array.isArray(iconData.data) &&
                iconData.data.length > 0
            ) {
                icon =
                    iconData.data[0].imageUrl ??
                    null;
            }
        }

        return {
            name:
                game.name ??
                "Unknown Game",

            icon: icon,

            universeId:
                universeId
        };

    } catch (error) {
        console.error(
            "[Roblox Metadata Exception]",
            error
        );

        return null;
    }
}


/*
 * ============================================================
 * Roblox 전체 동접자 조회
 * ============================================================
 */

async function fetchPlayerCount(universeId) {
    const url =
        `https://games.roblox.com/v1/games?universeIds=${universeId}`;

    try {
        const response = await fetch(
            url,
            {
                headers: ROBLOX_API_HEADERS
            }
        );

        if (!response.ok) {
            console.error(
                `[Roblox Player Count Fail] Status: ${response.status} ${response.statusText}`
            );

            return null;
        }

        const data =
            await response.json();

        if (
            !data ||
            !Array.isArray(data.data) ||
            !data.data[0]
        ) {
            console.error(
                `[Roblox Player Count Fail] Empty data for universeId: ${universeId}`
            );

            return null;
        }

        const playing =
            Number(
                data.data[0].playing
            );

        if (
            !Number.isFinite(playing)
        ) {
            return null;
        }

        return playing;

    } catch (error) {
        console.error(
            "[Roblox Player Count Exception]",
            error
        );

        return null;
    }
}


/*
 * ============================================================
 * JSON Response
 * ============================================================
 */

function json(
    data,
    status = 200
) {
    return new Response(
        JSON.stringify(data),
        {
            status: status,

            headers: {
                ...corsHeaders(),

                "Content-Type":
                    "application/json; charset=utf-8"
            }
        }
    );
}


/*
 * ============================================================
 * CORS
 * ============================================================
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
