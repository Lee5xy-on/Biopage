const LIVE_TTL = 12;
const META_TTL = 86400;

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
            /*
             * Roblox 서버 → Heartbeat
             */
            if (
                request.method === "POST" &&
                url.pathname === "/api/heartbeat"
            ) {
                return await heartbeat(request, env);
            }

            /*
             * Frontend → 현재 활성 게임 목록
             */
            if (
                request.method === "GET" &&
                url.pathname === "/api/games"
            ) {
                return await getGames(env);
            }

            /*
             * Worker 상태 확인
             */
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
            console.error(
                "[Worker Error]",
                error
            );

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
 *
 * Roblox 서버에서:
 *
 * {
 *     "placeId": 123456789
 * }
 *
 * 만 전송합니다.
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

    const metaKey =
        `game_meta:${placeId}`;

    const liveKey =
        `game_live:${placeId}`;

    /*
     * --------------------------------------------------------
     * 1. 게임 메타데이터 캐시 확인
     * --------------------------------------------------------
     */

    let meta =
        await env.MONITOR_KV.get(
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

        meta =
            await fetchGameMetadata(
                placeId
            );

        if (!meta) {
            return json(
                {
                    error:
                        "Unable to fetch Roblox game metadata"
                },
                502
            );
        }

        /*
         * 이름 / 아이콘 / Universe ID 저장
         *
         * 24시간 캐시
         */
        await env.MONITOR_KV.put(
            metaKey,
            JSON.stringify(meta),
            {
                expirationTtl: META_TTL
            }
        );
    }

    /*
     * Universe ID가 없는 경우
     */
    if (!meta.universeId) {
        return json(
            {
                error:
                    "Universe ID not found"
            },
            502
        );
    }

    /*
     * --------------------------------------------------------
     * 3. Roblox API에서 전체 게임 동접자 조회
     * --------------------------------------------------------
     */

    const players =
        await fetchPlayerCount(
            meta.universeId
        );

    if (players === null) {
        return json(
            {
                error:
                    "Unable to fetch Roblox player count"
            },
            502
        );
    }

    /*
     * --------------------------------------------------------
     * 4. 실시간 상태 저장
     * --------------------------------------------------------
     *
     * TTL = 12초
     *
     * 다음 heartbeat가 들어오면
     * TTL이 다시 12초로 초기화됩니다.
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
        players: players
    });
}


/*
 * ============================================================
 * GET /api/games
 * ============================================================
 *
 * 현재 살아있는 게임 목록
 */
async function getGames(env) {
    const games = [];

    let cursor = undefined;

    /*
     * KV list pagination
     */
    do {
        const options = {
            prefix: "game_live:",
            limit: 1000
        };

        if (cursor) {
            options.cursor = cursor;
        }

        const result =
            await env.MONITOR_KV.list(
                options
            );

        for (const key of result.keys) {
            const placeId =
                key.name.substring(
                    "game_live:".length
                );

            /*
             * 실시간 데이터
             */
            const live =
                await env.MONITOR_KV.get(
                    key.name,
                    "json"
                );

            if (!live) {
                continue;
            }

            /*
             * 메타데이터
             */
            const meta =
                await env.MONITOR_KV.get(
                    `game_meta:${placeId}`,
                    "json"
                );

            if (!meta) {
                continue;
            }

            games.push({
                placeId:
                    Number(placeId),

                name:
                    meta.name,

                icon:
                    meta.icon,

                players:
                    Number(live.players),

                lastSeen:
                    live.lastSeen
            });
        }

        cursor =
            result.list_complete
                ? undefined
                : result.cursor;

    } while (cursor);

    /*
     * 동접자 수가 높은 게임부터 정렬
     */
    games.sort(
        (a, b) =>
            b.players - a.players
    );

    return json({
        games: games
    });
}


/*
 * ============================================================
 * Roblox Games API
 * ============================================================
 *
 * Place ID
 *      ↓
 * Universe ID
 *      ↓
 * 게임 이름
 */
async function fetchGameMetadata(placeId) {
    const url =
        `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`;

    const response =
        await fetch(url, {
            headers: {
                "User-Agent":
                    "RobloxServerMonitor/1.0"
            }
        });

    if (!response.ok) {
        console.error(
            "[Roblox Metadata]",
            response.status,
            response.statusText
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

    const universeId =
        game.universeId;

    if (!universeId) {
        return null;
    }

    /*
     * --------------------------------------------------------
     * 게임 아이콘
     * --------------------------------------------------------
     */

    let icon = null;

    const iconUrl =
        `https://thumbnails.roblox.com/v1/games/icons` +
        `?universeIds=${universeId}` +
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

        icon:
            icon,

        universeId:
            universeId
    };
}


/*
 * ============================================================
 * Roblox 전체 동접자 조회
 * ============================================================
 *
 * Universe ID를 사용합니다.
 *
 * 반환되는 `playing`은
 * 해당 Universe 전체의 현재 플레이어 수입니다.
 */
async function fetchPlayerCount(universeId) {
    const url =
        `https://games.roblox.com/v1/games?universeIds=${universeId}`;

    const response =
        await fetch(url, {
            headers: {
                "User-Agent":
                    "RobloxServerMonitor/1.0"
            }
        });

    if (!response.ok) {
        console.error(
            "[Roblox Player Count]",
            response.status,
            response.statusText
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
        return null;
    }

    const playing =
        Number(
            data.data[0].playing
        );

    if (!Number.isFinite(playing)) {
        return null;
    }

    return playing;
}


/*
 * ============================================================
 * JSON Response
 * ============================================================
 */
function json(data, status = 200) {
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
        "Access-Control-Allow-Origin":
            "*",

        "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS",

        "Access-Control-Allow-Headers":
            "Content-Type, Authorization"
    };
}
